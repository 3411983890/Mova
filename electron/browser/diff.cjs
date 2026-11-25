'use strict';
// Snapshot diff: align entries by their stable key (backendDOMNodeId for
// elements, AX node id for text), compare fingerprints, and emit only what
// changed. Pure function: the caller decides when a full snapshot is cheaper.

const CHANGE_THRESHOLD = 0.6;
const MIN_NODES_FOR_THRESHOLD = 20;

function flagsOf(entry) {
  const raw = typeof entry.flags === 'string' ? entry.flags.trim() : '';
  if (!raw) return new Set();
  return new Set(raw.replace(/^\[|\]$/g, '').split(/\s+/).filter(Boolean));
}

function prefixed(prefix, entry) {
  return `${prefix} ${String(entry.line || '').replace(/^(\s*)- /, '$1')}`;
}

function describeChange(before, after) {
  const parts = [];
  if (before.name !== after.name) parts.push(`name: "${before.name}" → "${after.name}"`);
  if (before.value !== after.value) parts.push(`value: "${before.value}" → "${after.value}"`);
  if (before.text !== after.text) parts.push(`text: "${before.text}" → "${after.text}"`);
  const beforeFlags = flagsOf(before);
  const afterFlags = flagsOf(after);
  const added = [...afterFlags].filter(flag => !beforeFlags.has(flag));
  const removed = [...beforeFlags].filter(flag => !afterFlags.has(flag));
  if (added.length) parts.push(`+${added.join(',')}`);
  if (removed.length) parts.push(`-${removed.join(',')}`);
  return parts;
}

/**
 * @param {{entries?: object[], url?: string} | null} previous
 * @param {{entries?: object[], url?: string}} next
 * @param {{threshold?: number}} [options]
 */
function diffSnapshots(previous, next, options = {}) {
  const nextEntries = Array.isArray(next?.entries) ? next.entries : [];
  if (!previous || !Array.isArray(previous.entries) || previous.entries.length === 0) {
    return { mode: 'full', reason: 'first-snapshot', text: '', lines: [], stats: { added: 0, removed: 0, changed: 0, unchanged: 0 } };
  }
  if (previous.url && next?.url && previous.url !== next.url) {
    return { mode: 'full', reason: 'url-changed', text: '', lines: [], stats: { added: 0, removed: 0, changed: 0, unchanged: 0 } };
  }

  const previousByKey = new Map(previous.entries.map(entry => [entry.key, entry]));
  const nextByKey = new Map(nextEntries.map(entry => [entry.key, entry]));
  const added = [];
  const changed = [];
  let unchanged = 0;

  for (const entry of nextEntries) {
    const before = previousByKey.get(entry.key);
    if (!before) { added.push(entry); continue; }
    if (before.fingerprint === entry.fingerprint) { unchanged += 1; continue; }
    changed.push({ before, after: entry });
  }

  const removed = previous.entries.filter(entry => !nextByKey.has(entry.key));

  // Suppress "node was replaced but looks identical" churn: pair a removal and
  // an addition with the same role/name/text at the same depth.
  const paired = new Set();
  const filteredRemoved = [];
  for (const entry of removed) {
    const index = added.findIndex((candidate, position) => !paired.has(position)
      && candidate.role === entry.role
      && candidate.name === entry.name
      && candidate.text === entry.text
      && candidate.depth === entry.depth);
    if (index >= 0) { paired.add(index); continue; }
    filteredRemoved.push(entry);
  }
  const filteredAdded = added.filter((_entry, index) => !paired.has(index));

  const base = Math.max(previous.entries.length, nextEntries.length);
  const changes = filteredAdded.length + filteredRemoved.length + changed.length;
  const threshold = typeof options.threshold === 'number' ? options.threshold : CHANGE_THRESHOLD;
  if (base >= MIN_NODES_FOR_THRESHOLD && changes > base * threshold) {
    return {
      mode: 'full',
      reason: 'too-many-changes',
      text: '',
      lines: [],
      stats: { added: filteredAdded.length, removed: filteredRemoved.length, changed: changed.length, unchanged },
    };
  }

  const lines = [];
  for (const item of changed) {
    const detail = describeChange(item.before, item.after);
    const suffix = detail.length ? `  (${detail.join('; ')})` : '';
    lines.push(`${prefixed('~', item.after)}${suffix}`);
  }
  for (const entry of filteredAdded) lines.push(prefixed('+', entry));
  for (const entry of filteredRemoved) lines.push(prefixed('-', entry));

  const header = `# diff ${next?.url || ''}  (+${filteredAdded.length} -${filteredRemoved.length} ~${changed.length})`;
  const summary = `${filteredAdded.length} additions, ${filteredRemoved.length} removals, ${changed.length} changed, ${unchanged} unchanged`;
  const text = lines.length ? [header, ...lines].join('\n') : `${header}\n（没有变化）`;
  return {
    mode: 'diff',
    text: lines.length ? `${text}\n${summary}` : text,
    lines,
    stats: { added: filteredAdded.length, removed: filteredRemoved.length, changed: changed.length, unchanged },
  };
}

module.exports = { diffSnapshots, describeChange, CHANGE_THRESHOLD };
