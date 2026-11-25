'use strict';
// Storage quota accounting for Mova.
//
// Scope:
// - Reads the `quotaBytes` setting (0 = unlimited, default 0, range 0..1 TiB).
// - Measures the database (`pg_database_size`), the local attachment directory,
//   and — only when the caller supplies a cheap provider — object storage usage.
// - `checkWrite({ bytes })` throws a QuotaError with code 'quota-exceeded' when
//   the write would cross the configured limit. Nothing is ever deleted, and no
//   value is invented when a measurement fails.
// - `stats()` never throws; unmeasured sources are null and listed in `errors`.
//
// Pure Node module: no Electron, no network, no implicit deletion.
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_QUOTA_BYTES = 0;
const MAX_QUOTA_BYTES = 1024 ** 4; // 1 TiB
const MAX_DEPTH = 32;

class QuotaError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'QuotaError';
    this.code = code;
    Object.assign(this, detail);
  }
}

function validateQuotaBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUOTA_BYTES) throw new QuotaError('invalid-quota', { value });
  return value;
}

function isValidQuotaBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_QUOTA_BYTES;
}

/** Settings may omit quotaBytes; undefined/null mean "unlimited". */
function normalizeQuotaBytes(value) {
  if (value === undefined || value === null) return DEFAULT_QUOTA_BYTES;
  return validateQuotaBytes(value);
}

function positiveInt(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new QuotaError(code, { value });
  return value;
}

const round = value => Math.round(value * 10) / 10;

/**
 * Recursively sum regular-file sizes in `directory`.
 * - a missing directory is 0 bytes (nothing stored yet)
 * - symlinks are never followed (no escaping the attachment dir)
 * - read errors propagate so callers can report an incomplete measurement
 */
async function directoryBytes(directory, { io = fsPromises, depth = 0 } = {}) {
  if (typeof directory !== 'string' || !directory) throw new QuotaError('invalid-directory');
  if (depth > MAX_DEPTH) throw new QuotaError('attachment-scan-failed', { directory, reason: 'depth' });
  let entries;
  try {
    entries = await io.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 0;
    throw new QuotaError('attachment-scan-failed', { directory, reason: error?.code || 'readdir' });
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, String(entry.name));
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await directoryBytes(entryPath, { io, depth: depth + 1 });
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await io.lstat(entryPath);
      if (Number.isFinite(stat.size) && stat.size > 0) total += stat.size;
    } catch (error) {
      if (error?.code === 'ENOENT') continue; // deleted while scanning
      throw new QuotaError('attachment-scan-failed', { directory: entryPath, reason: error?.code || 'lstat' });
    }
  }
  return total;
}

function readSetting(provider) {
  if (typeof provider === 'function') return provider();
  if (provider && typeof provider === 'object' && typeof provider.settings === 'function') return provider.settings();
  return provider;
}

/**
 * @param {{
 *   query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
 *   directory?: string | (() => string),   // local attachment dir (e.g. userData/chat-images)
 *   settingsProvider?: (() => object | Promise<object>) | { settings: Function } | object,
 *   objectUsage?: () => Promise<number | null>,  // optional cheap S3 usage provider
 *   io?: object,                                // fs/promises subset (tests)
 *   now?: () => number,
 *   onMeasurementFailure?: 'reject' | 'allow',  // quota>0 and DB size unknown, default 'reject'
 * }} options
 */
function createQuotaService(options = {}) {
  const query = typeof options.query === 'function' ? options.query : null;
  const settingsProvider = options.settingsProvider ?? null;
  const objectUsage = typeof options.objectUsage === 'function' ? options.objectUsage : null;
  const io = options.io || fsPromises;
  const now = options.now || Date.now;
  const onMeasurementFailure = options.onMeasurementFailure === 'allow' ? 'allow' : 'reject';

  function directoryPath() {
    const value = typeof options.directory === 'function' ? options.directory() : options.directory;
    return typeof value === 'string' && value ? value : null;
  }

  async function quotaValue() {
    if (!settingsProvider) return DEFAULT_QUOTA_BYTES;
    let settings;
    try {
      settings = await readSetting(settingsProvider);
    } catch {
      throw new QuotaError('settings-unavailable');
    }
    const value = settings && typeof settings === 'object' ? settings.quotaBytes : undefined;
    return normalizeQuotaBytes(value);
  }

  async function databaseBytes() {
    if (!query) return { bytes: null, error: { source: 'database', code: 'database-unavailable' } };
    try {
      const result = await query('select pg_database_size(current_database())::bigint as bytes');
      const raw = result?.rows?.[0]?.bytes;
      const bytes = Number(raw);
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid size');
      return { bytes, error: null };
    } catch (error) {
      return { bytes: null, error: { source: 'database', code: 'database-size-unavailable', reason: error?.code || 'query-failed' } };
    }
  }

  async function attachmentBytes() {
    const directory = directoryPath();
    if (!directory) return { bytes: null, error: { source: 'attachments', code: 'invalid-directory' } };
    try {
      return { bytes: await directoryBytes(directory, { io }), error: null };
    } catch (error) {
      return { bytes: null, error: { source: 'attachments', code: error?.code || 'attachment-scan-failed' } };
    }
  }

  async function objectBytes() {
    if (!objectUsage) return { bytes: null, error: null }; // unknown is not an error
    try {
      const value = await objectUsage();
      if (value === null || value === undefined) return { bytes: null, error: null };
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid size');
      return { bytes, error: null };
    } catch {
      return { bytes: null, error: { source: 'objectStorage', code: 'object-usage-unavailable' } };
    }
  }

  async function measure() {
    const [database, attachments, objects] = await Promise.all([databaseBytes(), attachmentBytes(), objectBytes()]);
    const errors = [database.error, attachments.error, objects.error].filter(Boolean);
    const known = [database.bytes, attachments.bytes, objects.bytes].filter(bytes => typeof bytes === 'number');
    return {
      databaseBytes: database.bytes,
      attachmentBytes: attachments.bytes,
      objectBytes: objects.bytes,
      bytes: known.reduce((total, value) => total + value, 0),
      errors,
      complete: errors.length === 0,
    };
  }

  /**
   * Throws QuotaError('quota-exceeded') when used + bytes would exceed the
   * limit, and QuotaError('quota-unavailable') when a required measurement
   * failed while a limit is configured (unless onMeasurementFailure='allow').
   * Never throws when the quota is unlimited (0): no database query is issued.
   */
  async function checkWrite(input = {}) {
    const requested = input && input.bytes !== undefined ? input.bytes : 0;
    positiveInt(requested, 'invalid-input');
    const quotaBytes = await quotaValue();
    if (quotaBytes === 0) {
      return { ok: true, allowed: true, unlimited: true, quotaBytes, usedBytes: null, requestedBytes: requested, percent: null, measured: false };
    }
    const measured = await measure();
    const required = [measured.databaseBytes, measured.attachmentBytes];
    if (required.includes(null)) {
      if (onMeasurementFailure === 'allow') {
        return {
          ok: true, allowed: true, unlimited: false, quotaBytes, usedBytes: measured.bytes,
          requestedBytes: requested, percent: round((measured.bytes / quotaBytes) * 100),
          measured: false, complete: false, errors: measured.errors,
        };
      }
      throw new QuotaError('quota-unavailable', {
        quotaBytes,
        requestedBytes: requested,
        usedBytes: measured.bytes,
        errors: measured.errors,
      });
    }
    if (measured.bytes + requested > quotaBytes) {
      throw new QuotaError('quota-exceeded', {
        quotaBytes,
        usedBytes: measured.bytes,
        requestedBytes: requested,
        percent: round((measured.bytes / quotaBytes) * 100),
        sources: { databaseBytes: measured.databaseBytes, attachmentBytes: measured.attachmentBytes, objectBytes: measured.objectBytes },
      });
    }
    return {
      ok: true,
      allowed: true,
      unlimited: false,
      quotaBytes,
      usedBytes: measured.bytes,
      requestedBytes: requested,
      percent: round((measured.bytes / quotaBytes) * 100),
      measured: true,
      complete: measured.complete,
      sources: { databaseBytes: measured.databaseBytes, attachmentBytes: measured.attachmentBytes, objectBytes: measured.objectBytes },
      errors: measured.errors,
    };
  }

  /** Never throws; a failed source is null and appears in `errors`. */
  async function stats() {
    let quotaBytes = null;
    const errors = [];
    try {
      quotaBytes = await quotaValue();
    } catch (error) {
      errors.push({ source: 'settings', code: error?.code || 'invalid-quota' });
    }
    const measured = await measure();
    errors.push(...measured.errors);
    const unlimited = quotaBytes === 0;
    return {
      bytes: measured.bytes,
      usedBytes: measured.bytes,
      quotaBytes,
      unlimited,
      percent: typeof quotaBytes === 'number' && quotaBytes > 0 ? round((measured.bytes / quotaBytes) * 100) : null,
      withinQuota: typeof quotaBytes === 'number' && quotaBytes > 0 ? measured.bytes <= quotaBytes : unlimited ? true : null,
      complete: measured.complete && !errors.some(error => error.source === 'settings'),
      databaseBytes: measured.databaseBytes,
      attachmentBytes: measured.attachmentBytes,
      objectBytes: measured.objectBytes,
      errors,
      measuredAt: new Date(now()).toISOString(),
    };
  }

  return { checkWrite, stats, quotaBytes: quotaValue, measure };
}

module.exports = {
  createQuotaService,
  validateQuotaBytes,
  isValidQuotaBytes,
  normalizeQuotaBytes,
  directoryBytes,
  QuotaError,
  DEFAULT_QUOTA_BYTES,
  MAX_QUOTA_BYTES,
};
