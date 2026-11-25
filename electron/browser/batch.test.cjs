const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runBatch } = require('./batch.cjs');

function fakeTarget() {
  const calls = [];
  return {
    calls,
    async navigate(url) { calls.push(['navigate', url]); return { url }; },
    async wait(condition) { calls.push(['wait', condition]); return { ok: true }; },
    async act(action) { calls.push(['act', action]); return { ok: true, action: action.action }; },
    async snapshot(options) { calls.push(['snapshot', options]); return { mode: 'diff', text: '# diff' }; },
  };
}

test('runs steps in order and returns one diff at the end', async () => {
  const target = fakeTarget();
  const authorized = [];
  const result = await runBatch(target, [
    { op: 'fill', target: 'css=#q', value: 'x' },
    { op: 'click', target: 'css=#go' },
  ], { authorize: step => authorized.push(step.action) });
  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps.map(step => step.ok), [true, true]);
  assert.equal(result.snapshot.mode, 'diff');
  assert.deepEqual(authorized, ['fill', 'click']);
  assert.equal(target.calls.filter(call => call[0] === 'act').length, 2);
  assert.equal(target.calls.filter(call => call[0] === 'snapshot').length, 1);
});

test('stops at the first failure and keeps the successful prefix', async () => {
  const target = fakeTarget();
  target.act = async action => {
    if (action.target === 'css=#bad') { const error = new Error('nope'); error.code = 'not-visible'; throw error; }
    return { ok: true };
  };
  const result = await runBatch(target, [
    { op: 'click', target: 'css=#ok' },
    { op: 'click', target: 'css=#bad' },
    { op: 'click', target: 'css=#never' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 1);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].code, 'not-visible');
});

test('continueOnError keeps going after a failed step', async () => {
  const target = fakeTarget();
  let attempts = 0;
  target.act = async () => {
    attempts += 1;
    if (attempts === 1) { const error = new Error('nope'); error.code = 'not-visible'; throw error; }
    return { ok: true };
  };
  const result = await runBatch(target, [
    { op: 'click', target: 'css=#bad' },
    { op: 'click', target: 'css=#ok' },
  ], { continueOnError: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map(step => step.ok), [false, true]);
});

test('a denied authorization stops before the step executes', async () => {
  const target = fakeTarget();
  await assert.rejects(
    runBatch(target, [{ op: 'click', target: 'css=#pay' }], {
      authorize: () => { const error = new Error('denied'); error.code = 'blocked-by-policy'; throw error; },
    }),
    error => {
      assert.equal(error.code, 'blocked-by-policy');
      assert.equal(error.detail.step, 0);
      assert.equal(error.detail.op, 'click');
      assert.equal(error.detail.completedCount, 0);
      return true;
    },
  );
  assert.equal(target.calls.length, 0);
});

test('a handoff in the middle keeps the steps that already ran', async () => {
  const target = fakeTarget();
  await assert.rejects(
    runBatch(target, [
      { op: 'click', target: '#ok' },
      { op: 'fill', target: 'css=#card-number', value: '4242' },
    ], {
      authorize: step => {
        if (step.target !== 'css=#card-number') return;
        const error = Object.assign(new Error('需要本人填写银行卡信息'), { code: 'requires-handoff' });
        throw error;
      },
    }),
    error => {
      assert.equal(error.code, 'requires-handoff');
      assert.equal(error.detail.step, 1);
      assert.deepEqual(error.detail.completed, [{ i: 0, op: 'click', ok: true }]);
      return true;
    },
  );
  assert.equal(target.calls.filter(call => call[0] === 'act').length, 1, '被拦下的那一步不能执行');
});

test('rejects empty and oversized batches', async () => {
  const target = fakeTarget();
  await assert.rejects(runBatch(target, []), /non-empty/);
  await assert.rejects(runBatch(target, Array.from({ length: 31 }, () => ({ op: 'wait', for: 'load' }))), /at most 30/);
});

test('a batch timeout keeps the steps that really ran and says the outcome is unknown', async () => {
  const target = fakeTarget();
  target.act = async action => {
    await new Promise(resolve => setTimeout(resolve, 600));
    return { ok: true, action: action.action };
  };
  const result = await runBatch(target, [
    { op: 'click', target: '#a' },
    { op: 'click', target: '#b' },
    { op: 'click', target: '#c' },
  ], { timeout: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'batch-timeout');
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.indeterminate, true);
  assert.equal(result.partial, true);
  assert.equal(result.timedOutAt, 2);
  assert.equal(result.finished, 2);
  assert.equal(result.expected, 3);
  assert.deepEqual(result.steps.map(step => step.ok), [true, true], '已完成的步骤必须原样返回，不能丢掉');
  assert.ok(result.snapshot, '超时也要给一张当前页面快照，模型才知道走到哪了');
  assert.match(result.suggestion, /不要从头重放/);
});

test('a failed step carries an outcome so unknown side effects are visible', async () => {
  const target = fakeTarget();
  target.act = async () => {
    const error = new Error('动作超时');
    error.code = 'action-timeout';
    throw error;
  };
  const result = await runBatch(target, [{ op: 'click', target: '#pay' }]);
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].outcome, 'unknown');
  assert.equal(result.steps[0].indeterminate, true);
  assert.equal(result.steps[0].code, 'action-timeout');
});

test('fixed waits become conditional waits inside a batch', async () => {
  const target = fakeTarget();
  const result = await runBatch(target, [{ op: 'wait', ms: 1200 }]);
  assert.equal(result.ok, true);
  assert.equal(target.calls[0][0], 'wait');
  assert.equal(target.calls[0][1].for, 'settle', '固定等待先尝试条件等待');
  assert.equal(result.steps[0].convertedFrom, 'time');

  // 页面一直在动（settle 超时）时退回真实延时，保持原来的语义。
  const busy = fakeTarget();
  const calls = [];
  busy.wait = async condition => {
    calls.push(condition);
    if (condition.for === 'settle') { const error = new Error('wait timeout'); error.code = 'timeout'; throw error; }
    return { ok: true };
  };
  const fallback = await runBatch(busy, [{ op: 'wait', ms: 900 }]);
  assert.equal(fallback.ok, true);
  assert.deepEqual(calls.map(condition => condition.for), ['settle', 'time']);
  assert.equal(fallback.steps[0].condition, 'time');
});

test('a navigate step can return the observation in the same call', async () => {
  const target = fakeTarget();
  const result = await runBatch(target, [{ op: 'navigate', url: 'https://example.com/a', observe: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].url, 'https://example.com/a');
  assert.equal(result.steps[0].snapshot.text, '# diff');
  assert.equal(result.observed, true);
  // 观察直接复用这一步的快照，末尾不再重复采集。
  assert.equal(target.calls.filter(call => call[0] === 'snapshot').length, 2);
});

test('a wait step infers its condition from the fields the model sent', async () => {
  const target = fakeTarget();
  const result = await runBatch(target, [{ op: 'wait', selector: '#done' }]);
  assert.equal(result.ok, true);
  assert.equal(target.calls[0][1].for, 'selector');
  assert.equal(result.steps[0].condition, 'selector');
});
