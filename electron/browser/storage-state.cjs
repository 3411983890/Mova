'use strict';
// Encrypted storageState for the active origin. Export/import is user-triggered
// and never returns cookie/localStorage values to the model.

const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const VERSION = 1;

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : '';
  } catch {
    return '';
  }
}

function createStorageState({ app, safeStorage } = {}) {
  if (!app || !safeStorage) throw new TypeError('app and safeStorage are required');
  const file = join(app.getPath('userData'), 'browser', 'storage-state.enc');

  function guard() {
    if (safeStorage.isEncryptionAvailable?.() === false) throw coded('encryption-unavailable', '系统加密不可用');
  }

  async function exportState(target) {
    guard();
    const origin = originOf(target?.url);
    if (!origin) throw coded('invalid-origin', 'only http(s) pages can export storage');
    const cookies = await target.guest.session.cookies.get({ url: origin });
    const raw = await target.evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))');
    let localStorageData = {};
    try { localStorageData = JSON.parse(raw || '{}'); } catch { localStorageData = {}; }
    const state = {
      version: VERSION,
      origin,
      exportedAt: new Date().toISOString(),
      cookies,
      localStorage: localStorageData,
    };
    await mkdir(join(app.getPath('userData'), 'browser'), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(state)).toString('base64');
    await writeFile(file, encrypted, { mode: 0o600 });
    return {
      ok: true,
      origin,
      path: file,
      cookies: cookies.length,
      localStorageKeys: Object.keys(localStorageData).length,
      bytes: encrypted.length,
    };
  }

  async function importState(target) {
    guard();
    let encrypted;
    try { encrypted = await readFile(file, 'utf8'); } catch { throw coded('storage-state-missing', '还没有导出的登录态'); }
    let state;
    try { state = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))); } catch { throw coded('storage-state-invalid', '登录态无法解密'); }
    if (!state || state.version !== VERSION || !Array.isArray(state.cookies)) throw coded('storage-state-invalid', '登录态格式不支持');
    const origin = originOf(target?.url);
    if (origin !== state.origin) throw coded('origin-mismatch', '登录态属于其他站点', { expected: state.origin, current: origin });

    for (const cookie of state.cookies) {
      const url = `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`;
      try {
        await target.guest.session.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
        });
      } catch { /* one bad cookie must not block the rest */ }
    }
    const entries = state.localStorage && typeof state.localStorage === 'object' ? state.localStorage : {};
    await target.evaluate(`(() => { const data = ${JSON.stringify(entries)}; for (const [key, value] of Object.entries(data)) localStorage.setItem(key, String(value)); return true; })()`);
    return {
      ok: true,
      origin,
      cookies: state.cookies.length,
      localStorageKeys: Object.keys(entries).length,
    };
  }

  return { exportState, importState, file };
}

module.exports = { createStorageState, originOf };
