/**
 * 负责：`electron/vpn/health.mjs` 的判定与切换规则回归锁（纯内存，假 Controller 客户端）。
 * 不负责：真实网络/真实内核（那属于 `scripts/probes/probe-vpn-egress.mjs`）。
 * 被谁调用：`node --test`。
 *
 * 为什么这些断言值得写：这套逻辑一旦判错，后果是「好好的节点被判死然后切走」——
 * 用户最怕的跨地区切换就是这么来的。下面第 2 条用例来自一次真实误判：
 * 两条健康的 anytls 美国节点对 `www.gstatic.com` 全部失败，但对 `www.google.com` 与
 * `chatgpt.com` 都是 200。用单一目标判定就会把它们错杀。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHATGPT_PROBE_TARGET, GENERIC_PROBE_TARGET, HEALTH_FAILURE_THRESHOLD, HEALTH_INTERVAL_MS,
  HEALTH_LONG_COOLDOWN_MS, HEALTH_LONG_COOLDOWN_THRESHOLD, HEALTH_NODE_COOLDOWN_MS,
  channelOfPool, checkPoolHealth, createHealthState, healPool, isNodeCooling, nodeFailureCount,
  noteNodeFailure, noteNodeSuccess, pickFallbackNode, resolveHealthCheck, runHealthCycle,
} from '../electron/vpn/health.mjs';

/** 假 Controller：`groups` 记录每个组当前生效节点，`delays` 决定探测结果。 */
function fakeClient({ groups = {}, delays = {} } = {}) {
  const calls = [];
  const state = { groups: { ...groups } };
  return {
    calls,
    state,
    async groupNow(name) {
      calls.push(['groupNow', name]);
      const current = state.groups[name];
      return current ? { ok: true, name: current } : { ok: false, code: 'group_not_found' };
    },
    async delay(node, url, timeoutMs) {
      calls.push(['delay', node, url, timeoutMs]);
      const table = delays[node];
      if (typeof table === 'function') return table(url);
      if (table && typeof table[url] === 'number' && table[url] > 0) return { ok: true, delayMs: table[url] };
      return { ok: false, code: 'delay_failed' };
    },
    async select(group, node) {
      calls.push(['select', group, node]);
      state.groups[group] = node;
      return { ok: true };
    },
  };
}

const member = (name, code) => ({ name, region: { code, label: code } });

/** 一个「日本 ×2 + 美国 ×1」的池：同地区备选存在。 */
function poolWithSameRegion() {
  return {
    id: 'p1',
    group: 'mova-pool:p1',
    members: [member('日本-A', 'JP'), member('日本-B', 'JP'), member('美国-X', 'US')],
  };
}

/** 一个「只有一条日本 + 两条美国」的池：当前在日本，同地区**没有**备选。 */
function poolWithoutSameRegion() {
  return {
    id: 'p2',
    group: 'mova-pool:p2',
    members: [member('日本-唯一', 'JP'), member('美国-1', 'US'), member('美国-2', 'US')],
  };
}

test('健康检查规格：默认 5 分钟、双目标，ChatGPT 渠道把 chatgpt 放第一', () => {
  const generic = resolveHealthCheck({ id: 'gemini_auto' });
  assert.equal(generic.intervalMs, HEALTH_INTERVAL_MS);
  assert.equal(HEALTH_INTERVAL_MS, 300_000, '用户要求 5 分钟一次');
  assert.equal(generic.targets[0], GENERIC_PROBE_TARGET, '通用渠道先打 google 204');
  assert.ok(generic.targets.includes(CHATGPT_PROBE_TARGET), '必须把 chatgpt 也作为备选目标');

  const chatgpt = resolveHealthCheck({ id: 'gpt_auto', channel: 'chatgpt' });
  assert.equal(chatgpt.targets[0], CHATGPT_PROBE_TARGET, 'ChatGPT 渠道先打 chatgpt');
  assert.ok(chatgpt.perTargetMs > 0 && chatgpt.perTargetMs <= chatgpt.timeoutMs);

  assert.equal(channelOfPool({ id: 'gpt_auto' }), 'chatgpt');
  assert.equal(channelOfPool({ id: 'gemini_auto' }), 'gemini');
  assert.equal(channelOfPool({ id: 'other' }), 'generic');
});

test('单个目标失败不能判死：目标 A 挂、目标 B 通 → ok:true 且不切换', async () => {
  // 真实场景：两条 anytls 美国节点对 gstatic 全失败、对 google/chatgpt 都 200。
  const pool = { id: 'gpt_auto', group: 'mova-pool:gpt_auto', members: [member('美国-A', 'US'), member('美国-B', 'US')] };
  const client = fakeClient({
    groups: { 'mova-pool:gpt_auto': '美国-A' },
    delays: {
      // 故意让第一个目标（chatgpt 渠道的第一个目标）失败，第二个成功。
      '美国-A': url => (url === CHATGPT_PROBE_TARGET ? { ok: false, code: 'timeout' } : { ok: true, delayMs: 210 }),
    },
  });
  const state = createHealthState();
  const entry = await healPool({ client, pool, state, allowCrossRegion: false });

  assert.equal(entry.ok, true, '第二个目标通过就算健康');
  assert.equal(entry.delayMs, 210);
  assert.equal(entry.switched, null, '健康时绝不能切换');
  assert.equal(state.failures.get('美国-A'), undefined, '健康不该累计失败');
  assert.equal(client.calls.filter(call => call[0] === 'select').length, 0);
});

test('所有目标都失败：前两次只记录，第 3 次才切到同地区节点', async () => {
  const pool = poolWithSameRegion();
  const client = fakeClient({
    groups: { [pool.group]: '日本-A' },
    delays: { '日本-B': { [GENERIC_PROBE_TARGET]: 90 } }, // 日本-B 是健康的同地区备选
  });
  const state = createHealthState();
  let at = 1_000;
  const clock = () => at;

  for (let round = 1; round <= HEALTH_FAILURE_THRESHOLD; round += 1) {
    at += 1_000;
    const entry = await healPool({ client, pool, state, allowCrossRegion: false, now: clock });
    if (round < HEALTH_FAILURE_THRESHOLD) {
      assert.equal(entry.switched, null, `第 ${round} 次失败不该切换（阈值 ${HEALTH_FAILURE_THRESHOLD}）`);
      assert.equal(entry.note, 'probe_failed');
    } else {
      assert.ok(entry.switched, '达到阈值必须切换');
      assert.equal(entry.switched.from, '日本-A');
      assert.equal(entry.switched.to, '日本-B', '必须选同地区的日本-B，不能选美国-X');
      assert.equal(entry.switched.crossRegion, false);
      assert.equal(client.state.groups[pool.group], '日本-B', '切换必须真的下发到 Controller');
    }
  }
});

test('同地区没有备选 + 默认不跨地区 → 不切换，reason 明确', async () => {
  const pool = poolWithoutSameRegion();
  const client = fakeClient({
    groups: { [pool.group]: '日本-唯一' },
    delays: { '美国-1': { [GENERIC_PROBE_TARGET]: 80 }, '美国-2': { [GENERIC_PROBE_TARGET]: 120 } },
  });
  const state = createHealthState();
  let at = 1_000;
  for (let round = 1; round <= HEALTH_FAILURE_THRESHOLD; round += 1) {
    at += 1_000;
    const entry = await healPool({ client, pool, state, allowCrossRegion: false, now: () => at });
    if (round === HEALTH_FAILURE_THRESHOLD) {
      assert.equal(entry.switched, null, '默认绝不跨地区');
      assert.equal(entry.reason, 'no_same_region_alternative');
      assert.equal(client.calls.filter(call => call[0] === 'select').length, 0, '一个 select 都不许发');
      assert.equal(client.state.groups[pool.group], '日本-唯一', '当前节点保持不变');
    }
  }
});

test('显式开启 allowCrossRegion 才跨地区，并带 crossRegion 标记', async () => {
  const pool = poolWithoutSameRegion();
  const client = fakeClient({
    groups: { [pool.group]: '日本-唯一' },
    delays: { '美国-2': { [GENERIC_PROBE_TARGET]: 70 }, '美国-1': { [GENERIC_PROBE_TARGET]: 300 } },
  });
  const state = createHealthState();
  // 预置历史延迟：择优必须按「最近测得的延迟」选，而不是按声明顺序取第一个。
  state.lastDelayMs.set('美国-1', 300);
  state.lastDelayMs.set('美国-2', 70);
  const events = [];
  let at = 1_000;
  let last = null;
  for (let round = 1; round <= HEALTH_FAILURE_THRESHOLD; round += 1) {
    at += 1_000;
    last = await healPool({
      client, pool, state, allowCrossRegion: true, now: () => at,
      onEvent: event => events.push(event),
    });
  }
  assert.ok(last.switched, '开了开关就要切');
  assert.equal(last.switched.crossRegion, true);
  assert.equal(last.switched.to, '美国-2', '两条美国节点里选历史延迟更低的');
  const switchEvent = events.find(event => event.kind === 'switch');
  assert.ok(switchEvent, '跨地区切换必须留一条 switch 事件（可审计）');
  assert.equal(switchEvent.crossRegion, true);
  assert.equal(switchEvent.fromRegion.code, 'JP');
  assert.equal(switchEvent.toRegion.code, 'US');
});

test('连续失败进坏节点冷却：3 次 5 分钟、5 次 30 分钟，成功后清零', () => {
  const state = createHealthState();
  let at = 10_000;
  const step = () => { at += 1_000; return at; };

  for (let i = 1; i < HEALTH_FAILURE_THRESHOLD; i += 1) {
    const result = noteNodeFailure(state, 'N', { now: step });
    assert.equal(result.cooling, false, `第 ${i} 次还不冷却`);
  }
  const third = noteNodeFailure(state, 'N', { now: step });
  assert.equal(third.cooling, true);
  assert.equal(third.failures, HEALTH_FAILURE_THRESHOLD);
  assert.equal(isNodeCooling(state, 'N', { now: () => at }), true);
  assert.equal(third.until - at, HEALTH_NODE_COOLDOWN_MS, '3 次 → 5 分钟冷却');

  // 冷却到期自动解除，并给一次机会（失败计数一并清零）。
  assert.equal(isNodeCooling(state, 'N', { now: () => third.until + 1 }), false);
  assert.equal(nodeFailureCount(state, 'N'), 0);

  // 一路失败到 5 次 → 进长冷却 30 分钟（IPv6-only 节点就靠这个彻底冷下来）。
  let fifth = null;
  for (let i = 1; i <= HEALTH_LONG_COOLDOWN_THRESHOLD; i += 1) {
    fifth = noteNodeFailure(state, 'M', { now: step });
  }
  assert.equal(fifth.failures, HEALTH_LONG_COOLDOWN_THRESHOLD);
  assert.equal(fifth.until - at, HEALTH_LONG_COOLDOWN_MS, '5 次 → 30 分钟长冷却');
  assert.equal(HEALTH_LONG_COOLDOWN_MS, 30 * 60_000);

  noteNodeSuccess(state, 'M', { delayMs: 88, now: step });
  assert.equal(nodeFailureCount(state, 'M'), 0);
  assert.equal(isNodeCooling(state, 'M', { now: () => at }), false);
  assert.equal(state.lastDelayMs.get('M'), 88);
});

test('pickFallbackNode 不选冷却中的节点，也不选当前节点自己', () => {
  const members = [member('日本-A', 'JP'), member('日本-B', 'JP'), member('日本-C', 'JP')];
  const pick = pickFallbackNode({
    members,
    activeNode: '日本-A',
    isBadNode: name => name === '日本-B',
  });
  assert.equal(pick.node.name, '日本-C', '跳过当前节点与冷却中的节点');
  assert.equal(pick.reason, 'same_region');

  // 同地区全坏 + 不允许跨地区 → 不选
  const stuck = pickFallbackNode({
    members,
    activeNode: '日本-A',
    isBadNode: name => name !== '日本-A',
    allowCrossRegion: false,
  });
  assert.equal(stuck.node, null);
  assert.equal(stuck.reason, 'no_same_region_alternative');
});

test('checkPoolHealth：控制器不可达 / 组不存在 / 没活跃节点 都给稳定 code', async () => {
  const noClient = await checkPoolHealth({ client: null, pool: { id: 'x' } });
  assert.equal(noClient.ok, false);
  assert.equal(noClient.reason, 'controller_unavailable');

  const missingGroup = await checkPoolHealth({
    client: fakeClient(), pool: { id: 'x', group: 'mova-pool:x' },
  });
  assert.equal(missingGroup.ok, false);
  assert.equal(missingGroup.reason, 'group_not_found');
});

test('runHealthCycle：单池抛错不影响其它池，结果逐池返回', async () => {
  const goodPool = { id: 'good', group: 'mova-pool:good', members: [member('台湾-A', 'TW')] };
  const badPool = { id: 'bad', group: 'mova-pool:bad', members: [member('美国-B', 'US')] };
  const client = fakeClient({
    groups: { 'mova-pool:good': '台湾-A', 'mova-pool:bad': '美国-B' },
    delays: { '台湾-A': { [GENERIC_PROBE_TARGET]: 40 } },
  });
  const original = client.groupNow.bind(client);
  client.groupNow = async name => {
    if (name === 'mova-pool:bad') throw new Error('boom');
    return original(name);
  };
  const state = createHealthState();
  const result = await runHealthCycle({ client, pools: [goodPool, badPool], state, now: () => 5_000 });

  assert.equal(result.checkedAt, 5_000);
  assert.equal(result.results.length, 2);
  const good = result.results.find(item => item.poolId === 'good');
  const bad = result.results.find(item => item.poolId === 'bad');
  assert.equal(good.ok, true);
  assert.equal(good.delayMs, 40);
  assert.equal(bad.ok, false);
  assert.equal(bad.note, 'internal', '抛错被收敛成 internal，不中断整轮');
});
