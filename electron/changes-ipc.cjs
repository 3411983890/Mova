'use strict';
const { readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { PermissionError, resolveInside } = require('./permissions.cjs');

// Read-only IPC for the change history the chat agent already records.
//
// The renderer is untrusted: it names an opaque root id and a relative path, and
// every answer is derived from `<userData>/file-history/<rootId>.json` alone.
// Nothing here reads, writes or repairs a project file, and a corrupt history
// file is reported as unreadable instead of being replaced.
const LIMITS = Object.freeze({
  previewLines: 300,
  previewChars: 100_000,
  listedChanges: 100,
  changeIdLength: 80,
});

/**
 * One side of a diff, clipped by lines and then by characters — the same budget
 * `clipSide` in agent-tools.cjs uses for approvals, so the history view and the
 * approval preview never disagree about what "truncated" means.
 */
function clipSide(value) {
  if (value == null) return { text: null, truncated: false };
  const text = String(value);
  const lines = text.split('\n');
  let clipped = lines.length > LIMITS.previewLines ? lines.slice(0, LIMITS.previewLines).join('\n') : text;
  let truncated = lines.length > LIMITS.previewLines;
  if (clipped.length > LIMITS.previewChars) {
    clipped = clipped.slice(0, LIMITS.previewChars);
    truncated = true;
  }
  return { text: clipped, truncated };
}

function isChangeId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= LIMITS.changeIdLength;
}

function summarize(entry) {
  return {
    id: entry.id,
    time: Number(entry.time) || 0,
    path: typeof entry.path === 'string' ? entry.path : '',
    kind: typeof entry.kind === 'string' ? entry.kind : 'write',
    // Lengths only: the renderer must ask for `diff` to see content.
    bytes: entry.after?.length ?? entry.before?.length ?? 0,
  };
}

/**
 * @param {{
 *   permissions: { get: (rootId: string) => Promise<any> },
 *   historyDir?: string | (() => string),
 *   audit?: (entry: any) => void,
 *   shell?: () => any,
 * }} options
 */
function createChangesIpc(options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  const permissions = options.permissions;
  if (!permissions || typeof permissions.get !== 'function') throw new TypeError('permissions is required');
  const rawHistoryDir = options.historyDir;
  const resolveHistoryDir = () => (typeof rawHistoryDir === 'function' ? rawHistoryDir() : String(rawHistoryDir ?? ''));
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  // Resolved lazily so tests never need Electron's shell module.
  const shellProvider = typeof options.shell === 'function' ? options.shell : () => require('electron').shell;

  function record(entry) {
    try { audit(entry); } catch { /* Auditing must never break a read-only call. */ }
  }

  function historyFile(rootId) {
    return join(resolveHistoryDir(), `${rootId}.json`);
  }

  /** Reads one root's history. A missing file is an empty history; a corrupt one is an error we never "fix". */
  async function readHistory(rootId) {
    let raw;
    try {
      raw = await readFile(historyFile(rootId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new PermissionError('history-unreadable');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PermissionError('history-unreadable');
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new PermissionError('history-unreadable');
    return parsed.entries.filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string');
  }

  async function registeredRoot(rootId) {
    if (typeof rootId !== 'string' || !rootId) return null;
    return permissions.get(rootId);
  }

  /** Recent changes for one project root, newest first, with no file content. */
  async function list(input = {}) {
    const root = await registeredRoot(input?.rootId);
    if (!root) return { ok: false, error: 'not-registered' };
    let entries;
    try {
      entries = await readHistory(root.id);
    } catch (error) {
      return { ok: false, error: error instanceof PermissionError ? error.code : 'history-unreadable' };
    }
    const changes = entries
      .map(summarize)
      .sort((a, b) => b.time - a.time)
      .slice(0, LIMITS.listedChanges);
    return { ok: true, value: { changes } };
  }

  /**
   * One recorded change, both sides clipped. Content comes from the history file
   * only: the current file on disk may have moved on, and showing it as "before"
   * would misreport what the app actually did.
   */
  async function diff(input = {}) {
    const changeId = input?.changeId;
    if (!isChangeId(changeId)) return { ok: false, error: 'invalid-arguments' };
    const root = await registeredRoot(input?.rootId);
    if (!root) return { ok: false, error: 'not-registered' };
    let entries;
    try {
      entries = await readHistory(root.id);
    } catch (error) {
      return { ok: false, error: error instanceof PermissionError ? error.code : 'history-unreadable' };
    }
    const entry = entries.find(item => item.id === changeId);
    if (!entry) return { ok: false, error: 'not-found' };
    const head = clipSide(entry.before);
    const tail = clipSide(entry.after);
    return {
      ok: true,
      value: {
        id: entry.id,
        time: Number(entry.time) || 0,
        path: typeof entry.path === 'string' ? entry.path : '',
        kind: typeof entry.kind === 'string' ? entry.kind : 'write',
        before: head.text,
        after: tail.text,
        truncated: head.truncated || tail.truncated,
      },
    };
  }

  /** Shows one existing file or folder inside a registered root in the OS file manager. */
  async function reveal(input = {}) {
    const root = await registeredRoot(input?.rootId);
    if (!root) return { ok: false, error: 'not-registered' };
    let abs;
    try {
      abs = await resolveInside(root.path, input?.path);
    } catch (error) {
      return { ok: false, error: error instanceof PermissionError ? error.code : 'invalid-path' };
    }
    let info;
    try {
      info = await stat(abs);
    } catch {
      return { ok: false, error: 'not-found' };
    }
    if (!info.isFile() && !info.isDirectory()) return { ok: false, error: 'not-found' };
    try {
      const shell = shellProvider();
      shell.showItemInFolder(abs);
    } catch {
      return { ok: false, error: 'reveal-failed' };
    }
    record({ action: 'reveal', rootId: root.id, path: input.path });
    return { ok: true, value: { revealed: true } };
  }

  return { list, diff, reveal };
}

/**
 * Registers the three read-only channels. `authorizeSender` is the main process'
 * own frame check; a rejected sender learns nothing beyond `unauthorized`, and
 * an internal failure is reported as `ipc-failed` so no stack or absolute path
 * can reach the renderer.
 */
function installChangesIpc(ipcMain, changes, authorizeSender) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain is required');
  if (!changes || typeof changes !== 'object') throw new TypeError('changes is required');
  if (typeof authorizeSender !== 'function') throw new TypeError('authorizeSender is required');
  const operations = {
    'changes:list': 'list',
    'changes:diff': 'diff',
    'changes:reveal': 'reveal',
  };
  for (const [channel, method] of Object.entries(operations)) {
    ipcMain.handle(channel, async (event, args) => {
      try { authorizeSender(event); } catch { return { ok: false, error: 'unauthorized' }; }
      try {
        if (typeof changes[method] !== 'function') throw new TypeError('missing operation');
        return await changes[method](args);
      } catch {
        return { ok: false, error: 'ipc-failed' };
      }
    });
  }
  return changes;
}

module.exports = { LIMITS, clipSide, createChangesIpc, installChangesIpc };
