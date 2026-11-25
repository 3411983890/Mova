'use strict';
// Encrypted per-origin login records: cookies + localStorage captured after a
// successful login, offered again when a later conversation visits the site.

const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : '';
  } catch { return ''; }
}

function createLoginRecords({ app, safeStorage } = {}) {
  if (!app || !safeStorage) throw new TypeError('app and safeStorage are required');
  const dir = join(app.getPath('userData'), 'browser');
  const file = join(dir, 'login-records.enc');

  function guard() {
    if (safeStorage.isEncryptionAvailable?.() === false) throw coded('encryption-unavailable', '系统加密不可用');
  }

  async function readAll() {
    guard();
    try {
      const encrypted = await readFile(file, 'utf8');
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      return {};
    }
  }

  async function writeAll(records) {
    guard();
    await mkdir(dir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(records)).toString('base64');
    await writeFile(file, encrypted, { mode: 0o600 });
  }

  /** 记录范围：scope 为空串表示「所有对话」，任何会话都能复用；否则只在同一会话内复用。 */
  const scopeKey = conversationId => (conversationId == null ? '' : String(conversationId));
  const matchesScope = (record, conversationId) => {
    const scope = record?.scope ?? '';
    return scope === '' || scope === scopeKey(conversationId);
  };

  async function has(origin, conversationId) {
    const records = await readAll();
    // 调用方可能传完整 URL，和 save/apply 一样先归一化成 origin。
    const record = records[originOf(origin) || origin];
    return Boolean(record?.cookies?.length) && matchesScope(record, conversationId);
  }

  async function save(origin, target, { conversationId } = {}) {
    const normalized = originOf(origin || target?.url);
    if (!normalized) throw coded('invalid-origin', 'only http(s) pages can remember cookies');
    const cookies = await target.guest.session.cookies.get({ url: normalized });
    const raw = await target.evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))');
    let localStorage = {};
    try { localStorage = JSON.parse(raw || '{}'); } catch { localStorage = {}; }
    const records = await readAll();
    records[normalized] = { origin: normalized, cookies, localStorage, scope: scopeKey(conversationId), savedAt: new Date().toISOString() };
    await writeAll(records);
    return { ok: true, origin: normalized, cookies: cookies.length, localStorageKeys: Object.keys(localStorage).length };
  }

  async function apply(origin, target, { conversationId } = {}) {
    const normalized = originOf(origin || target?.url);
    const records = await readAll();
    const record = records[normalized];
    if (!record?.cookies?.length) throw coded('login-record-missing', '没有可用的 Cookie 登录记录');
    if (!matchesScope(record, conversationId)) throw coded('login-record-other-conversation', '该登录记录属于另一个对话');
    for (const cookie of record.cookies) {
      const host = String(cookie.domain || '').replace(/^\./, '');
      const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
      try {
        await target.guest.session.cookies.set({
          url, name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
          secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
          ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
        });
      } catch { /* skip bad cookie */ }
    }
    const entries = record.localStorage && typeof record.localStorage === 'object' ? record.localStorage : {};
    await target.evaluate(`(() => { const data = ${JSON.stringify(entries)}; for (const [key, value] of Object.entries(data)) localStorage.setItem(key, String(value)); return true; })()`);
    return { ok: true, origin: normalized, cookies: record.cookies.length, localStorageKeys: Object.keys(entries).length };
  }

  return { has, save, apply, originOf, file };
}

module.exports = { createLoginRecords, originOf };
