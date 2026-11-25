'use strict';
// 端到端计时账本：一轮对话里把时间拆到「模型 / 工具 / 人工等待 / 扩展通信」四类。
//
// 为什么需要它：优化浏览器速度时，最大的误解是把「点击慢」当成瓶颈。真实耗时分布是
// 模型往返（每次 1.5–4 s）远大于页面动作（每次 1–3 s），而人工接管、审批等待又单独占
// 一块，不能算进工具时间。没有这份账本，任何「优化」都只能靠猜。
//
// 设计约束：
// - 纯 Node，不依赖 Electron，可单测；调用方注入 now()，测试可以喂假时钟。
// - 账本只记 span，不做任何策略判断；策略判断集中在 classifyFailure()。
// - span 只保留可序列化的原始值，落盘时不会被循环引用或大对象拖死。

const MAX_SPANS = 400;
const KEEP_SPANS = 40;
const MAX_NAME = 60;

const CATEGORIES = Object.freeze(['model', 'tool', 'human', 'edge']);

/**
 * 这些错误码表示「副作用可能已经发生，但结果没有确认」。
 * 语义上必须与「确定失败」区分开：模型看到 unknown 时只能先去观察页面，
 * 不能直接重发动作，否则就是重复提交。
 */
const INDETERMINATE_CODES = new Set([
  'action-timeout',
  'action-result-unknown',
  'batch-timeout',
  'commit-state-unavailable',
  'commit-no-observable-change',
  'screenshot-timeout',
]);

/** 超时但没有副作用：页面没加载完 / 条件没满足 / 截图没拿到。 */
const TIMEOUT_CODES = new Set([
  'navigation-timeout',
  'wait-timeout',
  'edge-command-timeout',
  'load-timeout',
  'download-timeout',
]);

const DENIED_CODES = new Set([
  'blocked-by-policy',
  'approval-denied',
  'approval-denied-or-expired',
  'requires-handoff',
  'edge-not-paired',
]);

const CANCELLED_CODES = new Set(['cancelled', 'aborted', 'interrupted']);

const ADVICE = Object.freeze({
  unknown: '动作可能已经执行但结果未确认：先读取当前页面状态（browser_snapshot / browser_wait）再决定，不要重复提交。',
  timeout: '这一步是超时，不是失败：先确认页面实际状态，再决定重试还是换条件等待。',
  handoff: '这一步需要用户本人完成（银行卡、扫码支付、密码或验证码）：调用 browser_handoff 交给用户，不要绕开或代填。',
  denied: '这次操作被策略或用户拒绝，本次没有执行；不要换个写法绕过，改为向用户确认。',
  cancelled: '本轮已取消，副作用不保证完成；重新开始前先核对页面状态。',
  failed: '',
});

function sanitize(extra) {
  if (!extra || typeof extra !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 120);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map(item => (typeof item === 'number' || typeof item === 'string' ? item : ''));
    else out[key] = String(value).slice(0, 120);
  }
  return out;
}

/**
 * 把错误翻译成稳定语义，供工具结果、计时账本和重试策略共用。
 * @param {any} error
 * @param {{mayHaveWritten?: boolean}} [options] 该操作是否可能产生写入副作用
 */
function classifyFailure(error, options = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (error?.indeterminate === true) {
    return { outcome: 'unknown', code: code || 'unknown', indeterminate: true, retryable: false, advice: ADVICE.unknown };
  }
  if (INDETERMINATE_CODES.has(code)) {
    // screenshot-timeout 只影响「我看到什么」，不影响「我做了什么」，所以不算未确定副作用。
    if (code === 'screenshot-timeout') {
      return { outcome: 'timeout', code, indeterminate: false, retryable: true, advice: ADVICE.timeout };
    }
    return { outcome: 'unknown', code, indeterminate: true, retryable: false, advice: ADVICE.unknown };
  }
  if (code === 'edge-command-timeout' && options.mayHaveWritten === true) {
    return { outcome: 'unknown', code: 'action-result-unknown', indeterminate: true, retryable: false, advice: ADVICE.unknown };
  }
  if (TIMEOUT_CODES.has(code)) {
    return { outcome: 'timeout', code, indeterminate: false, retryable: true, advice: ADVICE.timeout };
  }
  if (code === 'requires-handoff') {
    // 不是「用户拒绝」，而是「这一步只能由用户做」：建议必须是交给用户，而不是重试。
    return { outcome: 'denied', code, indeterminate: false, retryable: false, advice: ADVICE.handoff };
  }
  if (DENIED_CODES.has(code)) {
    return { outcome: 'denied', code, indeterminate: false, retryable: false, advice: ADVICE.denied };
  }
  if (CANCELLED_CODES.has(code)) {
    return { outcome: 'cancelled', code, indeterminate: false, retryable: true, advice: ADVICE.cancelled };
  }
  return { outcome: 'failed', code: code || 'failed', indeterminate: false, retryable: false, advice: ADVICE.failed };
}

function isIndeterminate(error, options) {
  return classifyFailure(error, options).indeterminate === true;
}

/** 给错误打上「未确定」标记，保持原栈与错误码不变。 */
function markIndeterminate(error, detail) {
  if (!error || typeof error !== 'object') return error;
  error.indeterminate = true;
  if (detail && typeof detail === 'object') error.detail = { ...(error.detail || {}), ...detail };
  return error;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] 可注入时钟（测试用）
 * @param {string} [options.label] 账本标签，例如 app / edge
 * @param {number} [options.maxSpans] 保留的 span 上限
 */
function createTimingLedger(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const label = typeof options.label === 'string' && options.label ? options.label.slice(0, 40) : 'browser';
  const maxSpans = Number.isInteger(options.maxSpans) && options.maxSpans > 0 ? options.maxSpans : MAX_SPANS;
  const startedAt = now();
  const rows = [];
  const counts = { model: 0, tool: 0, human: 0, edge: 0, unknown: 0, timeout: 0 };

  function push(category, name, ms, extra) {
    const key = CATEGORIES.includes(category) ? category : 'tool';
    const row = {
      category: key,
      name: String(name || 'span').slice(0, MAX_NAME),
      ms: Math.max(0, Math.round(Number(ms) || 0)),
      at: Math.max(0, Math.round(now() - startedAt)),
      ...sanitize(extra),
    };
    rows.push(row);
    if (rows.length > maxSpans) rows.splice(0, rows.length - maxSpans);
    counts[key] += 1;
    if (row.outcome === 'unknown') counts.unknown += 1;
    if (row.outcome === 'timeout') counts.timeout += 1;
    return row;
  }

  /** 记一个已经量好的时长。 */
  function span(category, name, ms, extra) {
    return push(category, name, ms, extra);
  }

  /** 记一次耗时操作；返回 end() 便于在同一 span 上追加结果。 */
  function start(category, name, meta) {
    const t0 = now();
    return {
      end(extra) {
        return push(category, name, now() - t0, { ...(meta || {}), ...(extra || {}) });
      },
    };
  }

  /** 包一段异步逻辑，成功/失败都记账，异常原样抛出。 */
  async function track(category, name, run, meta) {
    const t0 = now();
    try {
      const value = await run();
      push(category, name, now() - t0, { ...(meta || {}), ok: true });
      return value;
    } catch (error) {
      const outcome = classifyFailure(error, meta).outcome;
      push(category, name, now() - t0, { ...(meta || {}), ok: false, code: error?.code, outcome });
      throw error;
    }
  }

  /** 失败分支上的记账：工具已经抛错时补一条，避免「失败的调用不计时」。 */
  function fail(category, name, ms, error, meta) {
    const outcome = classifyFailure(error, meta).outcome;
    return push(category, name, ms, { ...(meta || {}), ok: false, code: error?.code, outcome });
  }

  function hasSpans() {
    return rows.length > 0;
  }

  /**
   * 时间账：wallMs 是整轮墙钟；modelMs 由模型事件实测；toolMs 包含人工等待，
   * 所以另外给出 toolActiveMs（工具自身净耗时）；otherMs 是既不是模型也不是工具的空档
   * （渲染、排队、结束收尾）。
   */
  function summary() {
    const totals = { model: 0, tool: 0, human: 0, edge: 0 };
    for (const row of rows) totals[row.category] += row.ms;
    const wallMs = Math.max(0, Math.round(now() - startedAt));
    // 人工等待在现实中一定发生在工具调用内部（审批、接管），所以它是工具时长的子集。
    // 极端情况下如果人工 span 落在工具之外，多出来的部分算进 otherMs，不虚报工具净耗时。
    const humanInsideTool = Math.min(totals.human, totals.tool);
    const humanOutsideTool = totals.human - humanInsideTool;
    const toolActiveMs = Math.max(0, totals.tool - humanInsideTool);
    return {
      version: 1,
      label,
      startedAt,
      wallMs,
      modelCalls: counts.model,
      toolCalls: counts.tool,
      humanWaits: counts.human,
      edgeCalls: counts.edge,
      modelMs: totals.model,
      toolMs: totals.tool,
      humanMs: totals.human,
      edgeMs: totals.edge,
      toolActiveMs,
      humanOutsideToolMs: humanOutsideTool,
      otherMs: Math.max(0, wallMs - totals.model - totals.tool - humanOutsideTool),
      unknown: counts.unknown,
      timeouts: counts.timeout,
      slowest: rows.slice()
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5)
        .map(({ category, name, ms, outcome }) => ({ category, name, ms, ...(outcome ? { outcome } : {}) })),
      spans: rows.slice(-KEEP_SPANS),
    };
  }

  return {
    label,
    startedAt,
    span,
    start,
    track,
    fail,
    hasSpans,
    summary,
    /** 只读快照，测试与调试用。 */
    rows: () => rows.slice(),
  };
}

module.exports = {
  createTimingLedger,
  classifyFailure,
  isIndeterminate,
  markIndeterminate,
  CATEGORIES,
  INDETERMINATE_CODES,
  TIMEOUT_CODES,
};
