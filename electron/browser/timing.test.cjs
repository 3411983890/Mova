const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createTimingLedger, classifyFailure, markIndeterminate, INDETERMINATE_CODES,
} = require('./timing.cjs');

function clock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: ms => { value += ms; return value; } };
}

test('separates model, tool and human wait time', async () => {
  const time = clock();
  const ledger = createTimingLedger({ now: time.now, label: 'app' });
  ledger.span('model', 'turn', 2000);
  time.advance(2000);
  // 真实形态：审批等待发生在工具调用内部，所以 human 是 tool 的子集。
  await ledger.track('tool', 'browser_act', async () => {
    time.advance(300);
    await ledger.track('human', 'approval', async () => { time.advance(5000); return 'once'; });
    return { ok: true };
  });
  await ledger.track('tool', 'browser_snapshot', async () => { time.advance(100); return {}; });
  time.advance(400);
  const summary = ledger.summary();
  assert.equal(summary.modelMs, 2000);
  assert.equal(summary.toolMs, 5400, '工具总时长包含落在工具内的人工等待');
  assert.equal(summary.humanMs, 5000);
  assert.equal(summary.toolActiveMs, 400, '人工等待不计入工具净耗时');
  assert.equal(summary.modelCalls, 1);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.humanWaits, 1);
  assert.equal(summary.wallMs, 7800);
  assert.equal(summary.otherMs, 400, '既不是模型也不是工具的空档单独统计');
});

test('failed tool calls are still timed and marked with an outcome', async () => {
  const ledger = createTimingLedger({ now: () => 0 });
  await assert.rejects(ledger.track('tool', 'browser_act', async () => {
    const error = new Error('动作超时');
    error.code = 'action-timeout';
    throw error;
  }), /动作超时/);
  const summary = ledger.summary();
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.spans[0].outcome, 'unknown');
  assert.equal(summary.spans[0].code, 'action-timeout');
});

test('timeout semantics keep determinate failures apart from unknown side effects', () => {
  assert.deepEqual(
    [classifyFailure({ code: 'action-timeout' }).outcome, classifyFailure({ code: 'action-timeout' }).indeterminate],
    ['unknown', true],
  );
  assert.deepEqual(
    [classifyFailure({ code: 'navigation-timeout' }).outcome, classifyFailure({ code: 'navigation-timeout' }).indeterminate],
    ['timeout', false],
  );
  assert.equal(classifyFailure({ code: 'wait-timeout' }).outcome, 'timeout');
  assert.equal(classifyFailure({ code: 'screenshot-timeout' }).outcome, 'timeout', '截图失败不影响动作结果');
  assert.equal(classifyFailure({ code: 'edge-command-timeout' }).outcome, 'timeout', '只读命令超时仍是确定失败');
  assert.equal(classifyFailure({ code: 'edge-command-timeout' }, { mayHaveWritten: true }).outcome, 'unknown');
  assert.equal(classifyFailure({ code: 'blocked-by-policy' }).outcome, 'denied');
  assert.match(classifyFailure({ code: 'requires-handoff' }).advice, /browser_handoff/, '必须交给用户，而不是重试');
  assert.equal(classifyFailure({ code: 'cancelled' }).outcome, 'cancelled');
  assert.equal(classifyFailure({ code: 'stale-element' }).outcome, 'failed');
  assert.equal(classifyFailure({}).code, 'failed');
  assert.ok(INDETERMINATE_CODES.has('batch-timeout'));
  // 未知结果必须给模型一条明确建议，否则它只会盲目重试。
  assert.match(classifyFailure({ code: 'batch-timeout' }).advice, /不要重复提交/);
  assert.equal(classifyFailure({ code: 'stale-element' }).advice, '');
});

test('markIndeterminate makes a plain error explicit without losing its code', () => {
  const error = Object.assign(new Error('x'), { code: 'custom-timeout' });
  markIndeterminate(error, { mayHaveWritten: true });
  assert.equal(error.code, 'custom-timeout');
  assert.deepEqual(error.detail, { mayHaveWritten: true });
  assert.equal(classifyFailure(error).outcome, 'unknown');
  assert.equal(classifyFailure(error).indeterminate, true);
});

test('summary stays bounded and serialisable', () => {
  const ledger = createTimingLedger({ now: () => 0, maxSpans: 5 });
  for (let index = 0; index < 12; index += 1) ledger.span('tool', `tool_${index}`, index, { ok: true });
  const summary = ledger.summary();
  assert.equal(ledger.rows().length, 5);
  assert.equal(summary.spans.length, 5);
  assert.equal(summary.spans.at(-1).name, 'tool_11');
  assert.doesNotThrow(() => JSON.stringify(summary));
  // 未知分类回落到 tool，避免脏数据把账本撑坏。
  ledger.span('nonsense', 'x', 1);
  assert.equal(ledger.rows().at(-1).category, 'tool');
  // 超长名字与对象型 meta 都被截断成原始值。
  ledger.span('tool', 'n'.repeat(200), 3, { detail: { deep: true }, list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  const row = ledger.rows().at(-1);
  assert.equal(row.name.length, 60);
  assert.equal(typeof row.detail, 'string');
  assert.equal(row.list.length, 8);
});
