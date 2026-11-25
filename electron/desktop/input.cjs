'use strict';

/**
 * Mova 桌面操作 · 输入注入（主进程内 koffi → user32.dll）
 *
 * 设计要点（见 `Mova桌面操作开发方案.md` §7.1–7.5、§7.7）：
 * - 坐标一律是**物理像素**；绝对移动按虚拟桌面归一化到 0..65535，副屏在左时原点为负；
 * - 一次动作只发**一个** SendInput 数组，减少用户输入插进来的窗口；
 * - 组合键严格「修饰键顺序 down → 主键 down/up → 逆序 up」；
 * - `releaseAll()` 在任何失败路径都能调用，且**绝不抛异常**（防“按键卡住”）；
 * - 不依赖 nut.js 之类的原生模块，只声明 user32/kernel32 里用到的几个函数。
 *
 * 纯计算部分（`normalizeAbsolute` / `parseCombo` / `wheelDelta` / `isPlainAscii`）
 * 单独导出，便于 `tests/desktop/input.test.cjs` 在不注入任何输入的前提下做单测。
 */

/* ─────────────────────────── 常量 ─────────────────────────── */

const VK = Object.freeze({
  SHIFT: 0x10,
  CONTROL: 0x11,
  ALT: 0x12,
  WIN: 0x5B,
  LSHIFT: 0xA0,
  RSHIFT: 0xA1,
  LCONTROL: 0xA2,
  RCONTROL: 0xA3,
  LMENU: 0xA4,
  RMENU: 0xA5,
  LWIN: 0x5B,
  RWIN: 0x5C,
});

const MODIFIER_NAMES = Object.freeze({
  ctrl: VK.CONTROL,
  control: VK.CONTROL,
  shift: VK.SHIFT,
  alt: VK.ALT,
  menu: VK.ALT,
  win: VK.WIN,
  meta: VK.WIN,
  cmd: VK.WIN,
  super: VK.WIN,
});

/** 具名键（小写）。字母、数字、F1–F24 在 resolveKey 里单独算。 */
const KEY_NAMES = Object.freeze({
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  spacebar: 0x20,
  backspace: 0x08,
  bs: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  ins: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  left: 0x25,
  leftarrow: 0x25,
  up: 0x26,
  uparrow: 0x26,
  right: 0x27,
  rightarrow: 0x27,
  down: 0x28,
  downarrow: 0x28,
  capslock: 0x14,
  printscreen: 0x2c,
  prtsc: 0x2c,
  pause: 0x13,
  numlock: 0x90,
  scrolllock: 0x91,
  plus: 0xbb,
  equal: 0xbb,
  '=': 0xbb,
  minus: 0xbd,
  '-': 0xbd,
  comma: 0xbc,
  ',': 0xbc,
  period: 0xbe,
  '.': 0xbe,
  slash: 0xbf,
  '/': 0xbf,
  semicolon: 0xba,
  ';': 0xba,
  quote: 0xde,
  "'": 0xde,
  bracketleft: 0xdb,
  '[': 0xdb,
  bracketright: 0xdd,
  ']': 0xdd,
  backslash: 0xdc,
  '\\': 0xdc,
  backquote: 0xc0,
  '`': 0xc0,
  add: 0x6b,
  subtract: 0x6d,
  multiply: 0x6a,
  divide: 0x6f,
  decimal: 0x6e,
});

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  XDOWN: 0x0080,
  XUP: 0x0100,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
  ABSOLUTE: 0x8000,
  VIRTUALDESK: 0x4000,
});

const KEYEVENTF = Object.freeze({
  EXTENDEDKEY: 0x0001,
  KEYUP: 0x0002,
  UNICODE: 0x0004,
  SCANCODE: 0x0008,
});

const BUTTON_FLAGS = Object.freeze({
  left: { down: MOUSEEVENTF.LEFTDOWN, up: MOUSEEVENTF.LEFTUP },
  right: { down: MOUSEEVENTF.RIGHTDOWN, up: MOUSEEVENTF.RIGHTUP },
  middle: { down: MOUSEEVENTF.MIDDLEDOWN, up: MOUSEEVENTF.MIDDLEUP },
});

const BUTTON_ALIASES = Object.freeze({ l: 'left', r: 'right', m: 'middle', primary: 'left', secondary: 'right' });

/** SM_* 索引：虚拟桌面（多屏合并）在物理像素下的外接矩形。 */
const SM = Object.freeze({
  XVIRTUALSCREEN: 76,
  YVIRTUALSCREEN: 77,
  CXVIRTUALSCREEN: 78,
  CYVIRTUALSCREEN: 79,
});

/** GET_ASYNC_KEYSTATE 高位表示“当前按下”。 */
const KEY_DOWN_MASK = 0x8000;

/** releaseAll() 无条件补发的修饰键（含左右分体键）。 */
const SAFETY_KEYS = Object.freeze([
  VK.CONTROL, VK.LCONTROL, VK.RCONTROL,
  VK.SHIFT, VK.LSHIFT, VK.RSHIFT,
  VK.ALT, VK.LMENU, VK.RMENU,
  VK.WIN, VK.RWIN,
]);

/* ─────────────────────── 纯函数（可单测） ─────────────────────── */

/**
 * 物理像素 → SendInput 绝对坐标（0..65535，虚拟桌面归一化）。
 * @param {number} x 物理像素 x
 * @param {number} y 物理像素 y
 * @param {{x:number,y:number,w:number,h:number}} virtual 虚拟桌面（GetSystemMetrics 的 SM_*）
 * @returns {{nx:number, ny:number}}
 */
function normalizeAbsolute(x, y, virtual) {
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    throw new TypeError('input.normalizeAbsolute：坐标必须是有限数字');
  }
  if (!virtual || typeof virtual !== 'object') {
    throw new TypeError('input.normalizeAbsolute：缺少虚拟桌面矩形');
  }
  const vx = Number(virtual.x) || 0;
  const vy = Number(virtual.y) || 0;
  const vw = Number(virtual.w);
  const vh = Number(virtual.h);
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
    throw new RangeError('input.normalizeAbsolute：虚拟桌面宽高必须大于 0');
  }
  const nx = clampInt(Math.round(((x - vx) * 65535) / vw), 0, 65535);
  const ny = clampInt(Math.round(((y - vy) * 65535) / vh), 0, 65535);
  return { nx, ny };
}

/**
 * 解析组合键字符串。按下顺序 = [修饰键…, 主键]，释放顺序严格相反。
 * 只做解析，不注入 —— 供 pressCombo 与单测共用。
 * @param {string} combo 例如 'ctrl+shift+s'、'Control+Alt+Delete'、'ctrl'（纯修饰键）
 * @returns {{raw:string, mods:number[], key:number|null, press:number[], release:number[]}}
 */
function parseCombo(combo) {
  if (typeof combo !== 'string') throw new TypeError('input.parseCombo：组合键必须是字符串');
  const raw = combo.trim();
  if (!raw) throw new Error('input.parseCombo：组合键不能为空');
  const tokens = raw.split('+').map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) throw new Error(`input.parseCombo：组合键 "${raw}" 无效`);

  const mods = [];
  let key = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const mod = MODIFIER_NAMES[lower];
    if (mod != null) {
      if (!mods.includes(mod)) mods.push(mod);
      continue;
    }
    const vk = resolveKey(lower);
    if (vk == null) throw new Error(`input.parseCombo：无法识别的键 "${token}"（组合键 "${raw}"）`);
    if (key != null) throw new Error(`input.parseCombo：组合键 "${raw}" 只能有一个非修饰键`);
    key = vk;
  }

  const press = key == null ? mods.slice() : [...mods, key];
  if (!press.length) throw new Error(`input.parseCombo：组合键 "${raw}" 没有可用的键`);
  const release = press.slice().reverse();
  return { raw, mods, key, press, release };
}

/** 单个键名 → 虚拟键码；无法识别返回 null。 */
function resolveKey(token) {
  if (/^[a-z]$/.test(token)) return 0x41 + (token.charCodeAt(0) - 0x61);
  if (/^[0-9]$/.test(token)) return 0x30 + Number(token);
  const f = /^f([1-9]|1[0-9]|20|2[1-4])$/.exec(token);
  if (f) return 0x70 + (Number(f[1]) - 1);
  const named = KEY_NAMES[token];
  return named == null ? null : named;
}

/**
 * 滚轮增量归一化：|delta| < 120 视为“格数”（1 格 = 120），否则按原始 wheel delta。
 * @param {number} delta
 * @returns {number}
 */
function wheelDelta(delta) {
  const value = Number(delta);
  if (!Number.isFinite(value)) throw new TypeError('input.wheelDelta：delta 必须是有限数字');
  if (value === 0) return 0;
  if (Math.abs(value) < 120) {
    const notches = Math.max(1, Math.round(Math.abs(value)));
    return (value < 0 ? -1 : 1) * notches * 120;
  }
  return Math.trunc(value);
}

/** 这些键必须以 KEYEVENTF_EXTENDEDKEY 注入，否则小键盘/方向键会被解释成数字。 */
function isExtendedVk(vk) {
  return (
    vk === 0x21 || vk === 0x22 || vk === 0x23 || vk === 0x24 || // pgup/pgdn/end/home
    vk === 0x25 || vk === 0x26 || vk === 0x27 || vk === 0x28 || // arrows
    vk === 0x2d || vk === 0x2e ||                               // insert/delete
    vk === 0x90 || vk === 0x2c ||                               // numlock/printscreen
    vk === 0x6f ||                                              // divide
    vk === 0xa3 || vk === 0xa5 ||                               // right ctrl/alt
    vk === 0x5b || vk === 0x5c                                  // win
  );
}

/**
 * 是否适合用 KEYEVENTF_UNICODE 直接打字：短文本且全是可见 ASCII。
 * 含中文、换行、制表符或过长 → 走剪贴板。
 */
function isPlainAscii(text, maxLength = 64) {
  const value = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!value.length) return false;
  if (value.length > (Number.isFinite(maxLength) ? maxLength : 64)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* ───────────────────── koffi / user32 绑定 ───────────────────── */

let bound = null;
let bindError = null;
let bindTried = false;

function bind() {
  if (bound) return bound;
  if (bindTried && bindError) throw bindError;
  bindTried = true;
  if (process.platform !== 'win32') {
    bindError = new Error('input：输入注入目前只支持 Windows');
    throw bindError;
  }
  let koffi;
  try {
    koffi = require('koffi');
  } catch (error) {
    bindError = new Error(`input：koffi 不可用（${error.message}）`);
    throw bindError;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    // 指针宽度随架构变化，交给 koffi 的 uintptr_t；64 位下 sizeof(INPUT) = 40。
    const MOUSEINPUT = koffi.struct('MOVA_MOUSEINPUT', {
      dx: 'int32',
      dy: 'int32',
      mouseData: 'int32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const KEYBDINPUT = koffi.struct('MOVA_KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const HARDWAREINPUT = koffi.struct('MOVA_HARDWAREINPUT', {
      uMsg: 'uint32',
      wParamL: 'uint16',
      wParamH: 'uint16',
    });
    const INPUTUNION = koffi.union('MOVA_INPUTUNION', {
      mi: MOUSEINPUT,
      ki: KEYBDINPUT,
      hi: HARDWAREINPUT,
    });
    const INPUT = koffi.struct('MOVA_INPUT', { type: 'uint32', u: INPUTUNION });
    const POINT = koffi.struct('MOVA_POINT', { x: 'int32', y: 'int32' });
    const LASTINPUTINFO = koffi.struct('MOVA_LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });

    bound = {
      koffi,
      SendInput: user32.func('uint32 SendInput(uint32 cInputs, MOVA_INPUT *pInputs, int cbSize)'),
      GetSystemMetrics: user32.func('int GetSystemMetrics(int nIndex)'),
      SetCursorPos: user32.func('SetCursorPos', 'bool', ['int', 'int']),
      GetCursorPos: user32.func('GetCursorPos', 'bool', [koffi.inout(koffi.pointer(POINT))]),
      GetAsyncKeyState: user32.func('int16 GetAsyncKeyState(int vKey)'),
      GetLastInputInfo: user32.func('GetLastInputInfo', 'bool', [koffi.inout(koffi.pointer(LASTINPUTINFO))]),
      GetForegroundWindow: user32.func('GetForegroundWindow', 'void *', []),
      GetTickCount: kernel32.func('uint32 GetTickCount()'),
      size: {
        input: koffi.sizeof(INPUT),
        point: koffi.sizeof(POINT),
        lastInput: koffi.sizeof(LASTINPUTINFO),
      },
    };
    return bound;
  } catch (error) {
    bindError = new Error(`input：user32 绑定失败（${error.message}）`);
    throw bindError;
  }
}

/** 是否可以在当前平台注入输入（不抛异常）。 */
function isAvailable() {
  try {
    bind();
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────── 注入事件构造 ─────────────────────── */

function mouseEvent(flags, dx = 0, dy = 0, data = 0) {
  return {
    type: INPUT_MOUSE,
    u: { mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  };
}

function keyEvent(vk, flags, scan = 0) {
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  };
}

const injectionListeners = new Set();
const pressedKeys = new Set();
const pressedButtons = new Set();
let pressedKeyOrder = [];

/**
 * 订阅“刚刚注入了输入”的通知。guard 用它把 ±80ms 的注入窗口排除掉，
 * 避免把自己的点击误判成真人接管。
 * @param {(evt:{tick:number, at:number, count:number}) => void} listener
 * @returns {() => void} 取消订阅
 */
function onInjection(listener) {
  if (typeof listener !== 'function') throw new TypeError('input.onInjection：需要一个函数');
  injectionListeners.add(listener);
  return () => injectionListeners.delete(listener);
}

function notifyInjection(count) {
  if (!injectionListeners.size) return;
  let tick;
  try {
    tick = nowTick();
  } catch {
    return;
  }
  const evt = { tick, at: Date.now(), count };
  for (const listener of injectionListeners) {
    try {
      listener(evt);
    } catch {
      /* 监听器异常不能影响注入本身 */
    }
  }
}

function sendInputs(events) {
  if (!Array.isArray(events) || !events.length) return 0;
  const api = bind();
  const sent = api.SendInput(events.length, events, api.size.input);
  if (!sent) {
    throw new Error(
      `input：SendInput 未注入任何事件（${events.length} 个），通常表示目标窗口以管理员运行（UIPI 拦截）`,
    );
  }
  notifyInjection(sent);
  return sent;
}

/* ─────────────────────── 屏幕 / 光标 ─────────────────────── */

/** 虚拟桌面外接矩形（物理像素；副屏在左时 x/y 为负）。 */
function virtualScreen() {
  const api = bind();
  const x = api.GetSystemMetrics(SM.XVIRTUALSCREEN);
  const y = api.GetSystemMetrics(SM.YVIRTUALSCREEN);
  const w = api.GetSystemMetrics(SM.CXVIRTUALSCREEN);
  const h = api.GetSystemMetrics(SM.CYVIRTUALSCREEN);
  if (!(w > 0) || !(h > 0)) throw new Error('input：无法读取虚拟桌面尺寸');
  return { x, y, w, h };
}

/** 当前光标位置（物理像素）。 */
function cursor() {
  const api = bind();
  const point = { x: 0, y: 0 };
  if (!api.GetCursorPos(point)) throw new Error('input：GetCursorPos 失败');
  return { x: point.x, y: point.y };
}

function safeCursor() {
  try {
    return cursor();
  } catch {
    return null;
  }
}

function restoreCursor(position) {
  if (!position) return;
  try {
    bind().SetCursorPos(position.x, position.y);
  } catch {
    /* 恢复光标失败不影响动作结果 */
  }
}

function moveTo(x, y) {
  if (typeof x === 'object' && x !== null) {
    return moveTo(x.x, x.y);
  }
  const point = readPoint({ x, y }, 'moveTo');
  const screen = virtualScreen();
  const { nx, ny } = normalizeAbsolute(point.x, point.y, screen);
  sendInputs([mouseEvent(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, nx, ny)]);
  return { x: point.x, y: point.y, nx, ny };
}

/* ─────────────────────── 鼠标动作 ─────────────────────── */

function normalizeButton(button) {
  const raw = button == null ? 'left' : String(button).toLowerCase();
  const name = BUTTON_ALIASES[raw] || raw;
  if (!BUTTON_FLAGS[name]) throw new Error(`input：不支持的鼠标键 "${button}"`);
  return name;
}

function readPoint(value, label) {
  if (!value || typeof value !== 'object') throw new TypeError(`input.${label}：需要 {x, y}`);
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError(`input.${label}：坐标必须是有限数字`);
  return { x, y };
}

/**
 * 平滑移动光标（让用户看得见“AI 在动我的鼠标”）。
 * 参考 Codex / ChatGPT 的桌面包：先滑过去再点，不瞬移。
 */
async function glideTo(x, y, options = {}) {
  const point = readPoint(typeof x === 'object' && x !== null ? x : { x, y }, 'glideTo');
  const from = safeCursor() || point;
  const durationMs = clampInt(options.durationMs == null ? 320 : options.durationMs, 0, 4000);
  if (durationMs < 16) {
    moveTo(point.x, point.y);
    return point;
  }
  const steps = clampInt(options.steps == null ? Math.max(8, Math.round(durationMs / 16)) : options.steps, 2, 120);
  const stepDelay = Math.max(1, Math.round(durationMs / steps));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = t * t * (3 - 2 * t);           // smoothstep：起步慢、收尾慢，像真人
    moveTo(
      Math.round(from.x + (point.x - from.x) * eased),
      Math.round(from.y + (point.y - from.y) * eased),
    );
    await sleep(stepDelay);
  }
  moveTo(point.x, point.y);
  return point;
}

/**
 * 点击（可带坐标）。坐标 + 左键按下/抬起放在同一个 SendInput 数组里，
 * 避免用户输入插进“移动”和“按下”之间。
 * 默认：先 glide 过去（看得见），点完**不把光标挪回去**（AI 接管鼠标，和 Codex 一致）。
 */
async function click(options = {}, argY, argOptions) {
  // 兼容两种调用：click({x,y,...}) 和 click(x, y, {...})（actions.cjs 走的是后者）
  if (typeof options === 'number' && Number.isFinite(argY)) {
    options = { ...(argOptions && typeof argOptions === 'object' ? argOptions : {}), x: options, y: argY };
  }
  const button = normalizeButton(options.button);
  const flags = BUTTON_FLAGS[button];
  const hasPoint = Number.isFinite(Number(options.x)) && Number.isFinite(Number(options.y));
  const restore = options.restoreCursor === true;
  const before = restore ? safeCursor() : null;

  if (hasPoint && options.glide !== false) {
    await glideTo(Number(options.x), Number(options.y), {
      durationMs: Number.isFinite(Number(options.glideMs)) ? Number(options.glideMs) : 260,
    });
  }

  const batch = [];
  if (hasPoint && options.glide === false) {
    const screen = virtualScreen();
    const { nx, ny } = normalizeAbsolute(Number(options.x), Number(options.y), screen);
    batch.push(mouseEvent(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, nx, ny));
  }
  batch.push(mouseEvent(flags.down), mouseEvent(flags.up));
  sendInputs(batch);

  if (options.double) {
    await sleep(60);
    sendInputs([mouseEvent(flags.down), mouseEvent(flags.up)]);
  }
  if (before) restoreCursor(before);
  return {
    x: hasPoint ? Number(options.x) : null,
    y: hasPoint ? Number(options.y) : null,
    button,
    double: !!options.double,
    glided: hasPoint && options.glide !== false,
  };
}

/** 按下鼠标键（可选先移动）。 */
function down(options = {}) {
  const button = normalizeButton(options.button);
  if (Number.isFinite(Number(options.x)) && Number.isFinite(Number(options.y))) {
    moveTo(Number(options.x), Number(options.y));
  }
  pressedButtons.add(button);
  sendInputs([mouseEvent(BUTTON_FLAGS[button].down)]);
  return { button };
}

/** 抬起鼠标键。 */
function up(options = {}) {
  const button = normalizeButton(options.button);
  pressedButtons.delete(button);
  sendInputs([mouseEvent(BUTTON_FLAGS[button].up)]);
  return { button };
}

/**
 * 滚轮：先按 §7.5 把光标移到目标区域（滚轮按“光标下窗口”路由），滚完恢复。
 * `delta` 为 Windows wheel delta；|delta| < 120 时按格数解释（1 格 = 120）。
 */
function scroll(options = {}) {
  const delta = wheelDelta(options.delta);
  if (!delta) return { delta: 0 };
  const restore = options.restoreCursor !== false;
  const before = restore ? safeCursor() : null;
  const batch = [];
  if (Number.isFinite(Number(options.x)) && Number.isFinite(Number(options.y))) {
    const screen = virtualScreen();
    const { nx, ny } = normalizeAbsolute(Number(options.x), Number(options.y), screen);
    batch.push(mouseEvent(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK, nx, ny));
  }
  batch.push(mouseEvent(options.horizontal ? MOUSEEVENTF.HWHEEL : MOUSEEVENTF.WHEEL, 0, 0, delta));
  sendInputs(batch);
  if (before) restoreCursor(before);
  return { delta };
}

/**
 * 拖拽：分段移动（默认 12 段、每段 60ms），不要瞬移。
 * 传 `isAborted()` 可在每段之间检查取消（guard/session 用它响应终止）。
 */
async function drag(options = {}) {
  const from = readPoint(options.from, 'drag.from');
  const to = readPoint(options.to, 'drag.to');
  const button = normalizeButton(options.button);
  const steps = clampInt(options.steps == null ? 12 : options.steps, 2, 64);
  const settleMs = clampInt(options.settleMs == null ? 60 : options.settleMs, 5, 500);
  const durationMs = Number.isFinite(Number(options.durationMs))
    ? clampInt(options.durationMs, 0, 15000)
    : steps * settleMs;
  const stepDelay = steps ? Math.max(0, Math.round(durationMs / steps)) : 0;

  moveTo(from.x, from.y);
  await sleep(30);
  down({ button });
  try {
    for (let i = 1; i <= steps; i += 1) {
      if (typeof options.isAborted === 'function' && options.isAborted()) break;
      const ratio = i / steps;
      moveTo(
        Math.round(from.x + (to.x - from.x) * ratio),
        Math.round(from.y + (to.y - from.y) * ratio),
      );
      if (stepDelay) await sleep(stepDelay);
    }
    await sleep(Number.isFinite(Number(options.holdMs)) ? clampInt(options.holdMs, 0, 2000) : 120);
  } finally {
    // 任何失败路径都必须抬起鼠标键，否则用户会带着“按住的左键”继续用电脑。
    try {
      up({ button });
    } catch {
      releaseAll();
    }
  }
  return { from, to, steps, durationMs };
}

/* ─────────────────────── 键盘 / 文本 ─────────────────────── */

function keyDown(vk) {
  if (!pressedKeys.has(vk)) {
    pressedKeys.add(vk);
    pressedKeyOrder.push(vk);
  }
  const flags = isExtendedVk(vk) ? KEYEVENTF.EXTENDEDKEY : 0;
  sendInputs([keyEvent(vk, flags)]);
}

function keyUp(vk) {
  pressedKeys.delete(vk);
  pressedKeyOrder = pressedKeyOrder.filter((item) => item !== vk);
  const flags = KEYEVENTF.KEYUP | (isExtendedVk(vk) ? KEYEVENTF.EXTENDEDKEY : 0);
  sendInputs([keyEvent(vk, flags)]);
}

/**
 * 组合键：修饰键按顺序 down → 主键 down/up → 修饰键**逆序** up。
 * 释放放在 finally 里，任何异常都不会留下“按住的 Shift”。
 * @param {string} combo
 */
function pressCombo(combo) {
  const parsed = parseCombo(combo);
  const held = [];
  try {
    for (const vk of parsed.mods) {
      keyDown(vk);
      held.push(vk);
    }
    if (parsed.key != null) {
      keyDown(parsed.key);
      keyUp(parsed.key);
    }
  } finally {
    for (let i = held.length - 1; i >= 0; i -= 1) {
      try {
        keyUp(held[i]);
      } catch {
        /* 继续释放剩下的键 */
      }
    }
  }
  return parsed;
}

/**
 * 输入文本：
 * - ≤64 字符且全是可见 ASCII → 逐字符 KEYEVENTF_UNICODE（不受键盘布局影响）；
 * - 长文本 / 中文 / 换行 → 剪贴板 + Ctrl+V，用完恢复原剪贴板文本。
 * @returns {Promise<{method:'unicode'|'clipboard'|'none', chars:number}>}
 */
async function typeText(text, options = {}) {
  const value = text == null ? '' : String(text);
  if (!value) return { method: 'none', chars: 0 };

  const mode = options.method;
  if (mode !== 'clipboard' && mode !== 'unicode') {
    if (isPlainAscii(value, options.maxUnicodeChars == null ? 64 : options.maxUnicodeChars)) {
      return typeUnicode(value);
    }
    return pasteText(value);
  }
  if (mode === 'unicode') return typeUnicode(value);
  return pasteText(value);
}

function typeUnicode(value) {
  const events = [];
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    events.push(keyEvent(0, KEYEVENTF.UNICODE, unit));
    events.push(keyEvent(0, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP, unit));
  }
  sendInputs(events);
  return { method: 'unicode', chars: value.length };
}

function electronClipboard() {
  try {
    const electron = require('electron');
    if (electron && electron.clipboard && typeof electron.clipboard.readText === 'function') {
      return electron.clipboard;
    }
  } catch {
    /* 不在 Electron 主进程里（单测 / 纯 node） */
  }
  return null;
}

async function pasteText(value) {
  const clipboard = electronClipboard();
  if (!clipboard) throw new Error('input.typeText：剪贴板不可用（只能在 Electron 主进程里粘贴长文本）');
  let saved = null;
  let hadText;
  try {
    hadText = clipboard.readText().length > 0;
    saved = clipboard.readText();
  } catch {
    hadText = false;
  }
  try {
    clipboard.writeText(value);
    await sleep(60);
    pressCombo('ctrl+v');
    await sleep(Math.min(400, 120 + value.length));
  } finally {
    try {
      if (hadText) clipboard.writeText(saved);
      else clipboard.clear();
    } catch {
      /* 恢复剪贴板失败不影响已输入的文本 */
    }
  }
  return { method: 'clipboard', chars: value.length };
}

/* ─────────────────────── 状态 / 清理 ─────────────────────── */

/** GetTickCount（32 位，GetLastInputInfo 用的是同一时基）。 */
function nowTick() {
  return bind().GetTickCount() >>> 0;
}

/**
 * 最近一次用户输入。tick 是 GetLastInputInfo 的 dwTime（32 位会回绕，用无符号差算 age）。
 * @returns {{tick:number, ageMs:number, nowTick:number}|null}
 */
function lastInputInfo() {
  const api = bind();
  const info = { cbSize: api.size.lastInput, dwTime: 0 };
  if (!api.GetLastInputInfo(info)) return null;
  const tick = info.dwTime >>> 0;
  const now = api.GetTickCount() >>> 0;
  const ageMs = (now - tick) >>> 0;
  return { tick, ageMs, nowTick: now };
}

/** 最近一次输入的 tick（毫秒，系统启动以来）。读不到返回 0。 */
function lastInputTick() {
  try {
    const info = lastInputInfo();
    return info ? info.tick : 0;
  } catch {
    return 0;
  }
}

/** 异步键状态原始值（高位 0x8000 = 当前按下）。 */
function getAsyncKeyState(vk) {
  const code = Number(vk);
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new RangeError('input.getAsyncKeyState：虚拟键码必须是 0..255 的整数');
  }
  return bind().GetAsyncKeyState(code);
}

/** 前台窗口句柄（十进制字符串，方便审计日志）。 */
function foregroundWindow() {
  const handle = bind().GetForegroundWindow();
  if (!handle) return '0';
  return typeof handle === 'bigint' ? handle.toString() : String(handle);
}

/**
 * 释放所有可能被按住的键与鼠标键。**任何失败路径都可以调用，且绝不抛异常。**
 * - 先按自己记录的状态释放（组合键 / 拖拽），
 * - 再无条件补发 Ctrl/Shift/Alt/Win 与三个鼠标键的 up。
 * @returns {number} 成功注入的事件数
 */
function releaseAll() {
  let events = [];
  try {
    for (const button of pressedButtons) {
      const flags = BUTTON_FLAGS[button];
      if (flags) events.push(mouseEvent(flags.up));
    }
    const keys = new Set([...SAFETY_KEYS, ...pressedKeys, ...pressedKeyOrder]);
    for (const vk of keys) {
      events.push(keyEvent(vk, KEYEVENTF.KEYUP | (isExtendedVk(vk) ? KEYEVENTF.EXTENDEDKEY : 0)));
    }
  } catch {
    events = [];
  }
  const hadState = pressedButtons.size > 0 || pressedKeys.size > 0;
  pressedButtons.clear();
  pressedKeys.clear();
  pressedKeyOrder = [];
  if (!events.length) return 0;

  try {
    return sendInputs(events);
  } catch {
    let sent = 0;
    for (const event of events) {
      try {
        sent += sendInputs([event]);
      } catch {
        /* 单个键失败继续试下一个 */
      }
    }
    if (!sent && hadState) {
      // 尽最大努力；不抛异常，保持调用方（abort 路径）可用。
      return 0;
    }
    return sent;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  // 常量
  VK,
  MOUSEEVENTF,
  KEYEVENTF,
  KEY_DOWN_MASK,
  // 纯函数（单测用）
  normalizeAbsolute,
  parseCombo,
  wheelDelta,
  isExtendedVk,
  isPlainAscii,
  // 绑定状态
  isAvailable,
  // 鼠标
  moveTo,
  glideTo,
  click,
  down,
  up,
  scroll,
  drag,
  cursor,
  virtualScreen,
  // 键盘 / 文本
  typeText,
  pressCombo,
  keyDown,
  keyUp,
  // 状态
  getAsyncKeyState,
  lastInputTick,
  lastInputInfo,
  nowTick,
  foregroundWindow,
  // 注入窗口标记
  onInjection,
  // 清理
  releaseAll,
};
