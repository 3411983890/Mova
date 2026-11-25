'use strict';
// 鼠标接管闸门：AI 操作期间拦截“真人”鼠标事件（移动/点击），放行我们自己注入的事件。
// 原理：WH_MOUSE_LL 低级钩子，MSLLHOOKSTRUCT.flags 的 LLMHF_INJECTED 位区分注入事件。
// 注意：钩子必须装在会跑消息循环的线程上（Electron 主进程满足），钩子回调要保持极快，
// 超时会被系统静默摘掉。

const koffi = require('koffi');

const WH_MOUSE_LL = 14;
const LLMHF_INJECTED = 0x00000001;
const WM = {
  MOUSEMOVE: 0x0200,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  RBUTTONDOWN: 0x0204,
  RBUTTONUP: 0x0205,
  MBUTTONDOWN: 0x0207,
  MBUTTONUP: 0x0208,
  MOUSEWHEEL: 0x020A,
};

let user32 = null;
let kernel32 = null;
let proto = null;
let lastLoadError = '';

// 匿名结构体：避免重复加载时 "Duplicate type name"（koffi 对具名结构体按名字注册）
const POINT_T = (() => { try { return koffi.struct({ x: 'int32_t', y: 'int32_t' }); } catch { return null; } })();
const MSLL = (() => {
  try {
    return koffi.struct({
      pt: POINT_T,
      mouseData: 'uint32_t',
      flags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t',
    });
  } catch { return null; }
})();

function load() {
  if (user32) return true;
  try {
    if (!MSLL) throw new Error('MSLLHOOKSTRUCT 结构体注册失败');
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');
    proto = koffi.proto('intptr_t MovaMouseProc(int nCode, uintptr_t wParam, intptr_t lParam)');
    return true;
  } catch (error) {
    lastLoadError = (error && error.message) || String(error);
    return false;
  }
}

/**
 * @param {object} options
 * @param {() => boolean} [options.isLocked] 锁是否生效（false 时只观察不拦截）
 * @param {(info:{x:number,y:number,button:string})=>void} [options.onUserClick] 真人点击
 * @param {() => void} [options.onUserMove] 真人移动（用于“一动就暂停”的场景）
 */
function createMouseHook(options = {}) {
  const isLocked = typeof options.isLocked === 'function' ? options.isLocked : () => false;
  const onUserClick = typeof options.onUserClick === 'function' ? options.onUserClick : null;
  const onUserMove = typeof options.onUserMove === 'function' ? options.onUserMove : null;

  let handle = 0;
  let callback = null;
  let installed = false;
  let stats = { seen: 0, injected: 0, blockedMove: 0, blockedClick: 0 };

  function proc(nCode, wParam, lParam) {
    // nCode < 0：按约定不应处理，直接放行（低级钩子返回 0 = 事件继续派发）
    if (nCode < 0) return 0;
    let info = null;
    try { info = koffi.decode(lParam, MSLL); } catch { info = null; }
    const injected = info ? (info.flags & LLMHF_INJECTED) !== 0 : true;
    stats.seen += 1;
    if (injected) {
      stats.injected += 1;
      return 0; // 放行（Return 0 = 继续派发）
    }

    const x = info ? info.pt.x : 0;
    const y = info ? info.pt.y : 0;
    const locked = isLocked() === true;

    if (wParam === WM.MOUSEMOVE) {
      if (locked) {
        stats.blockedMove += 1;
        if (onUserMove) { try { onUserMove(); } catch { /* ignore */ } }
        return 1; // 吞掉：AI 操作期间不允许真人移动光标
      }
      return 0;
    }

    const isDown = wParam === WM.LBUTTONDOWN || wParam === WM.RBUTTONDOWN || wParam === WM.MBUTTONDOWN;
    if (isDown) {
      const button = wParam === WM.LBUTTONDOWN ? 'left' : wParam === WM.RBUTTONDOWN ? 'right' : 'middle';
      if (onUserClick) { try { onUserClick({ x, y, button, locked }); } catch { /* ignore */ } }
      if (locked) {
        stats.blockedClick += 1;
        return 1; // 吞掉这次按下（并同时吞掉对应的抬起由上层判定）
      }
    }
    return 0;
  }

  function install() {
    if (installed) return { ok: true, handle, stats };
    if (process.platform !== 'win32') return { ok: false, code: 'unsupported-platform' };
    if (!load()) return { ok: false, code: 'hook-unavailable', message: lastLoadError };
    try {
      // koffi 要求回调“注册”后才能活过这次 FFI 调用（否则会报 non-registered callback）
      callback = koffi.register(proc, koffi.pointer(proto));
      const SetWindowsHookExW = user32.func('intptr_t SetWindowsHookExW(int idHook, MovaMouseProc *fn, intptr_t hMod, uint32_t threadId)');
      const GetModuleHandleW = kernel32.func('intptr_t GetModuleHandleW(const char16_t* name)');
      const hMod = GetModuleHandleW(null);
      handle = SetWindowsHookExW(WH_MOUSE_LL, callback, hMod, 0);
      installed = handle !== 0;
      if (!installed && callback) {
        try { koffi.unregister(callback); } catch { /* ignore */ }
        callback = null;
      }
      return installed ? { ok: true, handle, stats } : { ok: false, code: 'hook-failed' };
    } catch (error) {
      if (callback) { try { koffi.unregister(callback); } catch { /* ignore */ } callback = null; }
      return { ok: false, code: 'hook-error', message: error && error.message };
    }
  }

  function uninstall() {
    if (!installed) return true;
    try {
      const UnhookWindowsHookEx = user32.func('bool UnhookWindowsHookEx(intptr_t h)');
      UnhookWindowsHookEx(handle);
    } catch { /* ignore */ }
    try { if (callback) koffi.unregister(callback); } catch { /* ignore */ }
    installed = false;
    handle = 0;
    callback = null;
    return true;
  }

  return {
    install,
    uninstall,
    get installed() { return installed; },
    stats: () => ({ ...stats }),
    resetStats() { stats = { seen: 0, injected: 0, blockedMove: 0, blockedClick: 0 }; },
  };
}

module.exports = { createMouseHook, WH_MOUSE_LL, LLMHF_INJECTED, WM };
