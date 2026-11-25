'use strict';
// Element resolution and real input. Refs decode to backendDOMNodeId, then
// DOM.resolveNode gives an object we can inspect and drive through CDP input.

const REF = /^@?(?:f\d+:)?e([0-9a-z]+)$/i;
const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

function coded(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

function parseRef(target) {
  if (typeof target !== 'string') return null;
  const match = REF.exec(target.trim());
  if (!match) return null;
  const id = Number.parseInt(match[1], 36);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseSelector(target) {
  if (typeof target !== 'string') return null;
  const value = target.trim();
  if (value.startsWith('css=')) return value.slice(4).trim();
  if (value.startsWith('#' ) || value.startsWith('.') || value.startsWith('[') || value.startsWith('*')) return value;
  return null;
}

async function resolveElement(cdp, target) {
  const backendNodeId = parseRef(target);
  if (backendNodeId) {
    try {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
      if (object?.objectId) return object.objectId;
    } catch {
      throw coded('stale-ref', '元素已失效，请重新 snapshot', { target });
    }
    throw coded('stale-ref', '元素已失效，请重新 snapshot', { target });
  }
  const selector = parseSelector(target);
  if (!selector) throw coded('target-not-found', 'target must be @ref or css=selector', { target });
  const result = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  const objectId = result.result?.objectId;
  if (!objectId) throw coded('target-not-found', `no element for ${selector}`, { target });
  return objectId;
}

const DESCRIBE = `function () {
  const style = getComputedStyle(this);
  const rect = this.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const tag = this.tagName ? this.tagName.toLowerCase() : '';
  // Coordinates are sent to the top-level viewport. Same-origin frames can
  // report their offset; cross-origin frames throw and fall back to local
  // coordinates (a later OOPIF session will fix that).
  let offsetX = 0;
  let offsetY = 0;
  let crossFrame = false;
  try {
    let view = window;
    while (view && view.frameElement) {
      const frameRect = view.frameElement.getBoundingClientRect();
      offsetX += frameRect.x;
      offsetY += frameRect.y;
      view = view.parent;
    }
  } catch { crossFrame = true; }
  const cssPath = element => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.getAttribute && node.getAttribute('data-testid')) return '[data-testid="' + node.getAttribute('data-testid').replace(/"/g, '\\"') + '"]';
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = tagName(node);
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(child => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const tagName = element => element.tagName.toLowerCase();
  return {
    tag,
    type: this.type || '',
    role: this.getAttribute ? this.getAttribute('role') : null,
    label: this.getAttribute ? (this.getAttribute('aria-label') || '') : '',
    text: (this.innerText || '').trim().slice(0, 80),
    selector: cssPath(this),
    crossFrame,
    rect: { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height },
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0,
    disabled: this.disabled === true || this.getAttribute('aria-disabled') === 'true',
    readonly: this.readOnly === true || this.getAttribute('aria-readonly') === 'true',
    checked: typeof this.checked === 'boolean' ? this.checked : null,
    editable: this.isContentEditable === true || ['input', 'textarea', 'select'].includes(tag),
    covered: !(hit === this || this.contains(hit) || (hit && hit.contains(this))),
  };
}`;

async function describe(cdp, objectId) {
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: DESCRIBE,
    returnByValue: true,
  });
  const value = result.result?.value;
  if (!value) throw coded('target-not-found', 'element is gone');
  return value;
}

async function prepare(cdp, objectId) {
  await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "center" }); return true; }',
    returnByValue: true,
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  const info = await describe(cdp, objectId);
  if (!info.visible) throw coded('not-visible', '元素不可见', info);
  if (info.disabled) throw coded('disabled', '元素被禁用', info);
  if (info.covered) throw coded('covered', '元素被其他元素遮挡', info);
  return info;
}

async function click(cdp, target, options = {}) {
  const objectId = await resolveElement(cdp, target);
  const info = await prepare(cdp, objectId);
  if (info.crossFrame) {
    // 跨域框架无法把偏移上报到顶层视口。设置允许时在框架自己的上下文里派发点击；
    // 关闭兜底则明确拒绝，而不是猜一个坐标。
    if (options.iframeFallback === false) {
      throw Object.assign(new Error('跨域框架内的元素不支持点击（已在设置中关闭兜底）'), { code: 'cross-origin-frame' });
    }
    // Dispatch inside the frame's own context instead of guessing coordinates.
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { this.click(); return true; }',
      returnByValue: true,
    });
    return { ok: true, action: 'click', target, via: 'dom', element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector } };
  }
  const x = Math.round(info.rect.x + info.rect.width / 2);
  const y = Math.round(info.rect.y + info.rect.height / 2);
  const count = Number.isInteger(options.clickCount) && options.clickCount > 0 ? Math.min(options.clickCount, 3) : 1;
  try {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count });
  } catch (error) {
    if (error?.code === 'timeout') throw error;
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { this.click(); return true; }',
      returnByValue: true,
    });
  }
  return { ok: true, action: 'click', target, element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector }, x, y };
}

async function fill(cdp, target, value, options = {}) {
  if (typeof value !== 'string') throw coded('invalid-argument', 'value must be a string');
  const objectId = await resolveElement(cdp, target);
  const info = await prepare(cdp, objectId);
  if (info.readonly) throw coded('readonly', '元素是只读的', info);

  if (info.tag === 'select') {
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (value) {
        const option = [...this.options].find(item => item.value === value || item.text === value);
        if (!option) return { ok: false };
        this.value = option.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: this.value };
      }`,
      arguments: [{ value }],
      returnByValue: true,
    });
    if (!result.result?.value?.ok) throw coded('target-not-found', 'option not found', { value });
    return { ok: true, action: 'select', target, value: result.result.value.value, element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector } };
  }

  await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { this.focus(); if (this.select) this.select(); return true; }',
    returnByValue: true,
  });

  if (options.slowly === true) {
    for (const character of value) {
      await cdp.send('Input.insertText', { text: character });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { ok: true, action: 'type', target, value, element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector } };
  }

  // Native setter + input/change is what React/Vue controlled inputs expect;
  // it is also much faster than one CDP call per character.
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (value) {
      const tag = this.tagName ? this.tagName.toLowerCase() : '';
      if (this.isContentEditable) {
        this.textContent = value;
      } else if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(this, value); else this.value = value;
      } else {
        return { ok: false };
      }
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: this.value ?? this.textContent };
    }`,
    arguments: [{ value }],
    returnByValue: true,
  });
  if (!result.result?.value?.ok) throw coded('target-not-found', 'element is not fillable', info);
  return { ok: true, action: 'fill', target, value: result.result.value.value, element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector } };
}

async function hover(cdp, target) {
  const objectId = await resolveElement(cdp, target);
  const info = await prepare(cdp, objectId);
  const x = Math.round(info.rect.x + info.rect.width / 2);
  const y = Math.round(info.rect.y + info.rect.height / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  return { ok: true, action: 'hover', target, element: { tag: info.tag, text: info.text, selector: info.selector } };
}

async function upload(cdp, target, files) {
  if (!Array.isArray(files) || files.length === 0) throw coded('invalid-argument', 'files are required');
  const objectId = await resolveElement(cdp, target);
  const info = await describe(cdp, objectId);
  if (info.tag !== 'input' || info.type !== 'file') {
    throw coded('target-not-found', 'target is not a file input', { tag: info.tag, type: info.type });
  }
  await cdp.send('DOM.setFileInputFiles', { files, objectId }, 15000);
  return {
    ok: true,
    action: 'upload',
    target,
    files: files.map(file => file.split(/[\\/]/).pop()),
    element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector },
  };
}

async function uploadViaChooser(cdp, target, files) {
  if (!Array.isArray(files) || files.length === 0) throw coded('invalid-argument', 'files are required');
  const objectId = await resolveElement(cdp, target);
  const info = await prepare(cdp, objectId);
  let unsubscribe = null;
  let timer = null;
  const opened = new Promise((resolve, reject) => {
    timer = setTimeout(() => { if (unsubscribe) unsubscribe(); reject(coded('chooser-timeout', '文件选择器没有打开')); }, 8000);
    unsubscribe = cdp.on((method, params) => {
      if (method !== 'Page.fileChooserOpened') return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(params);
    });
  });
  try {
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { this.click(); return true; }',
      returnByValue: true,
      userGesture: true,
    });
    const event = await opened;
    if (!event?.backendNodeId) throw coded('chooser-failed', '文件选择器没有返回 input');
    await cdp.send('DOM.setFileInputFiles', { files, backendNodeId: event.backendNodeId }, 15000);
    return {
      ok: true,
      action: 'upload',
      target,
      via: 'chooser',
      files: files.map(file => file.split(/[\\/]/).pop()),
      element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector },
    };
  } finally {
    clearTimeout(timer);
    unsubscribe?.();
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, 3000); } catch { /* target may be gone */ }
  }
}

async function press(cdp, key) {
  if (typeof key !== 'string' || !key.trim()) throw coded('invalid-argument', 'key is required');
  const name = key.trim();
  const code = KEY_CODES[name] || name.toUpperCase().charCodeAt(0);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  return { ok: true, action: 'press', key: name };
}

async function check(cdp, target, desired) {
  const objectId = await resolveElement(cdp, target);
  const info = await prepare(cdp, objectId);
  if (typeof info.checked !== 'boolean') throw coded('target-not-found', 'element is not a checkbox', info);
  if (info.checked !== desired) return click(cdp, target);
  return { ok: true, action: 'check', target, checked: info.checked, element: { tag: info.tag, type: info.type, text: info.text, selector: info.selector } };
}

async function scroll(cdp, target, value) {
  const amount = Number(value ?? 600);
  if (!Number.isFinite(amount)) throw new Error('Scroll requires a signed pixel distance.');
  const distance = Math.max(-2500, Math.min(2500, amount));
  const move = `function () {
    const before = this.scrollTop;
    this.scrollBy({ top: ${distance}, behavior: 'instant' });
    return { before, after: this.scrollTop };
  }`;
  if (!target) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(${move}).call(document.scrollingElement)`, returnByValue: true,
    });
    return { ok: true, action: 'scroll', scroll: result.value };
  }
  const objectId = await resolveElement(cdp, target);
  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: move, returnByValue: true,
    });
    return { ok: true, action: 'scroll', scroll: result.value };
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

module.exports = { click, fill, press, hover, check, scroll, upload, uploadViaChooser, describe, resolveElement, parseRef, parseSelector };
