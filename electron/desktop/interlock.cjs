'use strict';
// 鼠标接管闸门（interlock）：
//  - 会话 running：装 WH_MOUSE_LL，吞掉真人的移动/点击（我们自己的注入放行），
//    并在第一次真人点击时暂停会话、把小球变红、气泡提示“点击 Mova 恢复操作”；
//  - 会话 paused：仍然只吞“点在球上”的那一下（球是恢复按钮，但浮层本身不吃鼠标事件），
//    其它点击/移动全部放行，用户可以正常用电脑；
//  - 会话结束：卸掉钩子，完全恢复。
// 轮询会话状态（150ms）而不是让 session 反向依赖它，避免循环依赖。

const { createMouseHook } = require('./hook.cjs');

const POLL_MS = 150;
// 小球在左下角（overlay.css：--hud-offset-left:24 / --hud-offset-bottom:22 / --ball-size:44）。
// 命中区域向外放宽 12px，方便点中：DIP 坐标 x∈[12,80]、y∈[H-78,H-10]。
const BALL = { left: 12, bottom: 78, size: 68 };

function createInterlock({ session, screen, logger = null } = {}) {
  const log = logger || { info() {}, warn() {} };
  const hook = createMouseHook({
    isLocked: () => sessionState() === 'running',
    onUserClick: handleUserClick,
  });

  let timer = null;
  let disposed = false;
  let lastState = 'idle';
  let pausedByClick = false;

  function sessionState() {
    try { return (session && session.status ? session.status().state : 'idle') || 'idle'; } catch { return 'idle'; }
  }

  function displays() {
    try {
      if (screen && typeof screen.getAllDisplays === 'function') return screen.getAllDisplays() || [];
      const d = screen && screen.getPrimaryDisplay ? screen.getPrimaryDisplay() : null;
      return d ? [d] : [];
    } catch { return []; }
  }

  function primaryDisplay() {
    const list = displays();
    return list.find(d => d && d.primary) || list[0] || null;
  }

  function scaleOf(display) {
    const s = Number(display && display.scaleFactor);
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

  /**
   * 钩子给的是**物理像素**（LLMHOOKSTRUCT.pt），浮层与 CSS 是 DIP。
   * 这里按显示器把物理点折算成 DIP —— 不做这一步，scaleFactor=2 的机器上永远点不中小球。
   */
  function toDip(point) {
    const list = displays();
    for (const d of list) {
      const b = (d && d.bounds) || null;
      if (!b) continue;
      const s = scaleOf(d);
      const px = (b.x || 0) * s;
      const py = (b.y || 0) * s;
      const pw = (b.width || 0) * s;
      const ph = (b.height || 0) * s;
      if (point.x >= px && point.x <= px + pw && point.y >= py && point.y <= py + ph) {
        return { x: (point.x - px) / s + (b.x || 0), y: (point.y - py) / s + (b.y || 0), display: d };
      }
    }
    const d = primaryDisplay();
    const s = scaleOf(d);
    return { x: point.x / s, y: point.y / s, display: d };
  }

  /** 某块显示器上的小球命中矩形（DIP）。 */
  function ballRectOn(display) {
    const b = (display && display.bounds) || { x: 0, y: 0, width: 1440, height: 900 };
    return {
      x: (b.x || 0) + BALL.left,
      y: (b.y || 0) + (b.height || 0) - BALL.bottom,
      w: BALL.size,
      h: BALL.size,
    };
  }

  function ballRect() {
    return ballRectOn(primaryDisplay());
  }

  function insideRect(rect, point) {
    return Boolean(rect) && point.x >= rect.x && point.x <= rect.x + rect.w
      && point.y >= rect.y && point.y <= rect.y + rect.h;
  }

  /** 物理点是否落在“它所在那块显示器”的小球上。 */
  function insideBall(point) {
    const dip = toDip(point);
    return insideRect(ballRectOn(dip.display), dip);
  }

  function handleUserClick(point) {
    const state = sessionState();
    if (state === 'running') {
      // 真人点了一下 → 暂停 + 小球变红 + 提示恢复
      pausedByClick = true;
      void (async () => {
        try {
          const result = session.pause('user-click');
          if (result && result.ok === false) log.warn?.(`[interlock] pause failed: ${result.code}`);
        } catch (error) {
          log.warn?.(`[interlock] pause threw: ${error && error.message}`);
        }
      })();
      return;
    }
    if (state === 'paused' && insideBall(point)) {
      pausedByClick = false;
      void (async () => {
        try {
          const result = session.resume();
          if (result && result.ok === false) log.warn?.(`[interlock] resume failed: ${result.code}`);
          else log.info?.('[interlock] resumed by ball click');
        } catch (error) { log.warn?.(`[interlock] resume threw: ${error && error.message}`); }
      })();
    }
  }

  function ensureHook() {
    if (hook.installed) return;
    const result = hook.install();
    if (result && result.ok) log.info?.('[interlock] mouse hook installed');
    else log.warn?.(`[interlock] mouse hook unavailable: ${JSON.stringify(result)}`);
  }

  function tick() {
    if (disposed) return;
    const state = sessionState();
    if (state === 'running') {
      ensureHook();
    } else if (state === 'paused') {
      if (hook.installed) return; // paused 时钩子仍在，但只吞球上的点击
      ensureHook();
    } else if (state !== lastState && (state === 'done' || state === 'aborted' || state === 'idle')) {
      // 会话结束：卸钩子，彻底放手
      if (hook.installed) hook.uninstall();
      pausedByClick = false;
    }
    lastState = state;
  }

  function start() {
    if (timer || disposed) return;
    timer = setInterval(tick, POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    tick();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    try { hook.uninstall(); } catch { /* ignore */ }
  }

  function dispose() {
    disposed = true;
    stop();
  }

  return {
    start,
    stop,
    dispose,
    ballRect,
    ballRectOn,
    insideBall,
    toDip,
    // 给测试/冒烟用：等价于“钩子收到一次真人点击（物理像素）”，走同一条暂停/恢复分支。
    handleClick: handleUserClick,
    stats: () => hook.stats(),
    get hooked() { return hook.installed; },
    get pausedByClick() { return pausedByClick; },
  };
}

module.exports = { createInterlock, BALL };
