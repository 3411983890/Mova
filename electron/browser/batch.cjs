'use strict';
// Sequential declarative batch. One tool call runs up to 30 steps; every step
// is authorized separately and the batch stops on the first failure unless the
// caller asked to continue. A single diff at the end keeps the result small.
//
// 2026-11 提速改动：
// - 批处理超时不再丢弃已完成步骤：返回 partial + 逐步结果，模型知道走到哪一步，
//   不用重跑整段（这是「减少错误重试」的一半）。
// - 步骤里的固定等待自动改成条件等待（settle），页面一直在动才退回真实等待。
// - navigate 步骤可以 observe:true 直接带回快照，省掉一次额外往返。

const { classifyFailure } = require('./timing.cjs');

const MAX_STEPS = 30;
const DEFAULT_TIMEOUT = 90000;
const SETTLE_CONVERT_MS = 250;
const DEFAULT_QUIET_MS = 150;

function coded(code, message, detail) {
  const error = new Error(message || code);
  error.code = code;
  if (detail) error.detail = detail;
  return error;
}

/** 等待条件缺省时按字段推断，避免模型写 {op:"wait", selector:"#x"} 后被判非法。 */
function waitConditionOf(step = {}) {
  if (step.for) return step.for;
  if (step.selector) return 'selector';
  if (typeof step.text === 'string') return 'text';
  if (step.url) return 'url';
  if (Number.isFinite(Number(step.ms))) return 'time';
  return 'settle';
}

async function waitStep(target, step) {
  const condition = { ...step, for: waitConditionOf(step) };
  if (condition.for !== 'time') {
    await target.wait(condition);
    return { condition: condition.for };
  }
  // 固定等待只当作「先让页面动一下」：超过 250 ms 就先试条件等待，
  // 条件不成立（页面一直有动画/请求）才退回真实延时。
  const ms = Math.max(0, Number(step.ms) || 0);
  if (ms > SETTLE_CONVERT_MS) {
    try {
      await target.wait({
        for: 'settle',
        quietMs: Number.isInteger(step.quietMs) ? step.quietMs : DEFAULT_QUIET_MS,
        timeout: Math.max(500, Math.min(ms * 4, 15000)),
      });
      return { condition: 'settle', convertedFrom: 'time', ms };
    } catch { /* 页面一直在动：保持原来的语义 */ }
  }
  await target.wait({ for: 'time', ms });
  return { condition: 'time', ms };
}

async function runBatch(target, steps, options = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw coded('invalid-argument', 'steps must be a non-empty array');
  if (steps.length > MAX_STEPS) throw coded('invalid-argument', `at most ${MAX_STEPS} steps`);
  const timeout = Number.isInteger(options.timeout) ? Math.min(Math.max(options.timeout, 1000), 180000) : DEFAULT_TIMEOUT;
  const started = Date.now();
  const results = [];
  let ok = true;
  let failedAt = null;
  let timedOutAt = null;
  let observed = false;

  for (let index = 0; index < steps.length; index += 1) {
    if (Date.now() - started > timeout) {
      // 超时是「未确定」，不是「什么都没发生」：已完成的步骤必须原样交回去。
      timedOutAt = index;
      break;
    }
    const step = steps[index] || {};
    const op = String(step.op || step.action || '').toLowerCase();
    if (!op) throw coded('invalid-argument', 'step.op is required', { step: index });

    try {
      if (typeof options.authorize === 'function') await options.authorize({ ...step, action: op });
    } catch (error) {
      // 授权/停手发生在某一步：把已完成的前缀一起交回去，模型才知道不用重放。
      error.detail = {
        ...(error.detail || {}),
        step: index,
        op,
        completed: results.map(row => ({ i: row.i, op: row.op, ok: row.ok })),
        completedCount: results.length,
      };
      throw error;
    }

    const at = Date.now();
    try {
      if (op === 'navigate') {
        if (typeof step.url !== 'string' || !step.url) throw coded('invalid-argument', 'navigate needs url');
        const info = await target.navigate(step.url, { timeout: step.timeout });
        results.push({
          i: index, op, ok: true, outcome: 'ok', ms: Date.now() - at,
          url: info?.url, title: info?.title,
        });
        if (step.observe === true) {
          const after = await target.snapshot({ mode: 'auto', ...(Number.isInteger(step.maxChars) ? { maxChars: step.maxChars } : {}) });
          results.at(-1).snapshot = { mode: after.mode, text: after.text };
          observed = true;
        }
      } else if (op === 'wait') {
        const waited = await waitStep(target, step);
        results.push({ i: index, op, ok: true, outcome: 'ok', ms: Date.now() - at, ...waited });
      } else if (['click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll'].includes(op)) {
        const outcome = await target.act({ ...step, action: op, snapshot: false });
        if (outcome?.ok === false) throw coded(outcome.status || 'action-failed', outcome.message);
        if (outcome?.verification?.matched === false) throw coded('expect-failed', outcome.verification.message);
        results.push({
          i: index, op, ok: true, outcome: 'ok', ms: Date.now() - at,
          ...(outcome?.noOp === true ? { noOp: true } : {}),
          ...(outcome?.summary ? { summary: outcome.summary } : {}),
        });
      } else {
        throw coded('invalid-argument', `unsupported step: ${op}`);
      }
    } catch (error) {
      ok = false;
      failedAt = index;
      const failure = classifyFailure(error);
      results.push({
        i: index, op, ok: false, ms: Date.now() - at,
        code: failure.code,
        outcome: failure.outcome,
        ...(failure.indeterminate ? { indeterminate: true } : {}),
        message: error?.message || 'step failed',
        ...(error?.suggestion ? { suggestion: error.suggestion } : {}),
      });
      if (options.continueOnError !== true) break;
    }
  }

  // 批量末尾只取一份快照；超时时也取一份，让模型看到「现在页面是什么样」。
  let snapshot = null;
  if (options.snapshot !== 'none' && typeof target.snapshot === 'function') {
    try {
      const current = await target.snapshot({ mode: options.snapshot === 'full' ? 'full' : 'auto' });
      snapshot = { mode: current.mode, text: current.text };
    } catch { /* a failed snapshot must not hide the step results */ }
  }

  const ms = Date.now() - started;
  const base = { steps: results, failedAt, ms, ...(snapshot ? { snapshot } : {}) };
  if (timedOutAt !== null) {
    return {
      ok: false,
      code: 'batch-timeout',
      outcome: 'unknown',
      indeterminate: true,
      partial: true,
      timedOutAt,
      timeout,
      finished: results.length,
      expected: steps.length,
      suggestion: '批处理超时：上面已完成的步骤是真的做过了。先看末尾快照确认页面状态，只补做剩下的步骤，不要从头重放。',
      ...base,
    };
  }
  return { ok, outcome: ok ? 'ok' : classifyFailure({ code: results.at(-1)?.code }).outcome, ...base, ...(observed ? { observed: true } : {}) };
}

module.exports = { runBatch, waitStep, waitConditionOf, MAX_STEPS, DEFAULT_TIMEOUT, SETTLE_CONVERT_MS };
