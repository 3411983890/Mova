'use strict';
// 会话：单步状态机 + 预算 + observe/act/verify 编排骨架。
// 规定（design/desktop-build-plan.md §2.3 与方案 §7.7、§9.5）：
// - 状态 idle -> running -> paused -> aborted | done；
// - 预算 maxMinutes / maxActions，超了自动 abort('budget')，绝不让模型继续点；
// - abort 顺序：拒绝新动作 -> 释放按键/鼠标 -> 取消在途 -> 隐藏 overlay -> 写审计；
// - guard/overlay/audit/input 全部是注入依赖，没注入就跳过（并行开发时不互相阻塞）。

const { diffTrees } = require('./diff.cjs');
const { normalizeNodes } = require('./tree.cjs');

const STATES = Object.freeze(['idle', 'running', 'paused', 'aborted', 'done']);
const DEFAULT_BUDGET = Object.freeze({ maxMinutes: 10, maxActions: 60 });

/** 后台生效的 via：这些动作没有注入鼠标坐标，不该显示目标描边。 */
const BACKEND_VIAS = /^(pattern|invoke|value|selectionitem|toggle|expandcollapse|focus|readText)$/;

function fail(code, message) {
  return { ok: false, code: code || 'failed', message: message || code || 'failed' };
}

function nowOf(clock) {
  try { return Number(clock()) || Date.now(); } catch { return Date.now(); }
}

async function safe(fn) {
  if (typeof fn !== 'function') return undefined;
  try { return await fn(); } catch { return undefined; }
}

// 语义动作 -> actions.cjs 方法参数
const ACTION_ARGS = {
  invoke: (a) => [a.ref],
  click: (a) => [a.ref || { x: a.x, y: a.y }, a.options || {}],
  focus: (a) => [a.ref],
  type: (a) => [a.text, a.options || {}],
  key: (a) => [a.key || a.combo, a.options || {}],
  setValue: (a) => [a.ref, a.text, a.options || {}],
  select: (a) => [a.ref, a.options || {}],
  toggle: (a) => [a.ref, a.options || {}],
  expand: (a) => [a.ref, a.options || {}],
  scroll: (a) => [a.ref || { x: a.x, y: a.y }, a.options || a],
  drag: (a) => [a.from, a.to, a.options || {}],
  readText: (a) => [a.ref, a.options || {}],
};

const ACTION_TYPES = Object.freeze(Object.keys(ACTION_ARGS));
// type 大小写不敏感：模型常把 readText 写成 readtext / setValue 写成 setvalue
const TYPE_ALIASES = new Map(ACTION_TYPES.map((type) => [type.toLowerCase(), type]));

/**
 * @param {object} options
 * @param {object} [options.deps] {windows, actions, compact, tree, guard, overlay, audit, input, onAbort}
 * @param {object} [options.budget] {maxMinutes, maxActions}
 * @param {Function} [options.clock]
 * @param {object} [options.logger]
 */
function createSession({ deps = {}, budget = {}, clock = Date.now, logger } = {}) {
  let state = 'idle';
  let startedAt = 0;
  let endedAt = 0;
  let actionCount = 0;
  let abortedReason = '';
  let lastCode = '';
  let snapshot = null;
  let previousSnapshot = null;
  let pausedTotal = 0;
  let pausedAt = 0;
  let busy = false;
  const trace = [];
  const limits = { ...DEFAULT_BUDGET, ...budget };

  function elapsedMs() {
    if (!startedAt) return 0;
    const end = endedAt || nowOf(clock);
    const paused = pausedTotal + (pausedAt ? nowOf(clock) - pausedAt : 0);
    return Math.max(0, end - startedAt - paused);
  }

  function status() {
    return {
      state,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      elapsedMs: elapsedMs(),
      actions: actionCount,
      budget: { ...limits },
      reason: abortedReason,
      code: lastCode,
      snapshot: snapshot
        ? { hwnd: snapshot.hwnd, at: snapshot.at, nodes: snapshot.nodes.length, truncated: snapshot.truncated, timedOut: snapshot.timedOut }
        : null,
      trace: trace.slice(-20),
    };
  }

  function canAct() {
    if (state === 'paused') return fail('paused', '会话已暂停');
    if (state === 'aborted') return fail('aborted', `会话已终止（${abortedReason || 'unknown'}）`);
    if (state === 'done') return fail('done', '会话已结束');
    if (state !== 'running') return fail('not-running', '会话未启动');
    return null;
  }

  /**
   * 懒启动：第一次真正要动电脑/读电脑时才开会话。
   * 这是“浮层必须出现”的关键——之前只有显式 start() 才 show()，工具直接 act 就永远不亮。
   */
  async function ensureStarted(options = {}) {
    if (state === 'running' || state === 'paused') return { ok: true, status: status() };
    return start(options);
  }

  function checkBudget() {
    if (actionCount >= limits.maxActions) {
      return fail('budget-exceeded', `动作次数超出预算（${actionCount}/${limits.maxActions}）`);
    }
    const minutes = elapsedMs() / 60000;
    if (minutes >= limits.maxMinutes) {
      return fail('budget-exceeded', `时间超出预算（${minutes.toFixed(1)}/${limits.maxMinutes} min）`);
    }
    return null;
  }

  async function start(options = {}) {
    if (state === 'running') return { ok: true, status: status() };
    state = 'running';
    startedAt = nowOf(clock);
    endedAt = 0;
    actionCount = 0;
    abortedReason = '';
    lastCode = '';
    snapshot = null;
    previousSnapshot = null;
    trace.length = 0;
    pausedTotal = 0;
    pausedAt = 0;
    if (options.budget) Object.assign(limits, options.budget);
    await safe(() => deps.guard && deps.guard.start && deps.guard.start());
    if (deps.overlay && typeof deps.overlay.show === 'function') {
      await safe(() => deps.overlay.show({ displayId: options.displayId, emotion: options.emotion }));
    }
    // 鼠标接管闸门：会话一开始就装钩子（不依赖外部轮询）
    await safe(() => deps.interlock && deps.interlock.start && deps.interlock.start());
    await safe(() => deps.audit && deps.audit.record && deps.audit.record({ type: 'session-start', goal: options.goal || '' }));
    return { ok: true, status: status() };
  }

  function pause(reason = 'manual') {
    if (state !== 'running') return fail('not-running', '只有 running 能暂停');
    state = 'paused';
    pausedAt = nowOf(clock);
    hideTarget();
    // 浮层变红 + 一句话告诉用户怎么恢复（“点击 Mova 恢复操作”）
    void safe(() => deps.overlay && deps.overlay.setState && deps.overlay.setState('paused', {
      note: reason === 'user-click' ? '点击 Mova 恢复操作' : '已暂停',
    }));
    void safe(() => deps.overlay && deps.overlay.update && deps.overlay.update(
      reason === 'user-click' ? '你点了鼠标，已暂停 · 点击 Mova 恢复操作' : '已暂停',
    ));
    logger?.info?.(`[desktop-session] paused (${reason})`);
    return { ok: true, status: status() };
  }

  function resume() {
    if (state !== 'paused') return fail('not-paused', '只有 paused 能恢复');
    pausedTotal += nowOf(clock) - pausedAt;
    pausedAt = 0;
    state = 'running';
    void safe(() => deps.overlay && deps.overlay.setState && deps.overlay.setState('running'));
    void safe(() => deps.overlay && deps.overlay.update && deps.overlay.update('继续操作'));
    return { ok: true, status: status() };
  }

  async function abort(reason = 'user') {
    if (state === 'aborted' || state === 'done') return { ok: true, status: status() };
    // 1) 立刻进入终止态，拒绝新动作
    state = 'aborted';
    abortedReason = String(reason || 'user');
    endedAt = nowOf(clock);
    // 2) 释放按下的鼠标键/修饰键，3) 拖拽中 mouseUp，4) 恢复剪贴板：都交给 guard/input
    await safe(() => deps.input && deps.input.releaseAll && deps.input.releaseAll());
    await safe(() => deps.guard && deps.guard.releaseAll && deps.guard.releaseAll());
    await safe(() => deps.guard && deps.guard.stop && deps.guard.stop());
    await safe(() => deps.interlock && deps.interlock.stop && deps.interlock.stop());
    // 5) 取消在途审批/截图
    await safe(() => deps.cancelPending && deps.cancelPending());
    // 6) 隐藏 overlay
    hideTarget();
    await safe(() => deps.overlay && deps.overlay.hide && deps.overlay.hide());
    // 7) 审计 + 通知
    await safe(() => deps.audit && deps.audit.record && deps.audit.record({ type: 'aborted', reason: abortedReason, actions: actionCount }));
    await safe(() => deps.onAbort && deps.onAbort(abortedReason));
    logger?.warn?.(`[desktop-session] aborted: ${abortedReason}`);
    return { ok: true, status: status() };
  }

  async function finish(result = {}) {
    if (state === 'aborted') return { ok: true, status: status() };
    state = 'done';
    endedAt = nowOf(clock);
    lastCode = result.code || 'done';
    await safe(() => deps.guard && deps.guard.stop && deps.guard.stop());
    hideTarget();
    await safe(() => deps.overlay && deps.overlay.hide && deps.overlay.hide());
    await safe(() => deps.audit && deps.audit.record && deps.audit.record({ type: 'session-done', actions: actionCount, code: lastCode }));
    return { ok: true, status: status() };
  }

  /* ── §12.7 目标控件描边：只在“真的要注入坐标”前画，Pattern 后台调用不画 ── */
  const TARGET_HOLD_MS = 1200;
  let targetTimer = null;

  function clearTargetTimer() {
    if (targetTimer) {
      clearTimeout(targetTimer);
      targetTimer = null;
    }
  }

  /** 从动作里抠出屏幕矩形：locator.rect / rect，支持 [x,y,w,h] 与 {x,y,w,h}。 */
  function targetRectOf(action) {
    const source = (action && action.locator) || {};
    const raw = source.rect || (action && action.rect) || null;
    if (!raw) return null;
    if (Array.isArray(raw)) {
      const [x, y, w, h] = raw;
      return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null;
    }
    if (typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w === undefined ? raw.width : raw.w);
    const h = Number(raw.h === undefined ? raw.height : raw.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  function showTarget(rect, label) {
    if (!rect || !deps.overlay || typeof deps.overlay.setTarget !== 'function') return;
    try {
      deps.overlay.setTarget(rect, label ? { label: String(label).slice(0, 40) } : undefined);
    } catch (error) {
      logger?.warn?.(`[desktop-session] setTarget 失败: ${(error && error.message) || error}`);
      return;
    }
    clearTargetTimer();
    targetTimer = setTimeout(() => hideTarget(), TARGET_HOLD_MS);
    if (targetTimer && typeof targetTimer.unref === 'function') targetTimer.unref();
  }

  function hideTarget() {
    clearTargetTimer();
    if (!deps.overlay || typeof deps.overlay.setTarget !== 'function') return;
    try { deps.overlay.setTarget(null); } catch { /* 浮层可能已经销毁 */ }
  }

  async function observeTargetHwnd(options = {}) {
    if (options.hwnd) return Number(options.hwnd);
    if (snapshot && snapshot.hwnd) return snapshot.hwnd;
    if (deps.windows && typeof deps.windows.foreground === 'function') {
      const win = await safe(() => deps.windows.foreground());
      if (win && win.hwnd) return Number(win.hwnd);
    }
    return 0;
  }

  // 读一次树 -> 紧凑文本；快照存起来给 verify 做基线
  async function observe(options = {}) {
    const blocked = canAct();
    if (blocked) return blocked;
    if (!deps.windows || typeof deps.windows.tree !== 'function') return fail('unavailable', '没有窗口模块');
    const hwnd = await observeTargetHwnd(options);
    if (!hwnd) return fail('no-window', '找不到目标窗口');

    const started = nowOf(clock);
    let tree;
    try {
      tree = await deps.windows.tree(hwnd, {
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
        deadlineMs: options.deadlineMs,
        includeOffscreen: options.includeOffscreen,
      });
    } catch (error) {
      lastCode = (error && error.code) || 'failed';
      return fail(lastCode, (error && error.message) || '读取窗口树失败');
    }

    const nodes = normalizeNodes(tree.nodes);
    const compacted = typeof deps.compact === 'function'
      ? deps.compact(nodes, { maxChars: options.maxChars, boxes: options.boxes === true, window: tree.window })
      : { text: '', lines: [], kept: nodes.length, chars: 0, truncated: false };

    previousSnapshot = snapshot;
    snapshot = {
      hwnd,
      window: tree.window,
      nodes,
      text: compacted.text,
      lines: compacted.lines,
      kept: compacted.kept,
      chars: compacted.chars,
      truncated: Boolean(tree.truncated || compacted.truncated),
      timedOut: Boolean(tree.timedOut),
      at: new Date(nowOf(clock)).toISOString(),
    };
    return {
      ok: true,
      hwnd,
      window: tree.window,
      text: compacted.text,
      nodes: nodes.length,
      kept: compacted.kept,
      chars: compacted.chars,
      truncated: snapshot.truncated,
      timedOut: snapshot.timedOut,
      elapsedMs: nowOf(clock) - started,
      refsValid: true,
    };
  }

  // 执行一个语义动作；action = {type, ref, text, key, ...}
  async function act(action = {}) {
    // 任何写动作都先确保会话已开始（否则不会有浮层、不会有鼠标锁、也不会有守护）
    if (state === 'idle' || state === 'done') {
      const started = await ensureStarted({ goal: action.goal || '', displayId: action.displayId });
      if (!started || started.ok === false) return started || fail('not-running', '会话启动失败');
    }
    const blocked = canAct();
    if (blocked) return blocked;
    const requested = String(action.type || '');
    const type = TYPE_ALIASES.get(requested.toLowerCase()) || '';
    if (!type) return fail('invalid-args', `未知动作 ${requested || '(空)'}`);
    if (!deps.actions || typeof deps.actions[type] !== 'function') return fail('unavailable', `actions.${type} 不可用`);
    const budgetBlocked = checkBudget();
    if (budgetBlocked) {
      await abort('budget');
      return budgetBlocked;
    }

    const started = nowOf(clock);
    let result;
    // 真实注入前先画描边：用户要能看见“它要点哪里”。Pattern 后台调用会在返回后立刻收掉。
    const targetRect = targetRectOf(action);
    if (targetRect && state === 'running') {
      showTarget(targetRect, (action.locator && (action.locator.name || action.locator.role)) || action.target || '');
    }
    try {
      result = await deps.actions[type](...ACTION_ARGS[type](action));
    } catch (error) {
      result = fail((error && error.code) || 'failed', (error && error.message) || '动作执行失败');
    }
    if (!result || typeof result !== 'object') result = fail('failed', '动作没有返回结果');
    // 后台生效（UIA Pattern / invoke）没有注入坐标，不该有描边：立刻收，不留残影。
    if (BACKEND_VIAS.test(String(result.via || ''))) hideTarget();

    actionCount += 1;
    lastCode = result.ok ? 'ok' : (result.code || 'failed');
    const entry = {
      at: new Date(nowOf(clock)).toISOString(),
      ts: started,
      type,
      // op 与 locator 是为了让 compiler.stepsFromTrace 能直接吃这条 trace（见 design/desktop-handoff.md §3.1）。
      // locator = {stableKey|path|name|role|rect}，由调用方（tools.cjs）在 inspect 之后带上。
      op: type,
      ref: action.ref || '',
      ...(action.locator && typeof action.locator === 'object' ? { locator: action.locator, ...action.locator } : {}),
      ...(action.value !== undefined ? { value: action.value } : {}),
      ...(action.keys !== undefined ? { keys: action.keys } : {}),
      ok: result.ok === true,
      code: result.code || '',
      via: result.via || '',
      ms: nowOf(clock) - started,
    };
    trace.push(entry);
    if (trace.length > 200) trace.shift();

    await safe(() => deps.audit && deps.audit.record && deps.audit.record({
      type: 'action',
      action: type,
      ref: action.ref || '',
      ok: entry.ok,
      code: entry.code,
      via: entry.via,
      ms: entry.ms,
    }));
    // refs 只对当前快照有效：动作后快照作废，等下一次 observe
    if (result.ok) {
      previousSnapshot = snapshot;
      snapshot = null;
    }
    return { ...result, ms: entry.ms, actions: actionCount };
  }

  /**
   * 用 verify.cjs 的条件引擎判一次：pixels / focused / element 这些 diff 判不出来的东西
   * （自绘界面如微信，UIA 树几乎是空的，只有像素能说明“界面真的变了”）。
   */
  async function verifyConditions(conditions, { hwnd, options }) {
    const results = [];
    for (const condition of conditions) {
      const ctx = {
        hwnd,
        timeoutMs: Math.max(0, Number(options.timeoutMs) || 0),
        intervalMs: Math.max(40, Number(options.intervalMs) || 120),
        before: previousSnapshot,
        nodes: (snapshot && snapshot.nodes) || [],
        window: (snapshot && snapshot.window) || null,
      };
      ctx.read = async () => {
        const tree = await deps.windows.tree(hwnd, {
          maxDepth: options.maxDepth,
          maxNodes: options.maxNodes,
          deadlineMs: options.deadlineMs,
        });
        return { nodes: normalizeNodes(tree.nodes), window: tree.window, tree, before: previousSnapshot };
      };
      let verdict;
      try {
        verdict = await deps.verify.check(condition, ctx);
      } catch (error) {
        verdict = { ok: false, code: (error && error.code) || 'verify-failed', detail: { message: error && error.message } };
      }
      const row = {
        kind: String(condition.kind || condition.type || ''),
        ok: Boolean(verdict && verdict.ok),
        code: (verdict && verdict.code) || '',
        detail: (verdict && verdict.detail) || null,
      };
      results.push(row);
      if (!row.ok) return { ok: false, code: row.code || 'verify-failed', conditions: results, condition: row };
    }
    return { ok: true, met: true, conditions: results };
  }

  // 验证：动作后重新读树，用 ΔTree 判断有没有变化（changed:false => no-change）
  async function verify(options = {}) {
    const blocked = canAct();
    if (blocked) return blocked;
    const conditions = Array.isArray(options.conditions)
      ? options.conditions.filter(Boolean)
      : (options.condition ? [options.condition] : []);
    if (conditions.length && deps.verify && typeof deps.verify.check === 'function') {
      const hwndForConditions = await observeTargetHwnd(options);
      if (!hwndForConditions) return fail('no-window', '找不到目标窗口');
      const verdict = await verifyConditions(conditions, { hwnd: hwndForConditions, options });
      return verdict.ok ? { ...verdict, changed: true } : verdict;
    }
    const baseline = snapshot || previousSnapshot;
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 1200);
    const intervalMs = Math.max(40, Number(options.intervalMs) || 120);
    const deadline = nowOf(clock) + timeoutMs;
    const hwnd = await observeTargetHwnd(options);
    if (!hwnd) return fail('no-window', '找不到目标窗口');
    if (!deps.windows || typeof deps.windows.tree !== 'function') return fail('unavailable', '没有窗口模块');

    let last;
    for (;;) {
      let tree;
      try {
        tree = await deps.windows.tree(hwnd, {
          maxDepth: options.maxDepth,
          maxNodes: options.maxNodes,
          deadlineMs: options.deadlineMs,
        });
      } catch (error) {
        return fail((error && error.code) || 'failed', (error && error.message) || '验证时读取窗口树失败');
      }
      const nodes = normalizeNodes(tree.nodes);
      const diff = diffTrees(baseline ? baseline.nodes : [], nodes, { window: tree.window && tree.window.title });
      last = { nodes, tree, diff };

      const expectationMet = matchesExpect(options.expect, nodes, diff);
      if (diff.changed || expectationMet) {
        snapshot = {
          hwnd,
          window: tree.window,
          nodes,
          text: '',
          lines: [],
          kept: nodes.length,
          chars: 0,
          truncated: Boolean(tree.truncated),
          timedOut: Boolean(tree.timedOut),
          at: new Date(nowOf(clock)).toISOString(),
        };
        return {
          ok: true,
          changed: Boolean(diff.changed),
          fallback: Boolean(diff.fallback),
          expect: optionString(options.expect),
          met: expectationMet,
          diff,
          text: diff.text,
          changedCount: diff.changedCount,
        };
      }
      if (nowOf(clock) >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return {
      ok: true,
      changed: false,
      fallback: Boolean(last && last.diff.fallback),
      expect: optionString(options.expect),
      met: false,
      code: 'no-change',
      diff: last ? last.diff : null,
      text: last ? last.diff.text : '',
      changedCount: 0,
    };
  }

  function matchesExpect(expect, nodes, diff) {
    if (!expect) return false;
    if (typeof expect === 'function') {
      try { return Boolean(expect(nodes, diff)); } catch { return false; }
    }
    if (typeof expect === 'string') {
      const needle = expect;
      return nodes.some((node) => node.name === needle || (node.name && node.name.includes(needle)));
    }
    if (typeof expect === 'object') {
      const role = expect.role ? String(expect.role).toLowerCase() : '';
      const name = expect.name ? String(expect.name) : '';
      return nodes.some((node) => (!role || node.role === role) && (!name || node.name === name));
    }
    return false;
  }

  function optionString(expect) {
    if (!expect) return '';
    if (typeof expect === 'string') return expect;
    if (typeof expect === 'object') return [expect.role, expect.name].filter(Boolean).join(':');
    return 'fn';
  }

  function setBudget(patch = {}) {
    if (Number.isFinite(patch.maxMinutes) && patch.maxMinutes > 0) limits.maxMinutes = patch.maxMinutes;
    if (Number.isFinite(patch.maxActions) && patch.maxActions > 0) limits.maxActions = patch.maxActions;
    return { ...limits };
  }

  return {
    STATES,
    start,
    pause,
    resume,
    abort,
    finish,
    observe,
    act,
    verify,
    status,
    checkBudget,
    setBudget,
    get state() { return state; },
    get snapshot() { return snapshot; },
    get actions() { return actionCount; },
    get budget() { return { ...limits }; },
    get busy() { return busy; },
    set busy(value) { busy = Boolean(value); },
    ACTION_TYPES,
  };
}

module.exports = { createSession, STATES, DEFAULT_BUDGET, ACTION_TYPES, ACTION_ARGS };
