'use strict';
// 后置条件验证：动作之后“到底成没成”。
// 只做判定，不做动作、不读 worker —— 数据由 session/tools 通过 ctx 注入，
// 所以这里能在 node 下单测（sharp 也走注入）。
//
// 条件类型（照 design/desktop-build-plan.md §2.2 与方案 §9.5）：
//   {kind:'tree-changed'}                      树有变化（ΔTree.changed）
//   {kind:'window', title}                     前台/目标窗口标题匹配
//   {kind:'element', stableKey, present?}      元素出现（present:false 则要求消失）
//   {kind:'focused', stableKey?|role?+name?}   焦点落在目标上
//   {kind:'text', value, role?}                树里 name/value 包含该文本
//   {kind:'pixels', before, after, threshold}  区域平均绝对差超过阈值（默认 2%）
//
// 返回 {ok, code, detail}；code 见 CODES。

const CODES = Object.freeze({
  OK: 'ok',
  NO_CHANGE: 'no-change',
  TIMEOUT: 'condition-timeout',
  WRONG_WINDOW: 'wrong-window',
  ELEMENT_MISSING: 'element-missing',
  NOT_FOCUSED: 'not-focused',
  TEXT_MISSING: 'text-missing',
  PIXELS_UNCHANGED: 'pixels-unchanged',
  NO_BASELINE: 'no-baseline',
  INVALID_CONDITION: 'invalid-condition',
  DIFF_UNAVAILABLE: 'diff-unavailable',
  PIXELS_UNAVAILABLE: 'pixels-unavailable',
  FAILED: 'verify-failed',
});

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_INTERVAL_MS = 120;
const DEFAULT_PIXEL_THRESHOLD = 0.02;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nodesOf(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.nodes)) return input.nodes;
  if (input.tree && Array.isArray(input.tree.nodes)) return input.tree.nodes;
  return [];
}

function windowTitleOf(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input.title === 'string') return input.title;
  if (input.window && typeof input.window.title === 'string') return input.window.title;
  return '';
}

function stableKeyOf(node) {
  if (!node) return '';
  if (typeof node.stableKey === 'string' && node.stableKey) return node.stableKey;
  if (typeof node.key === 'string' && node.key) return node.key.replace(/#\d+$/, '');
  return '';
}

function textOf(node) {
  const parts = [node.name, node.value, node.text, node.automationId];
  return parts.filter((part) => typeof part === 'string' && part).join('\n');
}

function normalizeRegion(raw) {
  if (!raw) return null;
  const x = Math.max(0, Math.round(num(raw.x)));
  const y = Math.max(0, Math.round(num(raw.y)));
  const w = Math.max(1, Math.round(num(raw.w !== undefined ? raw.w : raw.width)));
  const h = Math.max(1, Math.round(num(raw.h !== undefined ? raw.h : raw.height)));
  return { x, y, w, h };
}

function bufferOf(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return { buffer: input, region: null };
  if (Buffer.isBuffer(input.buffer)) return { buffer: input.buffer, region: normalizeRegion(input.region) };
  if (Buffer.isBuffer(input.data)) return { buffer: input.data, region: normalizeRegion(input.region) };
  return null;
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.diff] (prev, next, options) => ΔTree（默认用 diff.cjs）
 * @param {object} [deps.sharp] sharp（pixels 条件用；默认尝试 require）
 * @param {Function} [deps.sleep]
 */
function createVerifier(deps = {}) {
  let diffFn = typeof deps.diff === 'function' ? deps.diff : null;
  let sharpFn = deps.sharp || null;
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function diffOf(prev, next) {
    if (!diffFn) {
      try { diffFn = require('./diff.cjs').diffTrees; } catch { diffFn = null; }
    }
    if (!diffFn) return null;
    return diffFn(prev, next);
  }

  function getSharp() {
    if (sharpFn) return sharpFn;
    try { sharpFn = require('sharp'); } catch { sharpFn = null; }
    return sharpFn;
  }

  function pickCurrent(ctx) {
    return ctx.after || ctx.tree || ctx.nodes || ctx.current || null;
  }

  function pickBefore(ctx) {
    return ctx.before || ctx.previous || ctx.baseline || null;
  }

  /** 判断一条条件；ctx 是数据快照（可能由 ctx.read() 刷新多次）。 */
  async function evaluate(condition, ctx) {
    const kind = String((condition && (condition.kind || condition.type)) || '').toLowerCase();
    if (!kind) return { ok: false, code: CODES.INVALID_CONDITION, detail: { reason: 'missing-kind' } };

    if (kind === 'tree-changed' || kind === 'changed') {
      const before = pickBefore(ctx);
      if (!before) return { ok: false, code: CODES.NO_BASELINE, detail: { reason: 'no-before-tree' } };
      const current = pickCurrent(ctx);
      const result = diffOf(before, current);
      if (!result) return { ok: false, code: CODES.DIFF_UNAVAILABLE, detail: { reason: 'diff-module-missing' } };
      if (result.fallback) {
        // 首次快照 / 变化过大：把 fallback 当成“变了”，但不假装精确
        return { ok: true, code: CODES.OK, detail: { changed: true, fallback: true, changedCount: num(result.changedCount) } };
      }
      if (!result.changed) {
        return { ok: false, code: CODES.NO_CHANGE, detail: { changedCount: 0, text: result.text || '' } };
      }
      return { ok: true, code: CODES.OK, detail: { changed: true, changedCount: num(result.changedCount), text: result.text || '' } };
    }

    if (kind === 'window' || kind === 'window-title') {
      const expected = typeof condition.title === 'string' ? condition.title : (typeof condition.value === 'string' ? condition.value : '');
      const actual = windowTitleOf(pickCurrent(ctx) || ctx.window || ctx);
      if (!actual) return { ok: false, code: CODES.WRONG_WINDOW, detail: { expected, actual: '', reason: 'no-window' } };
      if (condition.hwnd !== undefined && ctx.window && num(ctx.window.hwnd) !== num(condition.hwnd)) {
        return { ok: false, code: CODES.WRONG_WINDOW, detail: { expected: condition.hwnd, actual: ctx.window.hwnd } };
      }
      if (!expected) return { ok: true, code: CODES.OK, detail: { actual } };
      const exact = condition.exact === true;
      const hit = exact
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual.toLowerCase().includes(expected.toLowerCase());
      return hit
        ? { ok: true, code: CODES.OK, detail: { actual, expected } }
        : { ok: false, code: CODES.WRONG_WINDOW, detail: { actual, expected } };
    }

    if (kind === 'element') {
      const nodes = nodesOf(pickCurrent(ctx));
      const present = condition.present !== false;
      const wantedKey = typeof condition.stableKey === 'string' ? condition.stableKey : '';
      const role = condition.role ? String(condition.role).toLowerCase() : '';
      const name = condition.name ? String(condition.name) : '';
      if (!wantedKey && !role && !name) {
        return { ok: false, code: CODES.INVALID_CONDITION, detail: { reason: 'element-needs-stableKey-or-role/name' } };
      }
      const hit = nodes.find((node) => {
        if (wantedKey && stableKeyOf(node) !== wantedKey.replace(/#\d+$/, '')) return false;
        if (role && String(node.role || '').toLowerCase() !== role) return false;
        if (name && !String(node.name || '').includes(name)) return false;
        return true;
      });
      if (present) {
        return hit
          ? { ok: true, code: CODES.OK, detail: { stableKey: stableKeyOf(hit), role: hit.role, name: hit.name } }
          : { ok: false, code: CODES.ELEMENT_MISSING, detail: { stableKey: wantedKey, role, name, nodes: nodes.length } };
      }
      return hit
        ? { ok: false, code: CODES.ELEMENT_MISSING, detail: { stableKey: wantedKey, reason: 'still-present' } }
        : { ok: true, code: CODES.OK, detail: { stableKey: wantedKey, reason: 'gone' } };
    }

    if (kind === 'focused') {
      const nodes = nodesOf(pickCurrent(ctx));
      const wanted = typeof condition.stableKey === 'string' ? condition.stableKey.replace(/#\d+$/, '') : '';
      const role = condition.role ? String(condition.role).toLowerCase() : '';
      const name = condition.name ? String(condition.name) : '';
      const focusedNode = nodes.find((node) => node.states && node.states.focused === true)
        || (ctx.focused && typeof ctx.focused === 'object' ? ctx.focused : null);
      if (!focusedNode) {
        const bare = pickCurrent(ctx);
        if (ctx.focused === true || (bare && bare.focused === true)) {
          return { ok: true, code: CODES.OK, detail: { focused: true } };
        }
        return { ok: false, code: CODES.NOT_FOCUSED, detail: { reason: 'no-focused-node' } };
      }
      if (!wanted && !role && !name) return { ok: true, code: CODES.OK, detail: { stableKey: stableKeyOf(focusedNode) } };
      const keyHit = wanted ? stableKeyOf(focusedNode) === wanted : true;
      const roleHit = role ? String(focusedNode.role || '').toLowerCase() === role : true;
      const nameHit = name ? String(focusedNode.name || '').includes(name) : true;
      return keyHit && roleHit && nameHit
        ? { ok: true, code: CODES.OK, detail: { stableKey: stableKeyOf(focusedNode), role: focusedNode.role, name: focusedNode.name } }
        : {
          ok: false,
          code: CODES.NOT_FOCUSED,
          detail: { expected: { stableKey: wanted, role, name }, actual: { stableKey: stableKeyOf(focusedNode), role: focusedNode.role, name: focusedNode.name } },
        };
    }

    if (kind === 'text') {
      const value = typeof condition.value === 'string' ? condition.value : (typeof condition.text === 'string' ? condition.text : '');
      if (!value) return { ok: false, code: CODES.INVALID_CONDITION, detail: { reason: 'text-needs-value' } };
      const role = condition.role ? String(condition.role).toLowerCase() : '';
      const nodes = nodesOf(pickCurrent(ctx));
      const needle = value.toLowerCase();
      const hit = nodes.find((node) => {
        if (role && String(node.role || '').toLowerCase() !== role) return false;
        return textOf(node).toLowerCase().includes(needle);
      });
      return hit
        ? { ok: true, code: CODES.OK, detail: { value, stableKey: stableKeyOf(hit), name: hit.name } }
        : { ok: false, code: CODES.TEXT_MISSING, detail: { value, nodes: nodes.length } };
    }

    if (kind === 'pixels') {
      const before = bufferOf(condition.before || (ctx.pixels && ctx.pixels.before) || pickBefore(ctx));
      const after = bufferOf(condition.after || (ctx.pixels && ctx.pixels.after) || pickCurrent(ctx));
      if (!before || !after) {
        return { ok: false, code: CODES.PIXELS_UNAVAILABLE, detail: { reason: 'missing-buffer' } };
      }
      const sharp = getSharp();
      if (!sharp) return { ok: false, code: CODES.PIXELS_UNAVAILABLE, detail: { reason: 'sharp-missing' } };
      const threshold = Number.isFinite(Number(condition.threshold)) ? Number(condition.threshold) : DEFAULT_PIXEL_THRESHOLD;
      try {
        const region = normalizeRegion(condition.region) || before.region || after.region;
        const readRaw = async (entry) => {
          let pipeline = sharp(entry.buffer);
          let area = region;
          if (area) {
            const meta = await sharp(entry.buffer).metadata();
            // region 越界时退化为整图，避免 extract 抛错把验证变成异常
            if (area.x + area.w > (meta.width || 0) || area.y + area.h > (meta.height || 0)) area = null;
          }
          if (area) pipeline = pipeline.extract({ left: area.x, top: area.y, width: area.w, height: area.h });
          return pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
        };
        const a = await readRaw(before);
        const b = await readRaw(after);
        const count = Math.min(a.data.length, b.data.length);
        if (!count) return { ok: false, code: CODES.PIXELS_UNAVAILABLE, detail: { reason: 'empty-image' } };
        let sum = 0;
        for (let i = 0; i < count; i += 1) sum += Math.abs(a.data[i] - b.data[i]);
        const meanAbsDiff = sum / count / 255;
        if (meanAbsDiff < threshold) {
          return { ok: false, code: CODES.PIXELS_UNCHANGED, detail: { meanAbsDiff: Number(meanAbsDiff.toFixed(4)), threshold } };
        }
        return { ok: true, code: CODES.OK, detail: { meanAbsDiff: Number(meanAbsDiff.toFixed(4)), threshold, region: region || null } };
      } catch (error) {
        return { ok: false, code: CODES.PIXELS_UNAVAILABLE, detail: { reason: (error && error.message) || 'sharp-failed' } };
      }
    }

    return { ok: false, code: CODES.INVALID_CONDITION, detail: { kind } };
  }

  /** 轮询 ctx.read()（可选）直到条件满足或超时。 */
  async function check(condition, ctx = {}) {
    try {
      const kind = String((condition && (condition.kind || condition.type)) || '').toLowerCase();
      if (!kind) return { ok: false, code: CODES.INVALID_CONDITION, detail: { reason: 'missing-kind' } };
      const timeoutMs = Math.max(0, num(ctx.timeoutMs, condition.timeoutMs !== undefined ? condition.timeoutMs : DEFAULT_TIMEOUT_MS));
      const intervalMs = Math.max(20, num(ctx.intervalMs, DEFAULT_INTERVAL_MS));
      const read = typeof ctx.read === 'function' ? ctx.read : null;
      const started = Date.now();

      let state = ctx;
      let last = await evaluate(condition, state);
      if (last.ok || !read) return last;

      while (Date.now() - started < timeoutMs) {
        await sleep(intervalMs);
        try {
          const fresh = await read();
          state = { ...ctx, ...(fresh && typeof fresh === 'object' ? fresh : { after: fresh }) };
        } catch (error) {
          return { ok: false, code: (error && error.code) || CODES.FAILED, detail: { reason: (error && error.message) || 'read-failed' } };
        }
        last = await evaluate(condition, state);
        if (last.ok) return last;
      }
      return {
        ok: false,
        code: CODES.TIMEOUT,
        detail: { lastCode: last.code, lastDetail: last.detail, elapsedMs: Date.now() - started, kind },
      };
    } catch (error) {
      return { ok: false, code: (error && error.code) || CODES.FAILED, detail: { reason: (error && error.message) || 'verify-failed' } };
    }
  }

  return {
    check,
    evaluate,
    diff: (prev, next) => diffOf(prev, next),
    codes: CODES,
  };
}

module.exports = { createVerifier, CODES, DEFAULT_TIMEOUT_MS, DEFAULT_PIXEL_THRESHOLD };
