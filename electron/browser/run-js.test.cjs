const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runJavaScript } = require('./run-js.cjs');

function fakeTarget() {
  const calls = [];
  return {
    calls,
    async navigate(url) { calls.push(['navigate', url]); return { url }; },
    async act(action) { calls.push(['act', action.action, action.target]); return { ok: true, action: action.action }; },
    async wait(condition) { calls.push(['wait', condition.for]); return { ok: true }; },
    async snapshot() { calls.push(['snapshot']); return { mode: 'diff', text: '# diff' }; },
    async evaluate(expression) { calls.push(['evaluate']); return expression.includes('innerText') ? 'text' : 'evaluated'; },
  };
}

test('runs a script against the page facade and returns JSON', async () => {
  const target = fakeTarget();
  const result = await runJavaScript(target, `
    await page.goto('https://example.test');
    await page.fill('#q', 'mova');
    await page.click('#go');
    return { title: await page.snapshot().then(s => s.mode), text: await page.text('#x') };
  `);
  assert.deepEqual(result, { ok: true, result: { title: 'diff', text: 'text' } });
  assert.deepEqual(target.calls.map(call => call[0]), ['navigate', 'act', 'act', 'snapshot', 'evaluate']);
});

test('does not expose require, process or fetch', async () => {
  const result = await runJavaScript(fakeTarget(), `return [typeof require, typeof process, typeof fetch];`);
  assert.deepEqual(result.result, ['undefined', 'undefined', 'undefined']);
});

test('times out a long-running script and rejects oversized results', async () => {
  await assert.rejects(runJavaScript(fakeTarget(), `await new Promise(resolve => setTimeout(resolve, 500));`, { timeout: 80 }), /timed out/);
  await assert.rejects(runJavaScript(fakeTarget(), `return 'x'.repeat(40000);`), /32 KB/);
});
