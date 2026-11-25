/* 网页内选择（选区 + 元素）的渲染层桥（方案 §3.10 / §3.11 / §4.5）。

   页内脚本注入、binding、nonce 校验都在主进程（electron/browser/inspect.cjs，
   已完成）。渲染层只做三件事：
     1. 三个动作：arm（只开选区上报）/ startPicker（进入元素选择）/ stop；
     2. 校验事件、按 tabId 过滤，把 guest 视口坐标换算成宿主坐标；
     3. 导航 / 刷新立即复位（浮层隐藏、按钮抬起）。

   事件载荷（主进程 → 渲染层）：
     { type:'selection'|'element'|'exit', nonce, tabId, text?, rect?, element?, url?, title? }
   `rect` 是 guest 视口坐标 { x, y, w, h }，这里加上 webview 的
   getBoundingClientRect() 变成宿主视口坐标，交给 quote.js 定位浮层。

   隐私兜底：不读 input.value；元素里来自密码框的文本一律丢弃（主进程已过滤）。
*/

const EVENT_TYPES = new Set(['selection', 'element', 'exit']);
const MAX_TEXT = 1000;
const MAX_NAME = 280;
const MAX_SELECTOR = 200;
const MAX_ID = 120;
const MAX_CLASS = 200;
const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** 注入失败的兜底文案（§3.10：不静默失败）。 */
const SELECTION_HINT = '此页面不支持直接引用选区，可改用「选择页面元素」';
const PICKER_HINT = '无法在页面中选择元素，请先关闭开发者工具或刷新页面后重试';

function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 主进程已归一化，这里再兜一次：任何字段都可能被恶意页面伪造。 */
export function sanitizeElement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const tag = String(input.tag ?? '').trim().toLowerCase();
  if (!TAG_PATTERN.test(tag)) return null;
  const password = tag === 'input'
    && (String(input.type ?? input.inputType ?? '').toLowerCase() === 'password' || input.password === true);
  const element = { tag };
  const id = clip(input.id, MAX_ID);
  if (id) element.id = id;
  const className = clip(input.className, MAX_CLASS);
  if (className) element.className = className;
  const role = clip(input.role, 60);
  if (role) element.role = role;
  const ariaLabel = clip(input.ariaLabel, MAX_NAME);
  if (ariaLabel) element.ariaLabel = ariaLabel;
  // 密码框连文本都不留：宁可不显示，也不要把 value 的痕迹带进浮层 / 引用。
  const text = password ? '' : clip(input.text, MAX_NAME);
  if (text) element.text = text;
  const selector = clip(input.selector, MAX_SELECTOR);
  if (selector) element.selector = selector;
  return element;
}

/**
 * guest 视口矩形 → 宿主视口矩形。
 * @param {{x?:number, y?:number, w?:number, h?:number}} rect
 * @param {{left?:number, top?:number}} box webview.getBoundingClientRect()
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
export function offsetRect(rect, box) {
  if (!rect || typeof rect !== 'object') return null;
  const x = finite(rect.x);
  const y = finite(rect.y);
  const left = finite(box?.left);
  const top = finite(box?.top);
  if (x == null || y == null || left == null || top == null) return null;
  return {
    left: left + x,
    top: top + y,
    width: Math.max(0, finite(rect.w) ?? 0),
    height: Math.max(0, finite(rect.h) ?? 0),
  };
}

function failureOf(error, mode) {
  const code = String(error?.code ?? '').trim();
  const message = String(error?.message ?? error ?? '').trim();
  if (/开发者工具|devtools/i.test(message)) {
    return { code: code || 'inspect-unavailable', message: '请先关闭开发者工具，再重新选择页面元素' };
  }
  return { code: code || 'inspect-unavailable', message: mode === 'picker' ? PICKER_HINT : SELECTION_HINT };
}

/**
 * 挂载网页内选择桥。
 * @param {{
 *   getWebview?: () => (Element|null),
 *   onSelection?: (payload: { text: string, rect: object|null, url: string, title: string, source: object }) => void,
 *   onElement?: (payload: { element: object, rect: object|null, url: string, title: string, source: object }) => void,
 *   onExit?: (payload: { reason: 'exit'|'navigate', tabId: string, url: string, title: string }) => void,
 *   onPickerChange?: (picking: boolean) => void,
 *   onError?: (payload: { code: string, message: string }) => void,
 *   bridge?: object,
 * }} options
 */
export function mountWebInspect(options = {}) {
  const getWebview = typeof options.getWebview === 'function' ? options.getWebview : () => null;
  const hooks = {
    onSelection: typeof options.onSelection === 'function' ? options.onSelection : null,
    onElement: typeof options.onElement === 'function' ? options.onElement : null,
    onExit: typeof options.onExit === 'function' ? options.onExit : null,
    onPickerChange: typeof options.onPickerChange === 'function' ? options.onPickerChange : null,
    onError: typeof options.onError === 'function' ? options.onError : null,
  };

  let armedTabId = '';
  let picking = false;
  let pickingTabId = '';
  let subscribed = false;
  let unsubscribe = null;
  let watched = null;

  function bridge() {
    if (options.bridge) return options.bridge;
    if (typeof window === 'undefined') return null;
    const api = window.movaDesktop?.browser?.inspect;
    return api && typeof api.start === 'function' && typeof api.stop === 'function' ? api : null;
  }

  function emit(name, payload) {
    const hook = hooks[name];
    if (!hook) return;
    try {
      hook(payload);
    } catch (error) {
      console.error(`[web-inspect] ${name} 回调失败`, error);
    }
  }

  function notifyPickerChange(value) {
    emit('onPickerChange', value);
  }

  function safeUrl(value) {
    const raw = String(value ?? '').trim();
    return /^https?:\/\//i.test(raw) ? raw.slice(0, 2048) : '';
  }

  function safeTitle(value) {
    return clip(value, MAX_NAME);
  }

  function safeWebview() {
    try {
      const view = getWebview();
      return view && typeof view.getBoundingClientRect === 'function' ? view : null;
    } catch {
      return null;
    }
  }

  function toHostRect(rect) {
    const view = safeWebview();
    if (!view) return null;
    let box;
    try {
      box = view.getBoundingClientRect();
    } catch {
      return null;
    }
    return offsetRect(rect, box);
  }

  function handle(payload) {
    if (!payload || typeof payload !== 'object') return;
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (!EVENT_TYPES.has(type)) return;
    const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
    const current = pickingTabId || armedTabId;
    // 只认当前标签的上报：切标签 / 关标签后的迟到事件直接丢掉。
    if (tabId && current && tabId !== current) return;

    if (type === 'exit') {
      const wasPicking = picking;
      picking = false;
      pickingTabId = '';
      if (wasPicking) notifyPickerChange(false);
      emit('onExit', {
        reason: 'exit',
        tabId: tabId || current,
        url: safeUrl(payload.url),
        title: safeTitle(payload.title),
      });
      return;
    }

    if (type === 'selection') {
      const text = clip(payload.text, MAX_TEXT);
      if (text.length < 2) return;
      const url = safeUrl(payload.url);
      emit('onSelection', {
        text,
        rect: toHostRect(payload.rect),
        url,
        title: safeTitle(payload.title),
        source: { kind: 'web', ...(url ? { url } : {}) },
      });
      return;
    }

    const element = sanitizeElement(payload.element);
    if (!element) return;
    const wasPicking = picking;
    picking = false;
    pickingTabId = '';
    if (wasPicking) notifyPickerChange(false);
    const url = safeUrl(payload.url);
    emit('onElement', {
      element,
      rect: toHostRect(payload.rect),
      url,
      title: safeTitle(payload.title),
      // label 交给 quote-source 统一生成（tag + 文本），这里只给结构化字段。
      source: {
        kind: 'element',
        tag: element.tag,
        ...(element.selector ? { selector: element.selector } : {}),
        ...(url ? { url } : {}),
      },
    });
  }

  function ensureSubscribed() {
    if (subscribed) return true;
    const api = bridge();
    if (!api || typeof api.onEvent !== 'function') return false;
    try {
      const off = api.onEvent(handle);
      unsubscribe = typeof off === 'function' ? off : null;
      subscribed = true;
      return true;
    } catch (error) {
      console.error('[web-inspect] 订阅事件失败', error);
      return false;
    }
  }

  /** 导航 / 刷新：选择态必须结束，浮层立刻隐藏（§3.11 退出条件）。 */
  const onNavigated = () => {
    const wasPicking = picking;
    picking = false;
    pickingTabId = '';
    if (wasPicking) notifyPickerChange(false);
    emit('onExit', { reason: 'navigate', tabId: armedTabId, url: '', title: '' });
  };

  function unwatchNavigation() {
    if (!watched) return;
    try {
      watched.removeEventListener('did-navigate', onNavigated);
      watched.removeEventListener('did-start-loading', onNavigated);
    } catch {
      // webview 已经销毁，监听会随节点一起消失。
    }
    watched = null;
  }

  function watchNavigation() {
    const view = safeWebview();
    if (!view || view === watched) return;
    unwatchNavigation();
    try {
      view.addEventListener('did-navigate', onNavigated);
      view.addEventListener('did-start-loading', onNavigated);
      watched = view;
    } catch {
      watched = null;
    }
  }

  /**
   * 只建立选区监听（picker:false）：进入网页位置时调用，让选区上报生效。
   * @returns {Promise<{ok: true}|{ok: false, code: string, message: string}>}
   */
  async function arm(tabId) {
    const api = bridge();
    if (!api) return { ok: false, code: 'inspect-unavailable', message: SELECTION_HINT };
    // arm 的语义是「只保留选区上报」：主进程在 picker:false 时会先停掉 picker，
    // 所以这里也要把按下态复位，否则宿主按钮会一直亮着。
    if (picking) {
      picking = false;
      pickingTabId = '';
      notifyPickerChange(false);
    }
    ensureSubscribed();
    watchNavigation();
    const id = typeof tabId === 'string' ? tabId : '';
    try {
      const result = await api.start({ picker: false, ...(id ? { tabId: id } : {}) });
      if (result && result.ok === false) {
        const failure = { code: String(result.code || 'inspect-unavailable'), message: SELECTION_HINT };
        emit('onError', failure);
        return { ok: false, ...failure };
      }
      armedTabId = (result && typeof result.tabId === 'string' && result.tabId) || id || armedTabId;
      return { ok: true };
    } catch (error) {
      const failure = failureOf(error, 'selection');
      emit('onError', failure);
      return { ok: false, ...failure };
    }
  }

  /**
   * 进入元素选择（picker:true）。
   * @returns {Promise<{ok: true}|{ok: false, code: string, message: string}>}
   */
  async function startPicker(tabId) {
    const api = bridge();
    if (!api) return { ok: false, code: 'inspect-unavailable', message: PICKER_HINT };
    ensureSubscribed();
    watchNavigation();
    const id = typeof tabId === 'string' && tabId ? tabId : armedTabId;
    try {
      const result = await api.start({ picker: true, ...(id ? { tabId: id } : {}) });
      if (result && result.ok === false) {
        const failure = { code: String(result.code || 'inspect-unavailable'), message: PICKER_HINT };
        picking = false;
        pickingTabId = '';
        notifyPickerChange(false);
        emit('onError', failure);
        return { ok: false, ...failure };
      }
      picking = true;
      pickingTabId = (result && typeof result.tabId === 'string' && result.tabId) || id;
      armedTabId = pickingTabId || armedTabId;
      notifyPickerChange(true);
      return { ok: true };
    } catch (error) {
      picking = false;
      pickingTabId = '';
      notifyPickerChange(false);
      const failure = failureOf(error, 'picker');
      emit('onError', failure);
      return { ok: false, ...failure };
    }
  }

  /** 结束选择并撤掉注入；之后再收到任何页面上报都不会转发。 */
  async function stop() {
    const wasPicking = picking;
    picking = false;
    pickingTabId = '';
    armedTabId = '';
    unwatchNavigation();
    if (wasPicking) notifyPickerChange(false);
    const api = bridge();
    if (!api) return { ok: false, code: 'inspect-unavailable' };
    try {
      const result = await api.stop();
      return result ?? { ok: true };
    } catch (error) {
      return { ok: false, code: String(error?.code || 'inspect-stop-failed') };
    }
  }

  function dispose() {
    unwatchNavigation();
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // 订阅方已经销毁，无需处理。
      }
    }
    unsubscribe = null;
    subscribed = false;
    armedTabId = '';
    picking = false;
    pickingTabId = '';
    const api = bridge();
    if (api) Promise.resolve(api.stop()).catch(() => {});
  }

  ensureSubscribed();

  return {
    arm,
    startPicker,
    stop,
    dispose,
    isPicking: () => picking,
    activeTabId: () => pickingTabId || armedTabId,
  };
}
