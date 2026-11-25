'use strict';
// Smart wait: poll a small predicate instead of sleeping. The tool layer caps
// the timeout; this module only knows how to observe.
//
// 2026-11 起：固定等待（for:"time"）只保留为最后手段（上限 2 s），主路径改成条件等待：
// - settle    DOM/动画/图片稳定（替代「点完等 300 ms」）
// - idle      在 settle 之上再要求字体与资源加载收敛（替代「等页面加载完」）
// - animation 只剩没有运行动画（下拉、抽屉、过渡）
// - frame     指定 iframe 内容文档可用（跨域时明确返回 crossOrigin）
// 这些条件都只在页面里做只读观察，不改变页面。

const DEFAULT_TIMEOUT = 8000;
const POLL_MS = 120;
const MAX_TIME_WAIT = 2000;
const DEFAULT_QUIET_MS = 150;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * settle 探针：安装一次 MutationObserver / rAF 心跳，之后的轮询只读计数。
 * 第一次调用时 quietMs 很小，所以调用方至少要等 quietMs 才会判定稳定。
 */
const SETTLE_EXPRESSION = `(() => {
  const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
  const s = (window.__movaSettle ??= { mutations: 0, lastMutationAt: now() });
  if (!s.observer && typeof MutationObserver === 'function' && document.documentElement) {
    s.observer = new MutationObserver(records => {
      s.mutations += records.length;
      s.lastMutationAt = now();
    });
    s.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const running = typeof document.getAnimations === 'function'
    ? document.getAnimations().filter(animation => animation && animation.playState === 'running').length : 0;
  const pendingImages = document.images ? Array.from(document.images).filter(image => image && !image.complete).length : 0;
  return {
    mutations: s.mutations,
    quietMs: Math.max(0, Math.round(now() - s.lastMutationAt)),
    animations: running,
    images: pendingImages,
    busy: document.readyState === 'loading',
    readyState: document.readyState,
    fonts: document.fonts && document.fonts.status ? document.fonts.status : 'loaded',
  };
})()`;

function selectorOf(condition) {
  return JSON.stringify(String(condition.selector || ''));
}

function predicate(condition) {
  const selector = selectorOf(condition);
  if (condition.for === 'selector') {
    const state = JSON.stringify(condition.state || 'visible');
    return `(() => {
      const el = document.querySelector(${selector});
      if (!el) return { attached: false, visible: false, state: ${state} };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
      return { attached: true, visible, state: ${state} };
    })()`;
  }
  if (condition.for === 'text-change') {
    if (typeof condition.text !== 'string') throw Object.assign(new Error('text-change requires previous text'), { code: 'invalid-argument' });
    return `(() => {
      const el = ${selector} ? document.querySelector(${selector}) : document.body;
      const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
      return { changed: Boolean(el && normalize(el.innerText) !== normalize(${JSON.stringify(condition.text)})) };
    })()`;
  }
  if (condition.for === 'text') {
    const text = JSON.stringify(String(condition.text || ''));
    return `(() => {
      const body = document.body ? document.body.innerText : '';
      return { found: body.includes(${text}) };
    })()`;
  }
  if (condition.for === 'url') {
    const expected = JSON.stringify(String(condition.url || ''));
    return `(() => ({ href: location.href, matches: location.href.includes(${expected}) }))()`;
  }
  if (condition.for === 'load') {
    return `(() => ({ readyState: document.readyState }))()`;
  }
  if (condition.for === 'settle' || condition.for === 'idle') return SETTLE_EXPRESSION;
  if (condition.for === 'animation') {
    return `(() => {
      const root = ${selector} ? document.querySelector(${selector}) : document.documentElement;
      if (!root) return { attached: false, running: 0 };
      const running = typeof document.getAnimations === 'function'
        ? document.getAnimations().filter(animation => {
            if (!animation || animation.playState !== 'running') return false;
            const target = animation.effect && animation.effect.target;
            return root === document.documentElement || root.contains(target) || target === root;
          }).length
        : 0;
      return { attached: true, running };
    })()`;
  }
  if (condition.for === 'frame') {
    // 支持 selector，也支持快照里的 frame 编号（f1 = 页面里第一个 iframe）。
    const frameIndex = /^f(\d+)$/i.exec(String(condition.frame || ''));
    const target = condition.selector
      ? `document.querySelector(${selector})`
      : frameIndex ? `(document.querySelectorAll('iframe,frame')[${Math.max(0, Number(frameIndex[1]) - 1)}] || null)` : 'null';
    return `(() => {
      const el = ${target};
      if (!el) return { attached: false, ready: false };
      const doc = el.contentDocument;
      if (!doc) return { attached: true, ready: true, crossOrigin: true };
      return { attached: true, ready: doc.readyState === 'complete' && Boolean(doc.body), crossOrigin: false, href: String(doc.location && doc.location.href || '') };
    })()`;
  }
  throw Object.assign(new Error(`unsupported wait: ${condition.for}`), { code: 'invalid-argument' });
}

function satisfied(condition, value) {
  if (condition.for === 'selector') {
    if (condition.state === 'detached') return value.attached === false;
    if (condition.state === 'hidden') return value.visible === false;
    if (condition.state === 'attached') return value.attached === true;
    return value.visible === true;
  }
  if (condition.for === 'text') return value.found === true;
  if (condition.for === 'text-change') return value.changed === true;
  if (condition.for === 'url') return value.matches === true;
  if (condition.for === 'load') return value.readyState === 'complete' || value.readyState === 'interactive';
  if (condition.for === 'settle' || condition.for === 'idle') {
    const quiet = Math.max(50, Math.min(5000, Number(condition.quietMs) || DEFAULT_QUIET_MS));
    const idleFonts = condition.for === 'idle' ? value.fonts !== 'loading' : true;
    return value.busy === false && value.animations === 0 && value.images === 0
      && value.quietMs >= quiet && idleFonts;
  }
  if (condition.for === 'animation') return value.attached !== false && value.running === 0;
  if (condition.for === 'frame') return value.ready === true;
  return false;
}

async function waitFor(cdp, condition = {}) {
  if (condition.for === 'time') {
    const ms = Math.max(0, Math.min(MAX_TIME_WAIT, Number(condition.ms) || 0));
    await delay(ms);
    // 固定等待结束也顺带观察一次页面，避免调用方马上又取一次快照。
    return { ok: true, ms, condition: 'time', hint: 'prefer-conditional' };
  }
  const timeout = Math.max(100, Math.min(120000, Number(condition.timeout) || DEFAULT_TIMEOUT));
  const started = Date.now();
  const expression = predicate(condition);
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, 3000);
      last = result.result?.value ?? null;
      if (last && satisfied(condition, last)) {
        return { ok: true, ms: Date.now() - started, condition: condition.for, value: last };
      }
    } catch (error) {
      const message = String(error?.message || '');
      // Navigation destroys the execution context mid-poll; retry on the new
      // document instead of failing the wait.
      if (error?.code === 'timeout' || /navigated or closed|execution context was destroyed|cannot find context/i.test(message)) {
        await delay(POLL_MS);
        continue;
      }
      throw error;
    }
    await delay(POLL_MS);
  }
  const error = new Error('wait timeout');
  error.code = 'timeout';
  error.detail = { condition: condition.for, last, ms: Date.now() - started };
  throw error;
}

module.exports = {
  waitFor, predicate, satisfied, MAX_TIME_WAIT, DEFAULT_TIMEOUT, POLL_MS, DEFAULT_QUIET_MS, SETTLE_EXPRESSION,
};
