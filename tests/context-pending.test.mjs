/**
 * 待生效压缩队列（pending）的单元测试：纯内存，不需要 IO / Electron。
 *
 * 关注四件事：一次性消费、过期语义、容量上限丢最旧、payload 形状归一。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingCompactions } from '../electron/context/pending.mjs';

/** 可控时钟：TTL 测试不能靠真实等待。 */
function createClock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
  };
}

function payload(overrides = {}) {
  return {
    summaryBlock: '[上下文摘要 ctx_1 span=m2..m5 covered=4 source=llm]\n摘要正文',
    coveredIds: ['m2', 'm3', 'm4', 'm5'],
    coveredCount: 4,
    source: 'llm',
    createdAt: 1_000_000,
    archive: [{ id: 'm2', text: '原文二' }],
    ...overrides,
  };
}

test('take 是一次性的：第二次取到 null，且 size 归零', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ now: clock.now });
  assert.equal(pending.set('conv-1', payload()), true, 'set 必须成功');
  const first = pending.take('conv-1');
  assert.ok(first, '第一次 take 必须拿到 payload');
  assert.equal(first.coveredCount, 4);
  assert.equal(pending.take('conv-1'), null, '第二次 take 必须为 null（一次性）');
  assert.equal(pending.size(), 0, '取走之后队列必须为空');
});

test('peek 不删除：连续 peek 都能读到，size 不变', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ now: clock.now });
  pending.set('conv-1', payload());
  assert.ok(pending.peek('conv-1'));
  assert.ok(pending.peek('conv-1'));
  assert.equal(pending.size(), 1, 'peek 不能消耗条目');
  assert.ok(pending.take('conv-1'), 'peek 之后仍然可以 take');
});

test('过期后 take / peek 都为 null，并顺手清掉', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ ttlMs: 1000, now: clock.now });
  pending.set('a', payload({ createdAt: clock.now() }));
  clock.advance(1001);
  assert.equal(pending.peek('a'), null, '过期后 peek 必须为 null');
  pending.set('b', payload({ createdAt: clock.now() }));
  clock.advance(1001);
  assert.equal(pending.take('b'), null, '过期后 take 必须为 null');
  assert.equal(pending.size(), 0, '过期项必须被清掉');
});

test('正好等于 ttl 时仍然可用（严格大于才算过期）', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ ttlMs: 1000, now: clock.now });
  pending.set('a', payload({ createdAt: clock.now() }));
  clock.advance(1000);
  assert.ok(pending.peek('a'), 'ttl 边界上不能提前过期');
});

test('超过 maxEntries 丢最旧的一条', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ maxEntries: 2, now: clock.now });
  pending.set('a', payload({ coveredCount: 1 }));
  pending.set('b', payload({ coveredCount: 2 }));
  pending.set('c', payload({ coveredCount: 3 }));
  assert.equal(pending.size(), 2, '超出上限必须裁到 maxEntries');
  assert.equal(pending.peek('a'), null, '最旧的一条必须被丢掉');
  assert.ok(pending.peek('b'), 'b 还在');
  assert.ok(pending.peek('c'), 'c 还在');
});

test('重复 set 同一个 key 会刷新位次（不会把自己当最旧的丢掉）', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ maxEntries: 2, now: clock.now });
  pending.set('a', payload());
  pending.set('b', payload());
  pending.set('a', payload({ coveredCount: 9 }));
  pending.set('c', payload());
  assert.equal(pending.peek('a')?.coveredCount, 9, '重新写入的 a 必须是新值');
  assert.equal(pending.peek('b'), null, 'b 才是此时最旧的一条');
});

test('clear 幂等、size 反映真实条数', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ now: clock.now });
  pending.set('a', payload());
  pending.set('b', payload());
  assert.equal(pending.size(), 2);
  assert.equal(pending.clear('a'), true);
  assert.equal(pending.clear('a'), false, 'clear 必须幂等（第二次返回 false，不抛）');
  assert.equal(pending.clear('missing'), false, '不存在的 key 也不抛');
  assert.equal(pending.size(), 1, 'size 只数真实存在的条目');
});

test('size 不把已过期的条目算进去', () => {
  const clock = createClock();
  const pending = createPendingCompactions({ ttlMs: 500, now: clock.now });
  pending.set('a', payload({ createdAt: clock.now() }));
  assert.equal(pending.size(), 1);
  clock.advance(600);
  assert.equal(pending.size(), 0, '过期项不算在条数里');
});

test('payload 归一成固定字段集合，坏字段不抛也不外泄', () => {
  const clock = createClock(2_000_000);
  const pending = createPendingCompactions({ now: clock.now });
  const stored = pending.take('k');
  assert.equal(stored, null, '空队列 take 必须为 null');

  pending.set('k', {
    summaryBlock: 42,
    coveredIds: ['m1', '', 3],
    archive: [{ id: 'm1', text: 5 }, { text: '缺 id 的条目' }],
    source: 'something-else',
    // createdAt 故意不给：应当补成当前时钟
  });
  const value = pending.peek('k');
  assert.deepEqual(Object.keys(value).sort(), ['archive', 'coveredCount', 'coveredIds', 'createdAt', 'source', 'summaryBlock'], '字段集合必须与 wiring 逐字一致');
  assert.equal(value.summaryBlock, '', '非字符串摘要必须降级为空串');
  assert.deepEqual(value.coveredIds, ['m1'], '非法 id 必须被过滤');
  assert.equal(value.coveredCount, 1, '缺 coveredCount 时按 coveredIds 推出');
  assert.equal(value.source, 'deterministic', '未知来源一律按程序摘要（低估可信度更安全）');
  assert.equal(value.createdAt, 2_000_000, '缺 createdAt 时用当前时钟补上');
  assert.deepEqual(value.archive, [{ id: 'm1', text: '' }], '归档条目只留 {id, text}');
});

test('非法 key 被拒绝：空串 / undefined / 对象都不会写入', () => {
  const pending = createPendingCompactions();
  assert.equal(pending.set('', payload()), false);
  assert.equal(pending.set(undefined, payload()), false);
  assert.equal(pending.set(null, payload()), false);
  assert.equal(pending.set({ id: 'x' }, payload()), false);
  assert.equal(pending.size(), 0, '一次都不该写进去');
  assert.equal(pending.take(''), null);
  assert.equal(pending.peek(undefined), null);
  assert.equal(pending.clear(null), false);
});
