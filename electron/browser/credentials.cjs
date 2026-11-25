'use strict';
// Browser credentials live in the existing encrypted vault (`secret-vault`).
// The renderer may type a password into the login card, but it never receives a
// saved value back: filling always happens here, through CDP Input.insertText.

const { press } = require('./actions.cjs');

const PREFIX = 'browser:';
const MAX_USER = 200;
const MAX_PASSWORD = 1000;

function coded(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

function parseValue(raw) {
  const text = String(raw || '');
  const index = text.indexOf('\n');
  return index < 0 ? { username: '', password: text } : { username: text.slice(0, index), password: text.slice(index + 1) };
}

function maskUsername(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 2) return '**';
  return `${text[0]}***${text[text.length - 1]}`;
}

function validate(input) {
  if (!input || typeof input !== 'object') throw coded('invalid-input', 'credentials are required');
  const origin = normalizeOrigin(input.origin);
  if (!origin) throw coded('invalid-origin', '只有 http(s) 页面可以保存登录信息');
  if (typeof input.username !== 'string' || input.username.length > MAX_USER) throw coded('invalid-input', 'username');
  if (typeof input.password !== 'string' || !input.password || input.password.length > MAX_PASSWORD) throw coded('invalid-input', 'password');
  if (/[\r\n]/.test(input.username) || /[\r\n]/.test(input.password)) throw coded('invalid-input', 'credentials cannot contain newlines');
  return { origin, username: input.username, password: input.password };
}

function createCredentialBroker({ getVault } = {}) {
  async function vault() {
    const value = typeof getVault === 'function' ? getVault() : getVault;
    if (!value || typeof value.put !== 'function' || typeof value.get !== 'function') {
      throw coded('vault-unavailable', '记忆保险柜不可用（需要服务模式）');
    }
    return value;
  }

  async function status() {
    try {
      const service = await vault();
      const value = await service.status();
      return { ok: true, ...value };
    } catch (error) {
      return { ok: false, code: error?.code || 'vault-unavailable', message: error?.message || '记忆保险柜不可用' };
    }
  }

  async function list() {
    const service = await vault();
    const rows = await service.list();
    return (Array.isArray(rows) ? rows : [])
      .filter(row => typeof row?.name === 'string' && row.name.startsWith(PREFIX))
      .map(row => ({ origin: row.name.slice(PREFIX.length), updatedAt: row.updatedAt || null, preview: row.preview || '' }));
  }

  async function save(input) {
    const { origin, username, password } = validate(input);
    const service = await vault();
    const metadata = await service.put({ name: `${PREFIX}${origin}`, kind: 'password', value: `${username}\n${password}` });
    return { ok: true, origin, username: maskUsername(username), updatedAt: metadata?.updatedAt || null };
  }

  async function read(origin) {
    const key = normalizeOrigin(origin);
    if (!key) throw coded('invalid-origin', 'invalid origin');
    const service = await vault();
    let raw;
    try {
      raw = await service.get(`${PREFIX}${key}`);
    } catch (error) {
      if (error?.code === 'not-found' || /not-found/.test(error?.message || '')) throw coded('credential-missing', '这个站点还没有保存登录信息');
      if (error?.code === 'vault-locked') throw coded('vault-locked', '记忆保险柜已锁定，请先解锁');
      throw coded(error?.code || 'vault-error', error?.message || '无法读取保险柜');
    }
    return { origin: key, ...parseValue(raw) };
  }

  async function has(origin) {
    const key = normalizeOrigin(origin);
    if (!key) return false;
    try {
      await read(key);
      return true;
    } catch {
      return false;
    }
  }

  async function fill(target, options = {}) {
    if (!target || !target.cdp) throw coded('no-target', 'no active browser page');
    const origin = normalizeOrigin(options.origin || target.url);
    if (!origin) throw coded('invalid-origin', 'only http(s) pages can use saved logins');
    const current = normalizeOrigin(target.url);
    if (current !== origin) throw coded('origin-mismatch', '页面已经跳转到其他站点，已停止填充', { expected: origin, current });

    const credentials = options.credentials || await read(origin);

    const passwordField = await target.cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('input[type="password"]')`,
      returnByValue: false,
    });
    if (!passwordField.result?.objectId) throw coded('login-form-not-found', '当前页面没有找到登录密码框');

    const userField = await target.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const pwd = document.querySelector('input[type="password"]');
        if (!pwd) return null;
        const form = pwd.form || document;
        const candidates = [...form.querySelectorAll('input[type="text"],input[type="email"],input[autocomplete="username"],input[name*="user" i],input[id*="user" i]')]
          .filter(el => el.offsetParent !== null && !el.disabled && !el.readOnly);
        const before = candidates.filter(el => el.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING);
        return before[0] || candidates[0] || null;
      })()`,
      returnByValue: false,
    });

    async function setValue(objectId, value) {
      if (!objectId || typeof value !== 'string' || !value) return;
      await target.cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function (value) {
          const tag = this.tagName ? this.tagName.toLowerCase() : '';
          if (this.isContentEditable) this.textContent = value;
          else {
            const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(this, value); else this.value = value;
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return this.value ?? this.textContent;
        }`,
        arguments: [{ value }],
        returnByValue: true,
      });
    }
    await setValue(userField.result?.objectId, credentials.username);
    await setValue(passwordField.result.objectId, credentials.password);

    if (options.submit === true) {
      const submitted = await target.cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const pwd = document.querySelector('input[type="password"]');
          const form = pwd && pwd.form;
          const button = form && form.querySelector('button[type="submit"],input[type="submit"]');
          if (button) { button.click(); return 'button'; }
          if (form && form.requestSubmit) { form.requestSubmit(); return 'form'; }
          return 'enter';
        })()`,
        returnByValue: true,
      });
      if (submitted.result?.value === 'enter') await press(target.cdp, 'Enter');
    }
    return {
      ok: true,
      origin,
      username: maskUsername(credentials.username),
      submitted: options.submit === true,
    };
  }

  return { status, list, save, read, has, fill, normalizeOrigin };
}

module.exports = { createCredentialBroker, normalizeOrigin, maskUsername, parseValue, PREFIX };
