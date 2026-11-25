'use strict';
// Local encrypted privacy vault — one AES-256-GCM envelope per owner.
//
// Design:
// - The passphrase is never stored, never sent to PostgreSQL and never logged.
//   scrypt (N=2^15, r=8, p=1, keylen=32) derives a per-row key from a random
//   16-byte salt; AES-256-GCM with a random 12-byte nonce and a 16-byte tag
//   seals a single JSON blob:
//     { version: 1, entries: [{ name, kind, value, createdAt, updatedAt }] }
//   `mova_vault` therefore holds only base64 salt/nonce/tag/ciphertext: the
//   whole vault is one row and every write re-seals the blob.
// - Unlocked plaintext lives in memory only, for the lifetime of this factory
//   instance. `lock()` zeroes the derived key and drops the entries, so a locked
//   vault can neither list names nor decrypt values. `status().count` is the last
//   count known to this process: a freshly created locked instance reports 0
//   until the first unlock, because names are never cached while locked.
// - `list()` is masked metadata for UI display; `get()` returns plaintext and
//   must only be called by trusted main-process code (e.g. a request builder).
//   The renderer/IPC layer must never forward `get()` output.
// - Storage is injected via `query(text, params)`; this module imports neither
//   Electron nor `pg`, so it runs in the main process, a worker, or tests.
//
// Single-writer assumption: one row per owner and one process-wide instance, so
// concurrent `put()` calls from two windows must be serialized by the caller
// (the IPC layer already serializes vault requests per owner).
const nodeCrypto = require('node:crypto');

const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keylen: 32 });
// 128 * N * r = 32 MiB; keep headroom so OpenSSL never rejects the params.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BLOB_VERSION = 1;
const KINDS = Object.freeze(['password', 'api-key', 'token', 'note']);
const MIN_PASSPHRASE = 8;
const MAX_PASSPHRASE = 1024;
const MAX_NAME = 100;
const MAX_VALUE = 20000;
const DEFAULT_KIND = 'password';

const SQL = Object.freeze({
  // status() only needs existence: a corrupt envelope must not make status throw.
  existsRow: 'select owner_id from mova_vault where owner_id = $1',
  selectRow: 'select salt, nonce, tag, ciphertext from mova_vault where owner_id = $1',
  insertRow: `insert into mova_vault (owner_id, salt, nonce, tag, ciphertext)
values ($1, $2, $3, $4, $5)
on conflict (owner_id) do nothing
returning owner_id`,
  updateRow: `update mova_vault
set salt = $2, nonce = $3, tag = $4, ciphertext = $5, updated_at = now()
where owner_id = $1
returning owner_id`,
});

class VaultError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'VaultError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const affected = result => Number(result?.rowCount ?? (Array.isArray(result?.rows) ? result.rows.length : 0)) || 0;
const previewOf = value => value.length <= 4 ? '****' : value.slice(-4);

function metadata(entry) {
  return { name: entry.name, kind: entry.kind, preview: previewOf(entry.value), updatedAt: entry.updatedAt };
}

/** setup/changePassphrase: a policy-checked passphrase. */
function strictPassphrase(value, label) {
  if (typeof value !== 'string' || value.length < MIN_PASSPHRASE || value.length > MAX_PASSPHRASE) {
    throw new VaultError('invalid-input', label);
  }
  return value;
}

/**
 * unlock/changePassphrase(old): any non-empty string is a candidate. A short one
 * simply fails authentication, so callers get 'vault-auth' instead of leaking
 * the setup policy.
 */
function candidatePassphrase(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSPHRASE) {
    throw new VaultError('invalid-input', label);
  }
  return value;
}

function entryName(value) {
  if (typeof value !== 'string') throw new VaultError('invalid-input', 'name');
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME) throw new VaultError('invalid-input', 'name');
  return name;
}

function entryValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE) {
    throw new VaultError('invalid-input', 'value');
  }
  return value;
}

function entryKind(value) {
  if (value === undefined || value === null) return DEFAULT_KIND;
  if (!KINDS.includes(value)) throw new VaultError('invalid-input', 'kind');
  return value;
}

/**
 * @param {object} options
 * @param {(sql: string, params?: unknown[]) => Promise<{rows?: object[], rowCount?: number}>} options.query
 * @param {string} options.ownerId  mova_users.id (uuid; PostgreSQL enforces the type)
 * @param {() => number | Date} [options.now]
 * @param {object} [options.crypto]  node:crypto subset (tests/HSM experiments)
 */
function createSecretVault(options = {}) {
  if (!isObject(options)) throw new VaultError('invalid-input', 'options');
  if (typeof options.query !== 'function') throw new VaultError('invalid-input', 'query');
  if (typeof options.ownerId !== 'string' || !options.ownerId.trim() || options.ownerId.length > 200) {
    throw new VaultError('invalid-input', 'ownerId');
  }
  const query = options.query;
  const ownerId = options.ownerId.trim();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const crypto = options.crypto || nodeCrypto;
  for (const method of ['randomBytes', 'scrypt', 'createCipheriv', 'createDecipheriv']) {
    if (typeof crypto[method] !== 'function') throw new VaultError('invalid-input', `crypto.${method}`);
  }

  // { key: Buffer(32), salt: Buffer(16), entries: Entry[] } — plaintext only
  // while unlocked; `key` is zeroed whenever the state is dropped.
  let state = null;
  let lastCount = 0;
  let configuredKnown = false;

  function timestamp() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new VaultError('invalid-input', 'now');
    return date.toISOString();
  }

  function dropState() {
    if (!state) return;
    state.key.fill(0);
    state.entries.length = 0;
    state = null;
  }

  function requireUnlocked() {
    if (!state) throw new VaultError('vault-locked');
    return state;
  }

  function randomBytes(size) {
    const bytes = crypto.randomBytes(size);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new VaultError('storage-error', 'random');
    return bytes;
  }

  /** scrypt is async so unlocking never blocks the Electron main event loop. */
  function derive(passphrase, salt) {
    const material = Buffer.from(passphrase, 'utf8');
    return new Promise((resolve, reject) => {
      const settle = (error, key) => {
        material.fill(0);
        if (error) reject(new VaultError('storage-error', 'scrypt'));
        else resolve(Buffer.from(key));
      };
      try {
        crypto.scrypt(material, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM }, settle);
      } catch {
        settle(new Error('scrypt'));
      }
    });
  }

  /** Seals `entries` with an already-derived key. Returns base64 envelope fields. */
  function sealWith(key, salt, entries) {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    const blob = Buffer.from(JSON.stringify({ version: BLOB_VERSION, entries }), 'utf8');
    try {
      const ciphertext = Buffer.concat([cipher.update(blob), cipher.final()]);
      return {
        salt: salt.toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      blob.fill(0);
    }
  }

  function parseBlob(plain) {
    let blob;
    try {
      blob = JSON.parse(plain.toString('utf8'));
    } catch {
      throw new VaultError('storage-error', 'blob-json');
    }
    if (!isObject(blob) || blob.version !== BLOB_VERSION || !Array.isArray(blob.entries)) {
      throw new VaultError('storage-error', 'blob-shape');
    }
    return blob.entries.map(entry => {
      if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string' || !KINDS.includes(entry.kind)) {
        throw new VaultError('storage-error', 'blob-entry');
      }
      return {
        name: entry.name,
        kind: entry.kind,
        value: entry.value,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
      };
    });
  }

  /** Decrypts with an already-derived key. Never returns plaintext in errors. */
  function openWith(key, row) {
    let plain;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, row.nonce, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(row.tag);
      plain = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    } catch {
      throw new VaultError('vault-auth');
    }
    try {
      return parseBlob(plain);
    } finally {
      plain.fill(0);
    }
  }

  async function readRow() {
    let result;
    try {
      result = await query(SQL.selectRow, [ownerId]);
    } catch (error) {
      throw new VaultError('storage-error', error?.code || 'select');
    }
    const row = Array.isArray(result?.rows) ? result.rows[0] : null;
    if (!row) return null;
    const decode = (value, size, label) => {
      const buffer = Buffer.from(typeof value === 'string' ? value : '', 'base64');
      if (buffer.length === 0 || (size > 0 && buffer.length !== size)) throw new VaultError('storage-error', label);
      return buffer;
    };
    return {
      salt: decode(row.salt, SALT_BYTES, 'salt'),
      nonce: decode(row.nonce, NONCE_BYTES, 'nonce'),
      tag: decode(row.tag, TAG_BYTES, 'tag'),
      ciphertext: decode(row.ciphertext, 0, 'ciphertext'),
    };
  }

  async function writeRow(envelope) {
    let result;
    try {
      result = await query(SQL.updateRow, [ownerId, envelope.salt, envelope.nonce, envelope.tag, envelope.ciphertext]);
    } catch (error) {
      throw new VaultError('storage-error', error?.code || 'update');
    }
    if (affected(result) === 0) {
      dropState();
      configuredKnown = false;
      lastCount = 0;
      throw new VaultError('vault-not-configured');
    }
  }

  /** Cheap existence check: a corrupt envelope must never make status/setup throw. */
  async function hasRow() {
    let result;
    try {
      result = await query(SQL.existsRow, [ownerId]);
    } catch (error) {
      throw new VaultError('storage-error', error?.code || 'select');
    }
    return Array.isArray(result?.rows) && result.rows.length > 0;
  }

  async function status() {
    const configured = await hasRow();
    configuredKnown = configured;
    if (!configured) {
      dropState();
      lastCount = 0;
    }
    return { configured, unlocked: state !== null, count: state ? state.entries.length : lastCount };
  }

  async function setup(passphrase) {
    const secret = strictPassphrase(passphrase, 'passphrase');
    if (await hasRow()) throw new VaultError('vault-exists');
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(secret, salt);
    let sealed;
    try {
      sealed = sealWith(key, salt, []);
    } catch (error) {
      key.fill(0);
      throw new VaultError('storage-error', error?.code || 'seal');
    }
    let result;
    try {
      result = await query(SQL.insertRow, [ownerId, sealed.salt, sealed.nonce, sealed.tag, sealed.ciphertext]);
    } catch (error) {
      key.fill(0);
      throw new VaultError('storage-error', error?.code || 'insert');
    }
    if (affected(result) === 0) {
      key.fill(0);
      throw new VaultError('vault-exists');
    }
    dropState();
    state = { key, salt, entries: [] };
    configuredKnown = true;
    lastCount = 0;
    return { configured: true, unlocked: true, count: 0 };
  }

  async function unlock(passphrase) {
    const secret = candidatePassphrase(passphrase, 'passphrase');
    const row = await readRow();
    if (!row) {
      dropState();
      configuredKnown = false;
      lastCount = 0;
      throw new VaultError('vault-not-configured');
    }
    const key = await derive(secret, row.salt);
    let entries;
    try {
      entries = openWith(key, row);
    } catch (error) {
      key.fill(0);
      throw error;
    }
    dropState();
    state = { key, salt: row.salt, entries };
    configuredKnown = true;
    lastCount = entries.length;
    return { configured: true, unlocked: true, count: entries.length };
  }

  /** Synchronous and storage-free: locking must be immediate and always possible. */
  function lock() {
    dropState();
    return { configured: configuredKnown, unlocked: false, count: lastCount };
  }

  async function put(input = {}) {
    if (!isObject(input)) throw new VaultError('invalid-input', 'input');
    const current = requireUnlocked();
    const name = entryName(input.name);
    const value = entryValue(input.value);
    const kind = entryKind(input.kind);
    const at = timestamp();
    const index = current.entries.findIndex(entry => entry.name === name);
    const entry = index === -1
      ? { name, kind, value, createdAt: at, updatedAt: at }
      : { ...current.entries[index], kind, value, updatedAt: at };
    // Build the next array immutably: a failed write must not desync memory.
    const entries = index === -1
      ? [...current.entries, entry]
      : current.entries.map((item, position) => (position === index ? entry : item));
    await writeRow(sealWith(current.key, current.salt, entries));
    current.entries = entries;
    lastCount = entries.length;
    return metadata(entry);
  }

  /** Masked metadata only: never a value, never the plaintext of a secret. */
  async function list() {
    const current = requireUnlocked();
    return current.entries.map(metadata);
  }

  /**
   * Plaintext string for a trusted main-process caller (e.g. the IPC `vault:get`
   * handler feeding the clipboard). Metadata lives in `list()`. Never expose
   * this over IPC to untrusted renderer code or log it.
   */
  async function get(name) {
    const current = requireUnlocked();
    const wanted = entryName(name);
    const entry = current.entries.find(item => item.name === wanted);
    if (!entry) throw new VaultError('not-found', wanted);
    return entry.value;
  }

  async function remove(name) {
    const current = requireUnlocked();
    const wanted = entryName(name);
    const index = current.entries.findIndex(item => item.name === wanted);
    if (index === -1) throw new VaultError('not-found', wanted);
    const entries = current.entries.filter((item, position) => position !== index);
    await writeRow(sealWith(current.key, current.salt, entries));
    current.entries = entries;
    lastCount = entries.length;
    return { name: wanted, removed: true, count: entries.length };
  }

  async function changePassphrase(oldPassphrase, nextPassphrase) {
    const previous = candidatePassphrase(oldPassphrase, 'oldPassphrase');
    const next = strictPassphrase(nextPassphrase, 'newPassphrase');
    const row = await readRow();
    if (!row) {
      dropState();
      configuredKnown = false;
      lastCount = 0;
      throw new VaultError('vault-not-configured');
    }
    const oldKey = await derive(previous, row.salt);
    let entries;
    try {
      entries = openWith(oldKey, row);
    } catch (error) {
      oldKey.fill(0);
      throw error;
    }
    oldKey.fill(0);
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(next, salt);
    try {
      await writeRow(sealWith(key, salt, entries));
    } catch (error) {
      key.fill(0);
      throw error;
    }
    dropState();
    state = { key, salt, entries };
    configuredKnown = true;
    lastCount = entries.length;
    return { configured: true, unlocked: true, count: entries.length, rotatedAt: timestamp() };
  }

  return { status, setup, unlock, lock, put, list, get, remove, changePassphrase };
}

module.exports = {
  createSecretVault,
  VaultError,
  SQL,
  SCRYPT,
  KINDS,
  BLOB_VERSION,
  SALT_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  MIN_PASSPHRASE,
  MAX_NAME,
  MAX_VALUE,
};
