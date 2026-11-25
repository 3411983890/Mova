'use strict';
// 语义动作：先 Pattern（后台生效、不抢焦点），失败再走坐标注入。
// 约定：所有方法都返回 {ok:true, via} 或 {ok:false, code, message}，永不抛异常——
// 上层（tools/session）根据 code 决定升级到坐标/视觉或 handoff。
// input 由 B 号 agent 的 input.cjs 注入，未注入时坐标回退直接返回 pattern-unsupported。

const PATTERN_FALLBACK_CODES = new Set(['pattern-unsupported', 'failed']);

function result(ok, extra) {
  return ok ? { ok: true, ...extra } : { ok: false, ...extra };
}

function fail(code, message) {
  return { ok: false, code: code || 'failed', message: message || code || 'failed' };
}

function refOf(target) {
  if (typeof target === 'string') return target.trim();
  if (target && typeof target === 'object' && typeof target.ref === 'string') return target.ref;
  return '';
}

function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return null;
  for (const name of names) {
    if (typeof obj[name] === 'function') return obj[name].bind(obj);
  }
  return null;
}

// 把未知形状的 input.cjs 归一化成我们需要的几个动作
function adaptInput(input) {
  if (!input || typeof input !== 'object') return null;
  const api = {
    click: pick(input, 'click', 'mouseClick', 'clickAt'),
    moveTo: pick(input, 'moveTo', 'move', 'setCursorPos'),
    typeText: pick(input, 'typeText', 'type', 'sendText', 'pasteText'),
    // input.cjs 暴露的是 pressCombo，没有 key()；不把 pressCombo 排前面的话，
    // api.key 永远是 undefined，按键类动作一律 pattern-unsupported（微信发消息的回车就栽在这）。
    key: pick(input, 'pressCombo', 'key', 'press', 'hotkey', 'sendKey'),
    wheel: pick(input, 'wheel', 'scroll', 'scrollAt'),
    drag: pick(input, 'drag', 'dragTo'),
  };
  const any = Object.values(api).some(Boolean);
  return any ? api : null;
}

function pointOf(rect) {
  if (!rect) return null;
  const w = Number(rect.w !== undefined ? rect.w : rect.width) || 0;
  const h = Number(rect.h !== undefined ? rect.h : rect.height) || 0;
  const x = Number(rect.x) || 0;
  const y = Number(rect.y) || 0;
  if (w <= 0 || h <= 0) return null;
  return { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) };
}

/**
 * @param {object} deps
 * @param {{call:Function}} deps.host
 * @param {object} [deps.input] input.cjs 注入器（可缺省）
 * @param {object} [deps.policy] {check({action,ref}) -> {allow,code,message}}
 */
function createActions({ host, input, policy } = {}) {
  if (!host || typeof host.call !== 'function') {
    const error = new Error('actions 需要 host.call');
    error.code = 'invalid-deps';
    throw error;
  }
  const api = adaptInput(input);

  function policyCheck(action, ref) {
    if (!policy) return null;
    const check = typeof policy === 'function' ? policy : (policy.check || policy.checkAction);
    if (typeof check !== 'function') return null;
    try {
      const verdict = check.call(policy, { action, ref });
      if (verdict && verdict.allow === false) {
        return fail(verdict.code || 'policy-denied', verdict.message || '动作被策略拒绝');
      }
      return null;
    } catch (error) {
      return fail('policy-denied', error && error.message ? error.message : '策略检查失败');
    }
  }

  function noCoordinateInput(what) {
    return fail('pattern-unsupported', `Pattern 不可用且坐标注入缺失（input.${what}）`);
  }

  async function callWorker(cmd, args) {
    try {
      return { ok: true, value: await host.call(cmd, args) };
    } catch (error) {
      return { ok: false, code: (error && error.code) || 'failed', message: (error && error.message) || String(error) };
    }
  }

  async function clickPoint(point, options = {}) {
    if (!api || !api.click) return noCoordinateInput('click');
    try {
      await api.click(point.x, point.y, options);
      return result(true, { via: 'coordinate', point });
    } catch (error) {
      return fail((error && error.code) || 'input-failed', (error && error.message) || '坐标点击失败');
    }
  }

  async function invoke(target) {
    const ref = refOf(target);
    if (!ref) return fail('invalid-args', '需要 ref');
    const blocked = policyCheck('invoke', ref);
    if (blocked) return blocked;

    const res = await callWorker('invoke', { ref });
    if (res.ok) return result(true, { via: 'invoke', ref });
    if (!PATTERN_FALLBACK_CODES.has(res.code)) return fail(res.code, res.message);
    const clicked = await clickByRef(ref);
    return clicked.ok ? { ...clicked, reason: res.code } : clicked;
  }

  async function clickByRef(ref, options = {}) {
    const rectRes = await callWorker('rect', { ref });
    if (!rectRes.ok) return fail(rectRes.code, rectRes.message);
    const point = rectRes.value && Array.isArray(rectRes.value.clickable)
      ? { x: Number(rectRes.value.clickable[0]), y: Number(rectRes.value.clickable[1]) }
      : pointOf(rectRes.value && rectRes.value.rect);
    if (!point) return fail('not-visible', '元素没有可点击矩形');
    const clicked = await clickPoint(point, options);
    if (clicked.ok) clicked.ref = ref;
    return clicked;
  }

  // click = 语义上的“按一下”：先 Invoke，再坐标
  async function click(target, options = {}) {
    const ref = refOf(target);
    if (!ref) {
      if (target && Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y))) {
        const blocked = policyCheck('click', 'point');
        if (blocked) return blocked;
        return clickPoint({ x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) }, options);
      }
      return fail('invalid-args', '需要 ref 或 {x,y}');
    }
    return invoke(target);
  }

  async function focus(ref) {
    const target = refOf(ref);
    if (!target) return fail('invalid-args', '需要 ref');
    const res = await callWorker('focus', { ref: target });
    if (res.ok) return result(true, { via: 'focus', ref: target });
    return fail(res.code, res.message);
  }

  async function type(text, options = {}) {
    if (!api || !api.typeText) return noCoordinateInput('typeText');
    if (typeof text !== 'string') return fail('invalid-args', 'text 必须是字符串');
    try {
      await api.typeText(text, options);
      return result(true, { via: 'input', chars: text.length });
    } catch (error) {
      return fail((error && error.code) || 'input-failed', (error && error.message) || '文本注入失败');
    }
  }

  async function key(combo, options = {}) {
    if (!api || !api.key) return noCoordinateInput('key');
    if (!combo) return fail('invalid-args', '需要按键组合');
    try {
      await api.key(combo, options);
      return result(true, { via: 'input', key: combo });
    } catch (error) {
      return fail((error && error.code) || 'input-failed', (error && error.message) || '按键注入失败');
    }
  }

  async function setValue(target, text, options = {}) {
    const ref = refOf(target);
    if (!ref) return fail('invalid-args', '需要 ref');
    if (typeof text !== 'string') return fail('invalid-args', 'text 必须是字符串');
    const blocked = policyCheck('setValue', ref);
    if (blocked) return blocked;

    const res = await callWorker('setValue', { ref, text });
    if (res.ok) return result(true, { via: 'value', ref });

    // ValuePattern 不可用（Qt/自绘控件常见）：聚焦 + 全选 + 输入
    if (!PATTERN_FALLBACK_CODES.has(res.code)) return fail(res.code, res.message);
    if (!api || !api.typeText) return fail(res.code, res.message || 'ValuePattern 不可用');

    const focused = await focus(ref);
    if (!focused.ok) return fail(focused.code, focused.message);
    const cleared = await key('Ctrl+A');
    if (!cleared.ok) return cleared;
    const typed = await type(text, options);
    if (!typed.ok) return typed;
    return result(true, { via: 'focus+type', ref });
  }

  async function select(target, options = {}) {
    const ref = refOf(target);
    if (!ref) return fail('invalid-args', '需要 ref');
    const op = options.op || 'select';
    const res = await callWorker('pattern', { ref, name: 'selectionitem', args: { op } });
    if (res.ok) return result(true, { via: 'selectionitem', ref, value: res.value && res.value.value });
    if (!PATTERN_FALLBACK_CODES.has(res.code)) return fail(res.code, res.message);
    return clickByRef(ref, options);
  }

  async function toggle(target, options = {}) {
    const ref = refOf(target);
    if (!ref) return fail('invalid-args', '需要 ref');
    const args = {};
    if (options.state === true || options.state === 'on') args.toggle = 'on';
    if (options.state === false || options.state === 'off') args.toggle = 'off';
    const res = await callWorker('pattern', { ref, name: 'toggle', args });
    if (res.ok) {
      return result(true, { via: 'toggle', ref, value: res.value && res.value.value, unchanged: Boolean(res.value && res.value.unchanged) });
    }
    if (!PATTERN_FALLBACK_CODES.has(res.code)) return fail(res.code, res.message);
    return clickByRef(ref, options);
  }

  async function expand(target, options = {}) {
    const ref = refOf(target);
    if (!ref) return fail('invalid-args', '需要 ref');
    const state = options.expand === false ? 'collapse' : 'expand';
    const res = await callWorker('pattern', { ref, name: 'expandcollapse', args: { state } });
    if (res.ok) return result(true, { via: 'expandcollapse', ref, value: res.value && res.value.value });
    if (!PATTERN_FALLBACK_CODES.has(res.code)) return fail(res.code, res.message);
    return clickByRef(ref, options);
  }

  async function scroll(target, options = {}) {
    const ref = refOf(target);
    if (ref) {
      const args = {};
      if (options.intoView) args.intoView = true;
      if (options.horizontal !== undefined) args.horizontal = options.horizontal;
      if (options.vertical !== undefined) args.vertical = options.vertical;
      const res = await callWorker('pattern', { ref, name: options.intoView ? 'scrollitem' : 'scroll', args });
      if (res.ok) return result(true, { via: 'pattern', ref });
      if (!PATTERN_FALLBACK_CODES.has(res.code)) return fail(res.code, res.message);
    }
    if (!api || !api.wheel) return noCoordinateInput('wheel');
    let point = null;
    if (options.x !== undefined && options.y !== undefined) point = { x: Math.round(options.x), y: Math.round(options.y) };
    else if (ref) {
      const rect = await callWorker('rect', { ref });
      point = rect.ok ? (pointOf(rect.value && rect.value.rect) || null) : null;
    }
    if (!point) return fail('not-visible', '没有可以滚动的位置');
    try {
      await api.wheel(point.x, point.y, Number(options.deltaY) || 0);
      return result(true, { via: 'wheel', point });
    } catch (error) {
      return fail((error && error.code) || 'input-failed', (error && error.message) || '滚轮注入失败');
    }
  }

  async function drag(from, to, options = {}) {
    if (!api || !api.drag) return noCoordinateInput('drag');
    const resolve = async (target) => {
      if (!target) return null;
      if (Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y))) {
        return { x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) };
      }
      const ref = refOf(target);
      if (!ref) return null;
      const rect = await callWorker('rect', { ref });
      return rect.ok ? pointOf(rect.value && rect.value.rect) : null;
    };
    const start = await resolve(from);
    const end = await resolve(to);
    if (!start || !end) return fail('not-visible', '拖拽的起点或终点不可见');
    try {
      await api.drag(start, end, options);
      return result(true, { via: 'input', from: start, to: end });
    } catch (error) {
      return fail((error && error.code) || 'input-failed', (error && error.message) || '拖拽失败');
    }
  }

  async function readText(target, options = {}) {
    const ref = refOf(target);
    if (!ref) return fail('invalid-args', '需要 ref');
    const res = await callWorker('readText', { ref, maxChars: options.maxChars });
    if (!res.ok) return fail(res.code, res.message);
    return result(true, { via: 'readText', ref, text: String((res.value && res.value.text) || ''), truncated: Boolean(res.value && res.value.truncated) });
  }

  return {
    invoke,
    click,
    focus,
    type,
    key,
    setValue,
    select,
    toggle,
    expand,
    scroll,
    drag,
    readText,
    clickByRef,
    hasInput: Boolean(api),
    inputActions: api ? Object.keys(api).filter((name) => api[name]) : [],
  };
}

module.exports = { createActions, adaptInput, pick, refOf, pointOf, PATTERN_FALLBACK_CODES };
