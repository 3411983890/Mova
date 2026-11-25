/**
 * 三个上下文工具（context_status / context_compact / context_read）的单元测试。
 *
 * 用真 ledger（消息自己造，零 IO），重点验证模型可见的四件事：
 * 工具声明是否合规、查账文本是否有数、压缩是否真的排进 pending 并上报、回查是否逐字分页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLedger } from '../electron/context/ledger.mjs';
import { createPendingCompactions } from '../electron/context/pending.mjs';
import { createContextTools } from '../electron/context/tools.mjs';

/** 造历史：偶数索引是 user、奇数是 assistant，与真实会话的交替形态一致。 */
function history(count = 40, repeat = 30) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index + 1} 轮：${'细节'.repeat(repeat)}`,
  }));
}

/**
 * 一套真实环境：真 ledger + 真 pending + 记录事件的 emit。
 * `ledgerFor` 刻意包一层，既模拟「延迟求值」，也顺便记录 compact 收到的参数（测夹取用）。
 */
function makeEnv({ messages = history(), contextWindow = 100_000, ledgerFor } = {}) {
  const ledger = createLedger({ messages });
  const pending = createPendingCompactions();
  const events = [];
  const calls = [];
  const view = {
    status: () => ledger.status(),
    read: (range) => ledger.read(range),
    compact: (options) => { calls.push(options); return ledger.compact(options); },
    get messages() { return ledger.messages; },
  };
  const tools = createContextTools({
    key: 'conv-1',
    ledgerFor: ledgerFor ?? (() => view),
    pending,
    emit: (event) => events.push(event),
    contextWindow,
  });
  return { ledger, pending, events, calls, tools };
}

test('definitions：三个工具齐全，参数是合法 JSON Schema，description 非空且不超过 3 行', () => {
  const { tools } = makeEnv();
  const names = tools.definitions.map((entry) => entry.name);
  assert.deepEqual(names, ['context_status', 'context_compact', 'context_read'], '三个工具必须都在，顺序固定');
  for (const definition of tools.definitions) {
    assert.equal(typeof definition.description, 'string', `${definition.name} 必须有 description`);
    assert.ok(definition.description.trim().length > 0, `${definition.name} 的 description 不能为空`);
    assert.ok(definition.description.split('\n').length <= 3, `${definition.name} 的 description 必须 ≤ 3 行`);
    assert.match(definition.description, /Call it/, `${definition.name} 必须明说「什么时候该调」（要主动）`);
    assert.equal(typeof definition.parameters, 'object', `${definition.name} 的 parameters 必须是对象`);
    assert.equal(definition.parameters.type, 'object', `${definition.name} 的 parameters.type 必须是 object`);
    assert.equal(typeof definition.parameters.properties, 'object', `${definition.name} 必须有 properties`);
    assert.equal(definition.parameters.additionalProperties, false, `${definition.name} 必须 additionalProperties:false`);
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(definition.parameters))), JSON.stringify(definition.parameters), `${definition.name} 的 parameters 必须可序列化`);
  }
  const compact = tools.definitions.find((entry) => entry.name === 'context_compact');
  const keepRecent = compact.parameters.properties.keepRecent;
  assert.equal(keepRecent.minimum, 4, 'keepRecent 下界必须是 4');
  assert.equal(keepRecent.maximum, 30, 'keepRecent 上界必须是 30');
  const read = tools.definitions.find((entry) => entry.name === 'context_read');
  assert.equal(read.parameters.properties.limit.maximum, 6000, 'limit 上界必须是 6000');
});

test('context_status：给出正数 tokens、占窗口百分比与可压缩条数', async () => {
  const { tools } = makeEnv();
  const result = await tools.handlers.context_status({});
  assert.notEqual(result.isError, true, '正常查账不该报错');
  const text = result.content[0].text;
  const tokens = Number((/约 ([\d,]+) tokens/.exec(text)?.[1] ?? '0').replace(/,/g, ''));
  assert.ok(tokens > 0, '必须报出正数的 token 估算');
  assert.match(text, /占窗口 \d+%/, '必须给出占窗口百分比');
  assert.match(text, /可压缩：\d+ 条旧消息/, '必须说明还有多少条可压缩');
  assert.match(text, /待生效：无/, '没有排队的压缩时要说「无」');
  assert.match(text, /分层：.*系统约束.*近期消息/, '六层的名字要出现在分层一行里');
});

test('context_status：已有待生效压缩时明说「有」并带覆盖条数', async () => {
  const env = makeEnv();
  await env.tools.handlers.context_compact({});
  const text = (await env.tools.handlers.context_status({})).content[0].text;
  assert.match(text, /待生效：有（程序摘要，覆盖 \d+ 条，下一次请求生效）/, '必须报出待生效压缩及其覆盖条数');
});

test('context_status：拿不到窗口大小时不编造百分比', async () => {
  const { tools } = makeEnv({ contextWindow: null });
  const text = (await tools.handlers.context_status({})).content[0].text;
  assert.match(text, /占窗口比例未知/, '没有窗口分母时必须明说比例未知');
  assert.doesNotMatch(text, /占窗口 \d+%/, '不许编一个默认窗口算百分比');
});

test('context_compact 成功：pending 有 payload、emit 收到 mode:model 的 context 事件', async () => {
  // 用「每条都很长」的历史：短消息压缩后摘要 + 归档索引反而可能更贵，那种情况下「变小」不成立。
  const env = makeEnv({ messages: history(40, 200) });
  const result = await env.tools.handlers.context_compact({ reason: '准备读一个长文件' });
  assert.notEqual(result.isError, true, '能压缩时不该报错');
  assert.match(result.content[0].text, /^已压缩 \d+ 条旧消息/, '要报出压缩了多少条');
  assert.match(result.content[0].text, /下一次请求生效/, '必须明确告知「下一次请求生效」');
  assert.match(result.content[0].text, /context_read 回查/, '必须提示原文可回查');

  const payload = env.pending.peek('conv-1');
  assert.ok(payload, 'pending 里必须有这条 key 的 payload');
  assert.deepEqual(Object.keys(payload).sort(), ['archive', 'coveredCount', 'coveredIds', 'createdAt', 'source', 'summaryBlock'], 'payload 字段必须与 wiring 对齐');
  assert.ok(payload.coveredIds.length > 0, 'coveredIds 不能为空');
  assert.equal(payload.coveredCount, payload.coveredIds.length, 'coveredCount 必须与 coveredIds 一致');
  assert.ok(payload.summaryBlock.includes('span='), '摘要块必须带 span');
  assert.ok(payload.archive.length === payload.coveredCount, '归档条数必须等于覆盖条数');

  const event = env.events.find((item) => item.type === 'context');
  assert.ok(event, '必须发出 context 事件');
  assert.equal(event.report.mode, 'model', '模型主动压缩必须标成 model');
  assert.equal(event.report.estimated, true, '必须标注是估算值');
  assert.equal(event.report.layers.length, 6, '六层必须齐全');
  assert.ok(event.report.compaction.covered > 0, '必须报告覆盖条数');
  assert.equal(event.report.compaction.source, 'deterministic', '没有摘要器时来源是确定性摘要');
  assert.ok(event.report.tokens.before > event.report.tokens.after, '压缩后必须真的变小');
  assert.equal(event.report.messages.total, 40, '总条数应保持原始条数');
  assert.ok(event.report.messages.sent < 40, '实际发送条数必须变少');
});

test('context_compact 无可压缩区间：明说原因、不写 pending、不产生 compaction 事件', async () => {
  const env = makeEnv({ messages: history(3) });
  const result = await env.tools.handlers.context_compact({});
  assert.equal(result.isError, true, '压不动必须如实报错，不能假装成功');
  assert.match(result.content[0].text, /没有可压缩区间/, '必须给出「没有可压缩区间」');
  assert.equal(env.pending.size(), 0, '压不动就绝不能写 pending');
  assert.equal(env.events.some((item) => item.report?.compaction), false, '压不动不该产生 compaction 报告');
});

test('context_compact：keepRecent 越界被夹到 4–30', async () => {
  const high = makeEnv();
  await high.tools.handlers.context_compact({ keepRecent: 100 });
  assert.equal(high.calls.at(-1).keepRecent, 30, '超过 30 必须夹到 30');
  assert.equal(high.pending.peek('conv-1').coveredCount, 9, '保留 30 条时只压掉中间 9 条');

  const low = makeEnv();
  await low.tools.handlers.context_compact({ keepRecent: 1 });
  assert.equal(low.calls.at(-1).keepRecent, 4, '低于 4 必须夹到 4');
  assert.equal(low.pending.peek('conv-1').coveredCount, 35, '保留 4 条时压掉 35 条');
});

test('context_read：分页逐字一致，首行给出范围与 nextOffset', async () => {
  const env = makeEnv();
  await env.tools.handlers.context_compact({});
  const expected = env.pending.peek('conv-1').archive.map((entry) => entry.text).join('\n');

  const first = await env.tools.handlers.context_read({ offset: 0, limit: 100 });
  const [header, ...rest] = first.content[0].text.split('\n');
  assert.match(header, /^\[原文回查 0–100 \/ 共 [\d,]+ 字符｜nextOffset=100｜来自待生效压缩的归档\]$/, '首行必须给出范围、总数与 nextOffset');
  assert.equal(rest.join('\n'), expected.slice(0, 100), '正文必须与原文逐字一致');

  const nextOffset = Number(/nextOffset=(\d+)/.exec(header)[1]);
  const second = await env.tools.handlers.context_read({ offset: nextOffset, limit: 100 });
  const secondBody = second.content[0].text.split('\n').slice(1).join('\n');
  assert.equal(secondBody, expected.slice(nextOffset, nextOffset + 100), '第二页必须无缝衔接');

  const last = await env.tools.handlers.context_read({ offset: expected.length - 10, limit: 100 });
  assert.match(last.content[0].text.split('\n')[0], /已到末尾/, '读到最后必须标「已到末尾」');
  assert.equal(last.content[0].text.split('\n').slice(1).join('\n'), expected.slice(-10), '末尾页也必须逐字一致');
});

test('context_read：越界给出明确范围提示，而且是文本不是异常', async () => {
  const env = makeEnv();
  await env.tools.handlers.context_compact({});
  const total = env.pending.peek('conv-1').archive.map((entry) => entry.text).join('\n').length;

  for (const offset of [total, total + 5000, 999_999]) {
    const result = await env.tools.handlers.context_read({ offset, limit: 100 });
    const text = result.content[0].text;
    assert.notEqual(result.isError, true, '越界不该标 isError（模型可以自己改 offset 重试）');
    assert.match(text, /回查范围无效/, '必须明说范围无效');
    assert.ok(text.includes(`可用范围 0–${total.toLocaleString('en-US')}`), '必须给出可用范围');
  }
  const badLimit = await env.tools.handlers.context_read({ offset: 0, limit: 0 });
  assert.match(badLimit.content[0].text, /回查范围无效/, 'limit=0 也必须给范围提示而不是抛错');
  const fractional = await env.tools.handlers.context_read({ offset: 1.5, limit: 10 });
  assert.match(fractional.content[0].text, /回查范围无效/, '非整数 offset 也必须被拒绝');
});

test('context_read：单次最多 6000 字符（limit 超出被夹住）', async () => {
  const env = makeEnv({ messages: history(40, 200) });
  await env.tools.handlers.context_compact({});
  const result = await env.tools.handlers.context_read({ offset: 0, limit: 99_999 });
  const [header, ...rest] = result.content[0].text.split('\n');
  assert.equal(rest.join('\n').length, 6000, '一次最多返回 6000 字符');
  assert.match(header, /原文回查 0–6000/, '范围必须反映真实的 6000 上限');
  assert.match(header, /nextOffset=6000/, '被截断时必须给出 nextOffset');
});

test('context_read：有 pending 时读归档（不是整窗原文）', async () => {
  const env = makeEnv();
  await env.tools.handlers.context_compact({});
  const result = await env.tools.handlers.context_read({ offset: 0, limit: 200 });
  const body = result.content[0].text.split('\n').slice(1).join('\n');
  assert.ok(body.startsWith('第 2 轮'), '归档里第一条是被压缩的 m2');
  assert.equal(body.includes('第 1 轮'), false, '首条用户消息不在归档里（它被保留）');
});

test('context_read：没有 pending 时退回 ledger.read', async () => {
  const env = makeEnv();
  const expected = env.ledger.read({ offset: 0, limit: 50 });
  const result = await env.tools.handlers.context_read({ offset: 0, limit: 50 });
  const [header, ...rest] = result.content[0].text.split('\n');
  assert.equal(rest.join('\n'), expected.text, '必须退回 ledger.read 并逐字返回');
  assert.match(header, /原文回查 0–50/, '首行仍然要给范围');
});

test('handler 内部抛错：收敛成 isError:true，不向上抛', async () => {
  const pending = createPendingCompactions();
  const tools = createContextTools({
    key: 'conv-1',
    ledgerFor: () => { throw new Error('台账炸了'); },
    pending,
    emit: () => {},
  });
  for (const name of ['context_status', 'context_compact', 'context_read']) {
    const result = await tools.handlers[name]({});
    assert.equal(result.isError, true, `${name} 必须标成 isError`);
    assert.match(result.content[0].text, /台账炸了/, `${name} 必须把原因写进文本`);
  }
});

test('abort 信号：立刻返回「已中止」，不做任何压缩', async () => {
  const env = makeEnv();
  const controller = new AbortController();
  controller.abort();
  const compacted = await env.tools.handlers.context_compact({}, { signal: controller.signal });
  assert.match(compacted.content[0].text, /已中止/, '被中止时必须明说');
  assert.notEqual(compacted.isError, true, '中止不算内部错误');
  assert.equal(env.pending.size(), 0, '中止后不能留下 pending');
  const read = await env.tools.handlers.context_read({ offset: 0, limit: 10 }, { signal: controller.signal });
  assert.match(read.content[0].text, /已中止/, '读取被中止时也必须立刻返回');
});

test('也接受 chat-agent 既有签名 (id, input, signal)', async () => {
  const env = makeEnv();
  const result = await env.tools.handlers.context_status('call-123', {}, { signal: new AbortController().signal });
  assert.match(result.content[0].text, /上下文占用/, '首个参数是调用 id 时也要正确取到入参');
});
