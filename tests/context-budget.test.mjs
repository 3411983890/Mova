import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextHistory } from '../src/features/chat/context-budget.mjs';

test('long history preserves newest user verbatim without mutating stored originals', () => {
  const history = Array.from({ length: 1200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + '中'.repeat(300), reasoning: 'private chain', images: [] }));
  history.push({ role: 'user', text: '请继续当前任务', images: ['image-id'] });
  const original = structuredClone(history);
  const result = buildContextHistory(history);
  assert.ok(result.messages.length <= 100);
  assert.ok(result.estimatedChars <= 60000);
  assert.ok(result.omittedMessages > 1000);
  assert.equal(result.messages.at(-1).text, '请继续当前任务');
  assert.deepEqual(result.messages.at(-1).images, ['image-id']);
  assert.ok(result.summary.length <= 4000);
  assert.ok(result.messages.every(m => m.reasoning === undefined));
  assert.deepEqual(history, original);
});
test('single oversize input is explicitly rejected rather than silently clipped', () => {
  assert.throws(() => buildContextHistory([{ role: 'user', text: 'x'.repeat(60001) }]), /input_too_long/);
  assert.throws(() => buildContextHistory([{ role: 'system', text: 'bad' }]), /history/);
  assert.throws(() => buildContextHistory([{ role: 'assistant', text: 'bad' }]), /history/);
});
test('short portable contexts keep visible conversation across models but no native reasoning', () => {
  const result = buildContextHistory([{ role: 'user', text: '你好' }, { role: 'assistant', text: '您好', reasoning: 'private', model: 'old' }, { role: 'user', text: '继续' }]);
  assert.equal(result.omittedMessages, 0);
  assert.equal(result.summary, '');
  assert.deepEqual(result.messages.map(m => m.text), ['你好', '您好', '继续']);
});
