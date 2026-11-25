'use strict';
const { createHash } = require('node:crypto');
const { appendFile, mkdir, readFile, realpath, rename, rm, writeFile } = require('node:fs/promises');
const { basename, dirname, isAbsolute, resolve, sep } = require('node:path');

// Permission model for project file access.
//
// Trust boundary: the renderer is untrusted. Roots are registered only from the
// native folder picker (trusted) or from an explicit, path-disclosing native
// confirmation. Capabilities are stored here, in the main process, never in the
// renderer workspace. Widening a capability always asks the user through a
// native dialog; narrowing never does. Every write/exec decision is audited.
const CAPABILITIES = Object.freeze(['read', 'write', 'exec']);
const APPROVAL_CAPABILITIES = Object.freeze(['write', 'exec']);
// Composer-level approval mode. It never widens folder or capability grants: it
// only decides whether an already granted write/exec still asks on every call.
const PRESETS = Object.freeze(['default', 'auto', 'full']);
const PRESET_AUTO_ACCEPT = Object.freeze({
  default: Object.freeze({ write: false, exec: false }),
  auto: Object.freeze({ write: true, exec: false }),
  full: Object.freeze({ write: true, exec: true }),
});
function effectiveProjectCapabilities(capabilities, preset) {
  return {
    read: capabilities.read || preset === 'auto' || preset === 'full',
    write: capabilities.write || preset === 'auto' || preset === 'full',
    exec: capabilities.exec || preset === 'full',
  };
}
const MAX_ROOTS = 32;
const CAPABILITY_LABELS = Object.freeze({ read: '读取文件', write: '修改文件', exec: '运行命令' });
const IGNORED_WRITE_SEGMENTS = Object.freeze(['.git']);

class PermissionError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'PermissionError';
    this.code = code;
  }
}

function isInside(parent, child) {
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const p = fold(resolve(parent));
  const c = fold(resolve(child));
  return c === p || c.startsWith(`${p}${sep}`);
}

/** Normalizes a folder chosen by the user into a stable project root identity. */
function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new PermissionError('invalid-path');
  if (!isAbsolute(value)) throw new PermissionError('invalid-path');
  const path = resolve(value);
  const identity = process.platform === 'win32' ? path.toLowerCase() : path;
  return {
    path,
    identity,
    name: basename(path) || path,
    id: `project-${createHash('sha256').update(identity).digest('hex')}`,
  };
}

async function realpathOrNull(path) {
  try { return await realpath(path); } catch { return null; }
}

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Windows resolves several spellings to something other than the named file:
 * `name:stream` writes an alternate data stream, a trailing dot or space is
 * stripped, and reserved device names open a device. Reject them so the model
 * cannot write somewhere other than the path it reported.
 */
function assertSafeSegment(segment) {
  if (segment.includes(':')) throw new PermissionError('invalid-path');
  if (process.platform !== 'win32') return;
  if (/[. ]$/.test(segment)) throw new PermissionError('invalid-path');
  if (WINDOWS_DEVICE_NAMES.test(segment)) throw new PermissionError('invalid-path');
}

/**
 * Resolves a model-supplied relative path inside one project root.
 *
 * Rejects absolute paths, drive letters, UNC paths, NUL bytes and `..`
 * segments, then verifies the real path (following junctions and symlinks) is
 * still inside the real root, so a link inside the project cannot be used to
 * read or write elsewhere on the machine.
 */
async function resolveInside(rootPath, relativePath, options = {}) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) throw new PermissionError('invalid-path');
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (!normalized) throw new PermissionError('invalid-path');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new PermissionError('absolute-path');
  }
  const segments = normalized.split('/').filter(segment => segment && segment !== '.');
  if (!segments.length) throw new PermissionError('invalid-path');
  if (segments.includes('..')) throw new PermissionError('path-escape');
  for (const segment of segments) assertSafeSegment(segment);

  const root = resolve(rootPath);
  const target = resolve(root, ...segments);
  if (!isInside(root, target)) throw new PermissionError('path-escape');

  const realRoot = await realpathOrNull(root);
  if (!realRoot) throw new PermissionError('root-missing');
  // Walk up to the nearest existing ancestor: a missing target still has to
  // resolve through real directories that are inside the real root.
  let probe = target;
  let real = await realpathOrNull(probe);
  while (!real) {
    const parent = dirname(probe);
    if (parent === probe) throw new PermissionError('invalid-path');
    probe = parent;
    real = await realpathOrNull(probe);
  }
  if (!isInside(realRoot, real)) throw new PermissionError('path-escape');
  if (probe !== target && options.allowMissing !== true) throw new PermissionError('not-found');
  return target;
}

function normalizePreset(value) {
  return PRESETS.includes(value) ? value : 'default';
}

function emptyState() {
  return { version: 1, preset: 'default', roots: [] };
}

function normalizeCapabilities(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(CAPABILITIES.map(name => [name, source[name] === true]));
}

function normalizeRoot(value) {
  if (!value || typeof value !== 'object') throw new PermissionError('store-error');
  const canonical = canonicalPath(value.path);
  return {
    id: canonical.id,
    path: canonical.path,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 120) : canonical.name,
    capabilities: normalizeCapabilities(value.capabilities),
    autoAccept: normalizeCapabilities(value.autoAccept),
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
  };
}

function publicRoot(root) {
  return {
    id: root.id,
    path: root.path,
    name: root.name,
    capabilities: { ...root.capabilities },
    autoAccept: { ...root.autoAccept },
    updatedAt: root.updatedAt,
  };
}

/**
 * @param {{
 *   filePath?: string | (() => string),
 *   confirm?: (request: any) => Promise<string>,
 *   audit?: (entry: any) => void,
 *   clock?: () => number,
 * }} [options]
 */
function createPermissionStore(options = {}) {
  if (typeof options !== 'object' || options === null) throw new TypeError('options are required');
  const rawPath = options.filePath;
  const filePath = typeof rawPath === 'function' ? rawPath : () => String(rawPath ?? '');
  const confirm = typeof options.confirm === 'function' ? options.confirm : async () => 'deny';
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  /** Session grants: `${sessionKey}\0${rootId}\0${capability}` → true. Never persisted. */
  const sessions = new Set();
  let state = null;
  let loading = null;
  let queue = Promise.resolve();
  /** Set when the stored file is unreadable and could not be preserved. */
  let storeBlocked = null;

  function record(entry) {
    try { audit({ time: clock(), ...entry }); } catch { /* Auditing must never break an operation. */ }
  }

  async function readState() {
    let raw;
    try {
      raw = await readFile(filePath(), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      record({ action: 'store-error', detail: error.code || 'read-failed' });
      return emptyState();
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.roots)) throw new Error('shape');
      return {
        version: 1,
        preset: normalizePreset(parsed.preset),
        roots: parsed.roots.flatMap(root => { try { return [normalizeRoot(root)]; } catch { return []; } }),
      };
    } catch {
      // Fail closed, but keep the unreadable file: a later save would otherwise
      // overwrite the user's grants with an empty list and lose them for good.
      const aside = `${filePath()}.corrupt-${clock()}`;
      let preserved = true;
      await rename(filePath(), aside).catch(error => {
        // If the unreadable file cannot be moved aside, saving over it would
        // destroy the user's grants for good, so writes stay blocked.
        if (error?.code !== 'ENOENT') preserved = false;
      });
      if (!preserved) storeBlocked = 'store-error';
      record({ action: 'store-error', detail: 'corrupt', backup: preserved ? aside : null });
      return emptyState();
    }
  }

  async function persist() {
    if (storeBlocked) throw new PermissionError(storeBlocked, 'permission-file-unreadable');
    const file = filePath();
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw new PermissionError('store-error', error.code || 'write-failed');
    }
  }

  async function load() {
    if (state) return state;
    if (!loading) {
      loading = readState().then(value => { state = value; return value; }).finally(() => { loading = null; });
    }
    return loading;
  }

  function mutate(operation) {
    const run = queue.then(async () => {
      const current = await load();
      // Memory must never hold a grant the disk refused: if the write fails, the
      // in-memory state is rolled back instead of lying about what is stored.
      const snapshot = structuredClone(current);
      let result;
      try {
        result = await operation(current);
      } catch (error) {
        state = snapshot;
        throw error;
      }
      try {
        await persist();
      } catch (error) {
        state = snapshot;
        throw error;
      }
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  function find(current, rootId) {
    const root = current.roots.find(item => item.id === rootId);
    if (!root) throw new PermissionError('not-registered');
    return root;
  }

  function sessionKeyOf(sessionKey, rootId, capability) {
    return `${sessionKey}\0${rootId}\0${capability}`;
  }

  async function list() {
    const current = await load();
    return { version: 1, preset: normalizePreset(current.preset), roots: current.roots.map(publicRoot) };
  }

  async function get(rootId) {
    const current = await load();
    const root = current.roots.find(item => item.id === rootId);
    return root ? publicRoot(root) : null;
  }

  /**
   * Registers roots with every capability off. Registration never grants access.
   * `options.confirm` asks the user through a native dialog first: that path is
   * for renderer-initiated registration, where the path did not come from the
   * trusted folder picker.
   *
   * A root that already exists is never re-armed silently: if it still holds a
   * grant, the user is asked whether to keep it, and anything but an explicit
   * `allow` resets the grants. That is what stops a delete/re-add of the same
   * folder from handing the model write access with no prompt at all.
   */
  async function register(folders, options = {}) {
    if (!Array.isArray(folders)) throw new PermissionError('invalid-path');
    const canonical = folders.map(folder => canonicalPath(typeof folder === 'string' ? folder : folder?.path));
    if (!canonical.length) return list();
    return mutate(async current => {
      const additions = canonical.filter(entry => !current.roots.some(root => root.id === entry.id));
      if (current.roots.length + additions.length > MAX_ROOTS) throw new PermissionError('too-many-roots');
      if (options.confirm === true) {
        for (const entry of additions) {
          const decision = await confirm({
            mode: 'grant',
            win: options.win,
            title: '登记这个文件夹？',
            message: entry.name,
            detail: `${entry.path}\n\n登记只保存文件夹路径，不会授予任何访问权限。`,
          });
          if (decision !== 'allow') throw new PermissionError('denied');
        }
      }
      for (const entry of canonical) {
        const existing = current.roots.find(root => root.id === entry.id);
        if (existing) {
          existing.path = entry.path;
          existing.name = entry.name;
          existing.updatedAt = clock();
          // Re-adding a folder must not silently inherit what it was granted
          // before: deleting a project and re-adding the same folder would
          // otherwise hand the model write access with no prompt and no dialog.
          if (CAPABILITIES.some(capability => existing.capabilities[capability])) {
            const granted = CAPABILITIES
              .filter(capability => existing.capabilities[capability])
              .map(capability => (APPROVAL_CAPABILITIES.includes(capability) && existing.autoAccept[capability]
                ? `${CAPABILITY_LABELS[capability]}（自动接受）`
                : CAPABILITY_LABELS[capability]));
            const decision = await confirm({
              mode: 'grant',
              title: '保留之前授予的权限？',
              message: entry.name,
              detail: `${entry.path}\n\n之前已授权：${granted.join('、')}。`,
              win: options.win,
              signal: options.signal,
            });
            if (decision !== 'allow') {
              for (const capability of CAPABILITIES) existing.capabilities[capability] = false;
              for (const capability of APPROVAL_CAPABILITIES) existing.autoAccept[capability] = false;
              for (const key of [...sessions]) if (key.includes(`\0${existing.id}\0`)) sessions.delete(key);
              record({ action: 'register-reset', rootId: existing.id });
            } else {
              record({ action: 'register-keep', rootId: existing.id });
            }
          }
          continue;
        }
        current.roots.push({
          id: entry.id,
          path: entry.path,
          name: entry.name,
          capabilities: { read: false, write: false, exec: false },
          autoAccept: { write: false, exec: false },
          createdAt: clock(),
          updatedAt: clock(),
        });
        record({ action: 'register', rootId: entry.id, path: entry.path });
      }
      const preset = normalizePreset(current.preset);
      for (const root of current.roots) {
        if (preset === 'auto' || preset === 'full') {
          root.capabilities.read = true;
          root.capabilities.write = true;
        }
        if (preset === 'full') root.capabilities.exec = true;
      }
      return { version: 1, preset, roots: current.roots.map(publicRoot) };
    });
  }

  /**
   * Grants or revokes one capability. Granting asks the user through a native
   * dialog that shows the exact folder path; the renderer cannot bypass it.
   */
  async function setCapability(input = {}) {
    const { rootId, capability, value, win } = input;
    if (!CAPABILITIES.includes(capability)) throw new PermissionError('unknown-capability');
    if (typeof value !== 'boolean') throw new PermissionError('request');
    return mutate(async current => {
      const root = find(current, rootId);
      // Editing blind is a data-loss hazard: writing requires being able to read.
      if (value && capability === 'write' && !root.capabilities.read) throw new PermissionError('read-required');
      if (value && !root.capabilities[capability]) {
        const decision = await confirm({
          mode: 'grant',
          win,
          title: `允许模型${CAPABILITY_LABELS[capability]}？`,
          message: `${root.name} · ${CAPABILITY_LABELS[capability]}`,
          detail: `${root.path}\n\n授权后，模型只能在这个文件夹内操作；你可以随时撤销。`,
        });
        if (decision !== 'allow') {
          record({ action: 'grant-denied', rootId: root.id, capability });
          throw new PermissionError('denied');
        }
      }
      root.capabilities[capability] = value;
      if (!value && APPROVAL_CAPABILITIES.includes(capability)) root.autoAccept[capability] = false;
      // Without read there is no safe way to edit, so write follows read down.
      if (!value && capability === 'read' && root.capabilities.write) {
        root.capabilities.write = false;
        root.autoAccept.write = false;
      }
      root.updatedAt = clock();
      record({ action: value ? 'grant' : 'revoke', rootId: root.id, capability });
      return publicRoot(root);
    });
  }

  /** Auto-accept skips the per-call dialog; enabling it needs its own confirmation. */
  async function setAutoAccept(input = {}) {
    const { rootId, capability, value, win } = input;
    if (!APPROVAL_CAPABILITIES.includes(capability)) throw new PermissionError('unknown-capability');
    if (typeof value !== 'boolean') throw new PermissionError('request');
    return mutate(async current => {
      const root = find(current, rootId);
      if (!root.capabilities[capability]) throw new PermissionError('not-granted');
      if (value && !root.autoAccept[capability]) {
        const decision = await confirm({
          mode: 'grant',
          win,
          title: `不再逐次确认${CAPABILITY_LABELS[capability]}？`,
          message: `${root.name} · 自动接受${CAPABILITY_LABELS[capability]}`,
          detail: `${root.path}\n\n开启后，模型在这个文件夹内的每次${CAPABILITY_LABELS[capability]}都不再询问你。操作仍会记录在权限审计日志中。`,
        });
        if (decision !== 'allow') throw new PermissionError('denied');
      }
      root.autoAccept[capability] = value;
      root.updatedAt = clock();
      record({ action: value ? 'auto-accept' : 'auto-accept-off', rootId: root.id, capability });
      return publicRoot(root);
    });
  }

  /** Reads the composer-level approval mode plus the per-call policy it implies. */
  async function getPreset() {
    const current = await load();
    const preset = normalizePreset(current.preset);
    return { preset, autoAccept: { ...PRESET_AUTO_ACCEPT[preset] } };
  }

  /**
   * Sets the composer-level approval mode. `auto` / `full` persist read+write
   * (full also exec) on every registered root, and a `full` request includes all
   * of them, across projects. It still cannot register a new folder or escape
   * `resolveInside`, so files outside the registered folders remain unreachable
   * through file tools. Choosing full is an explicit user action.
   */
  async function setPreset(input = {}) {
    const request = /** @type {{ preset?: string, win?: any }} */ (typeof input === 'string' ? { preset: input } : input || {});
    // The composer speaks auto_review/full_access; the store uses auto/full.
    const aliases = { auto_review: 'auto', full_access: 'full', request: 'default' };
    const preset = aliases[request.preset] || request.preset;
    const win = request.win;
    if (!PRESETS.includes(preset)) throw new PermissionError('unknown-preset');
    return mutate(next => {
      next.preset = preset;
      // The composer switch is an explicit user action. "auto" and "full"
      // must actually make CodeMova able to edit, otherwise the label lies.
      for (const root of next.roots) {
        if (preset === 'auto' || preset === 'full') {
          root.capabilities.read = true;
          root.capabilities.write = true;
        }
        if (preset === 'full') root.capabilities.exec = true;
      }
      record({ action: 'preset', preset });
      return { preset, roots: next.roots.map(publicRoot) };
    });
  }

  async function revoke(rootId) {
    return mutate(current => {
      const root = find(current, rootId);
      for (const capability of CAPABILITIES) root.capabilities[capability] = false;
      for (const capability of APPROVAL_CAPABILITIES) root.autoAccept[capability] = false;
      root.updatedAt = clock();
      for (const key of [...sessions]) if (key.includes(`\0${root.id}\0`)) sessions.delete(key);
      record({ action: 'revoke-all', rootId: root.id });
      return publicRoot(root);
    });
  }

  async function forget(rootId) {
    return mutate(current => {
      current.roots = current.roots.filter(root => root.id !== rootId);
      for (const key of [...sessions]) if (key.includes(`\0${rootId}\0`)) sessions.delete(key);
      record({ action: 'forget', rootId });
      return { version: 1, preset: normalizePreset(current.preset), roots: current.roots.map(publicRoot) };
    });
  }

  function grantSession(sessionKey, rootId, capability) {
    if (typeof sessionKey !== 'string' || !CAPABILITIES.includes(capability)) return;
    sessions.add(sessionKeyOf(sessionKey, rootId, capability));
  }

  function hasSession(sessionKey, rootId, capability) {
    return typeof sessionKey === 'string' && sessions.has(sessionKeyOf(sessionKey, rootId, capability));
  }

  function clearSession(sessionKey) {
    for (const key of [...sessions]) if (key.startsWith(`${sessionKey}\0`)) sessions.delete(key);
  }

  function clearSessions(prefix) {
    for (const key of [...sessions]) if (key.startsWith(`${prefix}\0`) || key.startsWith(`${prefix}:`)) sessions.delete(key);
  }

  /**
   * Decides one tool call. `read` is a capability check; `write` and `exec`
   * additionally need a session grant, an auto-accept setting, or a per-call
   * native confirmation.
   */
  async function authorize(input = {}) {
    const { rootId, capability, sessionKey, win, signal, summary, detail, preview } = input;
    if (!CAPABILITIES.includes(capability)) return { ok: false, reason: 'unknown-capability' };
    const current = await load();
    const root = current.roots.find(item => item.id === rootId);
    if (!root) return { ok: false, reason: 'not-registered' };
    if (!effectiveProjectCapabilities(root.capabilities, input.approvalPreset)[capability]) {
      record({ action: 'denied', rootId, capability, via: 'capability', summary });
      return { ok: false, reason: 'not-granted' };
    }
    if (capability === 'read') return { ok: true, via: 'capability' };
    if (hasSession(sessionKey, root.id, capability)) return { ok: true, via: 'session' };
    if (root.autoAccept[capability]) {
      record({ action: 'allowed', rootId, capability, via: 'auto', summary });
      return { ok: true, via: 'auto' };
    }
    const preset = normalizePreset(input.approvalPreset ?? current.preset);
    if (PRESET_AUTO_ACCEPT[preset][capability]) {
      record({ action: 'allowed', rootId, capability, via: 'preset', preset, summary });
      return { ok: true, via: 'preset' };
    }
    const decision = await confirm({
      mode: 'approval',
      sessionKey,
      win,
      signal,
      capability,
      // Opaque ids only: the bar uses them for follow-up lookups, and the root
      // path still travels in `detail` exactly as before.
      rootId: root.id,
      rootName: root.name,
      title: `允许${CAPABILITY_LABELS[capability]}？`,
      message: summary || CAPABILITY_LABELS[capability],
      detail: `${detail ? `${detail}\n\n` : ''}项目：${root.name}\n文件夹：${root.path}`,
      preview: preview ?? null,
    });
    if (decision === 'session') {
      // The capability may have been revoked while the dialog was open; a
      // session grant must not survive to re-arm it later.
      const latest = await load();
      const still = latest.roots.find(item => item.id === rootId)?.capabilities?.[capability] === true;
      if (!still) {
        record({ action: 'denied', rootId, capability, via: 'revoked', summary });
        return { ok: false, reason: 'not-granted' };
      }
      grantSession(sessionKey, root.id, capability);
    } else if (decision !== 'once') {
      // Anything that is not an explicit approval is a refusal.
      record({ action: 'denied', rootId, capability, via: 'user', summary });
      return { ok: false, reason: 'denied' };
    }
    record({ action: 'allowed', rootId, capability, via: decision === 'session' ? 'session' : 'once', summary });
    return { ok: true, via: decision === 'session' ? 'session' : 'once' };
  }

  /**
   * Capability-only re-check against the live store, without any prompt. Tool
   * code calls this again right before mutating, so a revocation that happens
   * while a confirmation is open still stops the write.
   */
  async function check(input = {}) {
    const { rootId, capability } = input;
    if (!CAPABILITIES.includes(capability)) return { ok: false, reason: 'unknown-capability' };
    const current = await load();
    const root = current.roots.find(item => item.id === rootId);
    if (!root) return { ok: false, reason: 'not-registered' };
    if (!effectiveProjectCapabilities(root.capabilities, input.approvalPreset)[capability]) return { ok: false, reason: 'not-granted' };
    return { ok: true };
  }

  return {
    list, get, register, setCapability, setAutoAccept, revoke, forget,
    getPreset, setPreset,
    grantSession, clearSession, clearSessions, authorize, check,
  };
}

/** Appends one JSON line per decision. Best effort: auditing never blocks a tool. */
function createAuditLog(filePath) {
  return async entry => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* Ignore: the operation already happened or was refused. */ }
  };
}

function installPermissionsIpc(authorize, options = {}) {
  const ipcMain = options.ipcMain || require('electron').ipcMain;
  const store = options.store;
  if (!store) throw new TypeError('store is required');
  // Resolved lazily so tests never need Electron's shell module.
  const openPath = options.openPath || (path => require('electron').shell.openPath(path));
  const operations = {
    'permissions:list': () => store.list(),
    'permissions:register': (input, win) => store.register(input?.folders ?? [], { confirm: true, win }),
    'permissions:set': (input, win) => store.setCapability({ ...input, win }),
    'permissions:set-auto': (input, win) => store.setAutoAccept({ ...input, win }),
    'permissions:preset': () => store.getPreset(),
    'permissions:set-preset': (input, win) => store.setPreset({ preset: input?.preset ?? input, win }),
    'permissions:revoke': input => store.revoke(input?.rootId ?? input),
    'permissions:forget': input => store.forget(input?.rootId ?? input),
    // User-initiated only: opens a folder the user already registered. The
    // renderer still cannot name a path — it passes the opaque root id.
    'permissions:reveal': async input => {
      const root = await store.get(input?.rootId ?? input);
      if (!root) throw new PermissionError('not-registered');
      const error = await openPath(root.path);
      if (error) throw new PermissionError('not-found', '无法打开文件夹');
      return { revealed: true };
    },
  };
  for (const [channel, operation] of Object.entries(operations)) {
    ipcMain.handle(channel, async (event, ...args) => {
      let win;
      try { win = authorize(event); } catch { return { ok: false, error: 'unauthorized' }; }
      try { return { ok: true, value: await operation(...args, win) }; }
      catch (error) { return { ok: false, error: error instanceof PermissionError ? error.code : 'store-error' }; }
    });
  }
  return store;
}

module.exports = {
  CAPABILITIES, APPROVAL_CAPABILITIES, CAPABILITY_LABELS, IGNORED_WRITE_SEGMENTS,
  PermissionError, canonicalPath, isInside, resolveInside,
  createPermissionStore, createAuditLog, installPermissionsIpc,
  effectiveProjectCapabilities,
};
