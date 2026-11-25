'use strict';
// Maintenance / compaction planner for long-term memory.
//
// `planMaintenance` is a *planner*: it reads a list of memory rows and returns a
// plan. It never writes, deletes, merges or mutates anything. The caller decides
// whether to apply the plan (archive rows, rewrite duplicate rows into the
// canonical one) and is expected to show it to the user first.
//
// Purity contract (same as memory-quality.cjs):
//  - No database, no Electron, no network, no randomness.
//  - No implicit clock: "now" is an option. Two calls with the same arguments
//    produce deep-equal output, and the input array/objects are never modified.
//  - Text normalization/hashing is delegated to memory-quality.cjs, so the
//    planner and the rest of the memory stack agree on what "duplicate" means.
//
// Decision order for one memory (first match wins):
//   1. protected  - `pinned === true`, or importance >= HIGH_IMPORTANCE_FLOOR.
//                   Protected rows are never archived, for any reason, and they
//                   stay merge-eligible (they are the best canonical candidate).
//   2. expired    - `expiredAt <= now` -> archive reason 'expired'.
//   3. disabled   - `disabled === true` or `status === 'disabled'`:
//                   with includeDisabled -> archive reason 'disabled';
//                   without it -> left untouched (lands in `keep`).
//                   A disabled row never becomes a merge canonical or duplicate.
//   4. stale      - active, useCount <= maxUseCount (default 0), importance
//                   known and < minImportance, updatedAt known and older than
//                   staleDays -> archive reason 'stale-low-value'.
//   5. otherwise  - merge candidate, else `keep`.
//
// Missing data is never treated as evidence: an unknown importance, useCount or
// updatedAt makes a row ineligible for 'stale-low-value' instead of archiving it
// on a guess. An unknown createdAt sorts after every known one when choosing the
// canonical row.
//
// Scope: two memories only merge when they share the same owner and project
// scope. `ownerId`/`projectId` are read first (camelCase), then `owner_id`/
// `project_id`, so a raw DB row and a mapped object behave the same. A missing
// or empty scope component is a scope of its own (null/'' are equivalent), never
// a wildcard.
//
// Accounting: every input row ends up in exactly one of archive, keep, or the
// duplicateIds of a merge group (a canonical row stays in keep), so
// `stats.total === stats.archive + stats.keep + duplicateIds.length`.

const { normalizeMemoryText, memoryHash } = require('./memory-quality.cjs');

const DAY_MS = 86_400_000;

const DEFAULTS = Object.freeze({
  staleDays: 365,
  minImportance: 0.25,
  maxUseCount: 0,
  includeDisabled: false,
});

// At or above this importance a row is considered too valuable to compact, no
// matter how old or unused it looks.
const HIGH_IMPORTANCE_FLOOR = 0.8;

const ARCHIVE_REASONS = Object.freeze({
  EXPIRED: 'expired',
  STALE_LOW_VALUE: 'stale-low-value',
  DISABLED: 'disabled',
});

const PROTECTION_REASONS = Object.freeze({
  PINNED: 'pinned',
  HIGH_IMPORTANCE: 'high-importance',
});

class MemoryMaintenanceError extends TypeError {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'MemoryMaintenanceError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function raise(code, detail) {
  throw new MemoryMaintenanceError(code, detail);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Date | ms number | ISO string -> ms, or null when absent/unparseable. */
function toTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function resolveNow(value) {
  if (value === undefined || value === null) return Date.now();
  const time = toTime(value);
  if (time === null) raise('invalid-input', 'now');
  return time;
}

function numberOption(value, fallback, field, min, max) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) raise('invalid-input', field);
  if (min !== undefined && value < min) raise('invalid-input', field);
  if (max !== undefined && value > max) raise('invalid-input', field);
  return value;
}

function booleanOption(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') raise('invalid-input', field);
  return value;
}

function pick(row, camel, snake) {
  if (row[camel] !== undefined) return row[camel];
  if (snake !== undefined && row[snake] !== undefined) return row[snake];
  return undefined;
}

function idOf(row, index) {
  const id = row.id;
  if (typeof id === 'string' && id.trim()) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  return raise('invalid-input', `memories[${index}].id`);
}

function idKey(id) {
  return `${typeof id}:${id}`;
}

function textOf(row) {
  if (typeof row.text === 'string') return row.text;
  if (typeof row.content === 'string') return row.content;
  return '';
}

function scopePart(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value).trim();
}

function importanceOf(row) {
  const value = row.importance;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function useCountOf(row) {
  const value = pick(row, 'useCount', 'use_count');
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isDisabled(row) {
  if (row.disabled === true) return true;
  return row.status === 'disabled';
}

function isPinned(row) {
  return row.pinned === true;
}

function protectionOf(row, importance) {
  if (isPinned(row)) return PROTECTION_REASONS.PINNED;
  if (importance !== null && importance >= HIGH_IMPORTANCE_FLOOR) return PROTECTION_REASONS.HIGH_IMPORTANCE;
  return null;
}

// Total order used for canonical selection and for merge-group order: known
// createdAt first (oldest first), unknown createdAt last; ties by id.
function compareByAgeThenId(a, b) {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === null) return 1;
    if (b.createdAt === null) return -1;
    return a.createdAt - b.createdAt;
  }
  if (a.sortId < b.sortId) return -1;
  if (a.sortId > b.sortId) return 1;
  return 0;
}

/**
 * Build a maintenance plan for a list of memory rows.
 *
 * @param {Array<object>} memories memory rows (never modified)
 * @param {object} [options]
 * @param {number|Date|string} [options.now] reference time (default: Date.now())
 * @param {number} [options.staleDays=365] age in days before an unused row is stale
 * @param {number} [options.minImportance=0.25] rows below this are low value
 * @param {number} [options.maxUseCount=0] rows at or below this count are unused
 * @param {boolean} [options.includeDisabled=false] archive disabled rows too
 * @returns {{archive: Array<{id: any, reason: string}>,
 *            merge: Array<{canonicalId: any, duplicateIds: any[], text: string}>,
 *            keep: any[],
 *            stats: {total: number, archive: number, mergeGroups: number, keep: number}}}
 */
function planMaintenance(memories, options) {
  if (!Array.isArray(memories)) raise('invalid-input', 'memories');
  if (options === undefined || options === null) options = {};
  if (!isObject(options)) raise('invalid-input', 'options');

  const now = resolveNow(options.now);
  const staleDays = numberOption(options.staleDays, DEFAULTS.staleDays, 'staleDays', 0);
  const minImportance = numberOption(options.minImportance, DEFAULTS.minImportance, 'minImportance', 0, 1);
  const maxUseCount = numberOption(options.maxUseCount, DEFAULTS.maxUseCount, 'maxUseCount', 0);
  const includeDisabled = booleanOption(options.includeDisabled, DEFAULTS.includeDisabled, 'includeDisabled');

  const staleCutoff = now - staleDays * DAY_MS;

  const archive = [];
  const order = [];            // ids in input order
  const disposition = new Map(); // idKey -> 'archive' | 'keep' | 'candidate'
  const groups = new Map();    // groupKey -> candidate entries
  const seenIds = new Set();

  for (let index = 0; index < memories.length; index += 1) {
    const row = memories[index];
    if (!isObject(row)) raise('invalid-input', `memories[${index}]`);

    const id = idOf(row, index);
    const key = idKey(id);
    if (seenIds.has(key)) raise('invalid-input', `duplicate id: ${String(id)}`);
    seenIds.add(key);
    order.push(id);

    const importance = importanceOf(row);
    const protection = protectionOf(row, importance);

    if (protection) {
      // Protected rows skip every archive rule but stay merge-eligible.
      disposition.set(key, 'keep');
    } else {
      const expiredAt = toTime(pick(row, 'expiredAt', 'expired_at'));
      if (expiredAt !== null && expiredAt <= now) {
        archive.push({ id, reason: ARCHIVE_REASONS.EXPIRED });
        disposition.set(key, 'archive');
        continue;
      }
      if (isDisabled(row)) {
        if (includeDisabled) {
          archive.push({ id, reason: ARCHIVE_REASONS.DISABLED });
          disposition.set(key, 'archive');
          continue;
        }
        // Not archived, but also not mergeable: folding a live duplicate into a
        // disabled row (or the reverse) would resurrect stale text.
        disposition.set(key, 'keep');
        continue;
      }
      const useCount = useCountOf(row);
      const updatedAt = toTime(pick(row, 'updatedAt', 'updated_at'));
      const stale = useCount !== null
        && useCount <= maxUseCount
        && importance !== null
        && importance < minImportance
        && updatedAt !== null
        && updatedAt < staleCutoff;
      if (stale) {
        archive.push({ id, reason: ARCHIVE_REASONS.STALE_LOW_VALUE });
        disposition.set(key, 'archive');
        continue;
      }
    }

    const text = textOf(row);
    const normalized = normalizeMemoryText(text);
    if (!normalized) {
      // Nothing to compare: an empty row can neither canonicalize nor duplicate.
      if (!disposition.has(key)) disposition.set(key, 'keep');
      continue;
    }

    const scope = `${scopePart(pick(row, 'ownerId', 'owner_id'))}\u0000${scopePart(pick(row, 'projectId', 'project_id'))}`;
    const groupKey = `${scope}\u0000${memoryHash(text)}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = [];
      groups.set(groupKey, group);
    }
    group.push({
      id,
      text,
      sortId: String(id),
      createdAt: toTime(pick(row, 'createdAt', 'created_at')),
    });
    if (!disposition.has(key)) disposition.set(key, 'candidate');
  }

  const merged = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareByAgeThenId);
    const canonical = ordered[0];
    merged.push({
      canonicalId: canonical.id,
      duplicateIds: ordered.slice(1).map(entry => entry.id),
      text: canonical.text,
      createdAt: canonical.createdAt,
      sortId: canonical.sortId,
    });
  }
  // Deterministic group order: same rule as canonical selection, applied to the
  // canonical row of each group.
  merged.sort(compareByAgeThenId);

  const merge = merged.map(entry => ({
    canonicalId: entry.canonicalId,
    duplicateIds: entry.duplicateIds,
    text: entry.text,
  }));

  const mergedAway = new Set();
  for (const entry of merge) {
    for (const id of entry.duplicateIds) mergedAway.add(idKey(id));
  }

  const keep = order.filter(id => {
    const key = idKey(id);
    if (disposition.get(key) === 'archive') return false;
    return !mergedAway.has(key);
  });

  return {
    archive,
    merge,
    keep,
    stats: {
      total: memories.length,
      archive: archive.length,
      mergeGroups: merge.length,
      keep: keep.length,
    },
  };
}

module.exports = {
  planMaintenance,
  MemoryMaintenanceError,
  ARCHIVE_REASONS,
  PROTECTION_REASONS,
  DEFAULTS,
  HIGH_IMPORTANCE_FLOOR,
};
