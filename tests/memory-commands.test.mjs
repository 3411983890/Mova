import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseMemoryCommand, findCommandTargets } = require('../electron/services/memory-commands.cjs');

test('parses Chinese forget and correction commands', () => {
  assert.deepEqual(parseMemoryCommand('忘记 1887'), { action: 'forget', query: '1887', original: '忘记 1887' });
  assert.equal(parseMemoryCommand('以后不要再记关于 1887 的内容。').action, 'forget');
  assert.equal(parseMemoryCommand('以后不要再记关于 1887 的内容。').blocked, true);
  const correct = parseMemoryCommand('把 1887 改成 1888');
  assert.equal(correct.action, 'correct');
  assert.equal(correct.query, '1887');
  assert.equal(correct.replacement, '1888');
  assert.equal(parseMemoryCommand('更正 1887 为 1888').replacement, '1888');
});

test('parses English commands and strips punctuation', () => {
  assert.equal(parseMemoryCommand('forget about 1887').query, '1887');
  assert.equal(parseMemoryCommand('change 1887 to 1888').replacement, '1888');
  assert.equal(parseMemoryCommand('correct 1887 to 1888').query, '1887');
});

test('rejects questions, empty targets and oversized input', () => {
  assert.equal(parseMemoryCommand('你记得 1887 吗？'), null);
  assert.equal(parseMemoryCommand('do you remember 1887?'), null);
  assert.equal(parseMemoryCommand('忘记'), null);
  assert.equal(parseMemoryCommand('忘记   '), null);
  assert.equal(parseMemoryCommand('忘记 ' + 'x'.repeat(2500)), null);
  assert.equal(parseMemoryCommand(null), null);
});

test('finds unique and multiple command targets', () => {
  const memories = [
    { id: 'a', text: '我的幸运数字是 1887', status: 'active' },
    { id: 'b', text: '1887 是测试编号', status: 'active' },
    { id: 'c', text: '喜欢简洁界面', status: 'active' },
  ];
  const parsed = parseMemoryCommand('忘记 1887');
  const hits = findCommandTargets(memories, parsed);
  assert.equal(hits.length, 2);
  assert.ok(hits.every(hit => hit.text.includes('1887')));
  assert.deepEqual(findCommandTargets(memories, parseMemoryCommand('忘记 9999')), []);
});

test('exact normalized target ranks first', () => {
  const memories = [
    { id: 'a', text: '数字是 1887', status: 'active' },
    { id: 'b', text: '1887', status: 'active' },
  ];
  const hits = findCommandTargets(memories, parseMemoryCommand('忘记 1887'));
  assert.equal(hits[0].id, 'b');
});
