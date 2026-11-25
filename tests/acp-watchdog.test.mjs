/**
 * `session/prompt` 空闲看门狗的契约。
 *
 * 为什么必须锁住：固定 120s 一刀切是「用户等人工审批超过 2 分钟就被 acp_protocol 打断、
 * 前端显示『模型连接中断，正在第 N/5 次自动重试…』」的唯一原因。看门狗的正确性只有靠
 * 「谁能续期、续期几次、什么情况仍然会超时」这三件事来定义。
 *
 * 全部离线：假时钟（注入 now / setTimer / clearTimer）+ PassThrough 假 stdio，
 * 不真起进程、不真等时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  DEFAULT_PROMPT_CEILING_MS,
  DEFAULT_PROMPT_IDLE_MS,
  createAcpClient,
} from '../electron/acp/client.mjs';

/** 让流事件（PassThrough 的 data）先跑完，再看计时器效果。 */
function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

/** 可手动推进的假时钟：advance() 只触发真的到期的计时器，不依赖真实时间。 */
function createClock(start = 1_000_000) {
  let time = start;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = seq;
      seq += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      time += ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= time)
          .sort((left, right) => left[1].at - right[1].at);
        if (!due.length) return;
        for (const [id, timer] of due) {
          // 回调里可能已经把别的计时器清掉/重排：只触发还挂在表上的那个。
          if (timers.get(id) !== timer) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/** 最小假进程：只提供 client 需要的 stdio 与事件接口，kill() 真的结束流。 */
function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = {
    pid: 7777,
    stdin,
    stdout,
    stderr,
    kill() {
      stdout.end();
      stderr.end();
      emitter.emit('exit', 0, null);
    },
    on(...args) {
      emitter.on(...args);
      return child;
    },
    once(...args) {
      emitter.once(...args);
      return child;
    },
    removeListener(...args) {
      emitter.removeListener(...args);
      return child;
    },
  };
  return child;
}

function makeClient(clock, options = {}) {
  const child = fakeChild();
  const client = createAcpClient({
    spawn: () => child,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    env: {},
    ...options,
  });
  client.start({ command: 'agy', args: ['acp'], cwd: 'C:/proj' });
  return { child, client };
}

function notify(child, method, params) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function answer(child, id, result = {}) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

test('默认值：空闲 10 分钟、硬上限 30 分钟（不能短于 browser_handoff 的 10 分钟审批上限）', () => {
  assert.equal(DEFAULT_PROMPT_IDLE_MS, 600_000, '空闲阈值必须 >= 人工审批上限 10 分钟');
  assert.equal(DEFAULT_PROMPT_CEILING_MS, 30 * 60_000);
});

test('收到该会话的 session/update 会重置空闲计时器，请求仍能正常完成', async () => {
  const clock = createClock();
  const { child, client } = makeClient(clock, { promptIdleMs: 100 });
  try {
    const pending = client.request('session/prompt', { sessionId: 's1', prompt: [] });
    // 80ms 静默：还没到 100ms 阈值。
    await clock.advance(80);
    notify(child, 'session/update', {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '还在跑' } },
    });
    await flush();
    // 累计 160ms 已超过 100ms，但距上次活动只有 80ms —— 续期生效，不该超时。
    await clock.advance(80);
    answer(child, 1, { stopReason: 'end_turn' });
    assert.deepEqual(await pending, { stopReason: 'end_turn' }, '有 session/update 续期时请求必须还能完成');
  } finally {
    client.close();
  }
});

test('完全没有活动：按空闲阈值超时，code=acp_idle_timeout 且带「距上次活动 N ms」', async () => {
  const clock = createClock();
  const { client } = makeClient(clock, { promptIdleMs: 100 });
  try {
    const pending = client.request('session/prompt', { sessionId: 's1', prompt: [] });
    // 先挂上断言再推进时钟：拒绝发生在 advance 内部，晚了就成了未处理的 rejection。
    const expectation = assert.rejects(pending, error => {
      assert.equal(error.name, 'AcpTimeoutError');
      assert.equal(error.code, 'acp_idle_timeout');
      assert.equal(error.timeout.idleMs, 100);
      assert.match(error.detail, /session\/prompt: 空闲超时/);
      assert.match(error.detail, /距上次活动 \d+ms/);
      return true;
    });
    await clock.advance(150);
    await expectation;
  } finally {
    client.close();
  }
});

test('别的会话的 session/update 不给本会话续命', async () => {
  const clock = createClock();
  const { child, client } = makeClient(clock, { promptIdleMs: 100 });
  try {
    const pending = client.request('session/prompt', { sessionId: 's1', prompt: [] });
    const expectation = assert.rejects(pending, error => error.code === 'acp_idle_timeout');
    await clock.advance(80);
    notify(child, 'session/update', { sessionId: 'other', update: {} });
    await flush();
    await clock.advance(30);
    await expectation;
  } finally {
    client.close();
  }
});

test('MOVA_ACP_FLAT_TIMEOUT=1：回退到旧的固定超时行为，session/update 不再续期', async () => {
  const clock = createClock();
  const { child, client } = makeClient(clock, {
    timeoutMs: 100,
    promptIdleMs: 10_000,
    env: { MOVA_ACP_FLAT_TIMEOUT: '1' },
  });
  try {
    const pending = client.request('session/prompt', { sessionId: 's1', prompt: [] });
    const expectation = assert.rejects(pending, error => {
      assert.equal(error.code, 'acp_protocol', '回退开关下沿用旧的 acp_protocol');
      assert.match(error.detail, /等待响应超时（100ms/);
      return true;
    });
    await clock.advance(50);
    notify(child, 'session/update', { sessionId: 's1', update: {} });
    await flush();
    await clock.advance(60);
    await expectation;
  } finally {
    client.close();
  }
});

test('一直有活动也会撞硬上限：code=acp_ceiling_timeout', async () => {
  const clock = createClock();
  const { child, client } = makeClient(clock, { promptIdleMs: 100, promptCeilingMs: 200 });
  try {
    const pending = client.request('session/prompt', { sessionId: 's1', prompt: [] });
    const expectation = assert.rejects(pending, error => {
      assert.equal(error.code, 'acp_ceiling_timeout');
      assert.equal(error.timeout.ceilingMs, 200);
      assert.match(error.detail, /硬上限（200ms/);
      assert.match(error.detail, /距上次活动 \d+ms/);
      return true;
    });
    // 每 90/50ms 来一条通知：空闲计时器一直被推到 240ms，而硬上限钉在 200ms。
    await clock.advance(90);
    notify(child, 'session/update', { sessionId: 's1', update: {} });
    await flush();
    await clock.advance(50);
    notify(child, 'session/update', { sessionId: 's1', update: {} });
    await flush();
    await clock.advance(70);
    await expectation;
  } finally {
    client.close();
  }
});

test('硬上限可被 MOVA_ACP_PROMPT_CEILING_MS 覆盖（不传参数时）', async () => {
  const clock = createClock();
  const { client } = makeClient(clock, { promptIdleMs: 50, env: { MOVA_ACP_PROMPT_CEILING_MS: '400' } });
  try {
    const pending = client.request('session/prompt', { sessionId: 's1', prompt: [] });
    const expectation = assert.rejects(pending, error => {
      assert.equal(error.code, 'acp_idle_timeout');
      assert.equal(error.timeout.ceilingMs, 400, '环境变量必须生效');
      return true;
    });
    await clock.advance(60);
    await expectation;
  } finally {
    client.close();
  }
});

test('initialize / session/new 仍是固定超时，看门狗不介入（向后兼容）', async () => {
  const clock = createClock();
  const { child, client } = makeClient(clock, { timeoutMs: 100, promptIdleMs: 10_000 });
  try {
    const pending = client.request('initialize', { protocolVersion: 1 });
    const expectation = assert.rejects(pending, error => {
      assert.equal(error.code, 'acp_protocol');
      assert.match(error.detail, /initialize: 等待响应超时/);
      return true;
    });
    await clock.advance(50);
    // 与 initialize 无关的通知不该续期。
    notify(child, 'session/update', { sessionId: 's1', update: {} });
    await flush();
    await clock.advance(60);
    await expectation;
  } finally {
    client.close();
  }
});
