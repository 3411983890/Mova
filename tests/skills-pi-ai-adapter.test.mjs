/**
 * 负责：钉住 pi-ai 适配层（electron/skills/adapters/pi-ai.mjs）的三条契约——
 *   1) `tools[]` 的每一项都必须带 `name / label / description / parameters`（缺一个 pi-ai 的
 *      agent 循环就会把工具丢掉或发不出参数 schema）；
 *   2) `exposure.piAi === false` 的工具**不出现**（这是「只暴露真的能干的」的唯一开关）；
 *   3) `execute(callId, input, signal)` 把 signal 原样透到 handler（长任务要能被「停止」取消）。
 * 不负责：manifest 校验（tests/skills-manifest）、注册表裁剪（tests/skills-registry）、
 *   MCP 工具表（tests/skills-adapters）、装配（tests/skills-wiring）。
 * 被谁调用：node --test。纯内存：假 pack + 真 buildSkillRuntime，零 Electron、零网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toPiAiTools } from '../electron/skills/adapters/pi-ai.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';

/** 一份最小可用 manifest：只声明本文件要断言的东西。 */
function tool(name, { piAi = true, mcp = 'on_demand' } = {}) {
  return {
    name,
    label: `${name} 展示名`,
    description: `Do ${name} with the given text.`,
    mcpSummary: `${name} 一行摘要。`,
    risk: 'read',
    approval: { mode: 'policy' },
    exposure: { piAi, mcp },
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    examples: [{ title: '示例', arguments: { text: 'hi' } }],
  };
}

/**
 * 假 pack：`read_file` / `clock` 暴露给 pi-ai，`internal_only` 只在进程内（piAi:false）。
 * handler 把收到的 signal / callId / transport 记进 `seen`，供「透传」断言使用。
 */
function makeRuntime({ seen = [] } = {}) {
  const pack = {
    manifest: {
      apiVersion: 1,
      id: 'pi-ai-demo',
      version: '1.0.0',
      title: 'pi-ai 投影测试包',
      summary: '只用于适配层测试的最小技能包。',
      capabilities: ['demo.read'],
      dependencies: [],
      permissions: { fs: 'none', exec: false, net: false, desktop: false, browser: false, canvas: false, memory: 'none' },
      deprecation: null,
      tools: [
        tool('read_file', { mcp: 'core' }),
        tool('clock'),
        tool('internal_only', { piAi: false, mcp: 'off' }),
      ],
    },
    createHandlers: () => ({
      read_file: async (args, ctx) => {
        seen.push({ name: 'read_file', args, callId: ctx.callId, signal: ctx.signal, transport: ctx.transport });
        return { content: [{ type: 'text', text: `hello ${args.text}` }] };
      },
      clock: async (_args, ctx) => {
        seen.push({ name: 'clock', callId: ctx.callId, signal: ctx.signal, transport: ctx.transport });
        return { content: [{ type: 'text', text: '12:00' }] };
      },
      internal_only: async () => 'secret',
    }),
  };
  return buildSkillRuntime({ packs: [pack], deps: {} });
}

test('toPiAiTools 的每一项都带 name/label/description/parameters（pi-ai 缺一个就发不出工具）', () => {
  const tools = toPiAiTools(makeRuntime());
  assert.deepEqual(tools.map(item => item.name), ['read_file', 'clock'], 'piAi:false 的 internal_only 不能出现');
  for (const item of tools) {
    assert.deepEqual(Object.keys(item).sort(), ['description', 'execute', 'label', 'name', 'parameters'],
      `${item.name} 的字段集合必须正好是 pi-ai 要的这五个`);
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.label, 'string');
    assert.ok(item.description.length > 0, `${item.name} 必须有非空 description`);
    assert.equal(item.parameters?.type, 'object', `${item.name} 必须带 JSON Schema parameters`);
    assert.equal(item.parameters.additionalProperties, false);
    assert.equal(typeof item.execute, 'function');
  }
});

test('exposure.piAi === false 的工具在 pi-ai 侧完全不可达：投影里没有它，模型就无从调用', async () => {
  const seen = [];
  const runtime = makeRuntime({ seen });
  const tools = toPiAiTools(runtime);
  assert.equal(tools.some(item => item.name === 'internal_only'), false, 'internal_only 不能出现在 tools[] 里');
  // pi-ai 是按工具对象调用、不是按名字路由，所以 tools[] 就是唯一的边界：
  // 投影里没有它，模型既看不到也调不到（对比 MCP 侧还要挡名字，见 adapters/mcp.mjs）。
  for (const item of tools) {
    const result = await item.execute('call-x', { text: 'ok' }, undefined);
    assert.equal(result.isError, undefined, `${item.name} 应当可正常执行`);
  }
  assert.equal(seen.some(entry => entry.name === 'internal_only'), false, '关掉的工具一次都不该被执行');
});

test('execute(callId, input, signal) 把 signal 与 callId 原样交给 handler，并标记 transport:pi-ai', async () => {
  const seen = [];
  const tools = toPiAiTools(makeRuntime({ seen }));
  const readFile = tools.find(item => item.name === 'read_file');
  const controller = new AbortController();

  const result = await readFile.execute('call-7', { text: 'mova' }, controller.signal);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /hello mova/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].callId, 'call-7', 'callId 要透传：前端靠它把 running/done 落在同一行');
  assert.equal(seen[0].signal, controller.signal, 'signal 必须原样透传，否则「停止」取消不了工具');
  assert.equal(seen[0].transport, 'pi-ai', '通道标记由适配层负责，handler 不该自己猜');

  // 取消后的 signal 交给 handler：由 handler 自己决定怎么响应，适配层不吞。
  controller.abort();
  await readFile.execute('call-8', { text: 'x' }, controller.signal);
  assert.equal(seen[1].signal.aborted, true, '已经取消的 signal 必须照样透传');
});

test('execute 缺 cid/signal 也能跑（纯单测与无人观看通道零副作用）', async () => {
  const seen = [];
  const tools = toPiAiTools(makeRuntime({ seen }));
  const clock = tools.find(item => item.name === 'clock');
  const result = await clock.execute(undefined, undefined, undefined);
  assert.equal(result.isError, undefined);
  assert.equal(seen[0].signal, undefined);
});

test('onTiming 收到每一次调用的耗时样本，且它抛错不会把工具调用变成失败', async () => {
  const samples = [];
  const tools = toPiAiTools(makeRuntime(), { onTiming: sample => samples.push(sample) });
  await tools[0].execute('call-9', { text: 'a' }, undefined);
  assert.equal(samples.length, 1);
  assert.deepEqual(Object.keys(samples[0]).sort(), ['callId', 'durationMs', 'name', 'ok', 'transport']);
  assert.equal(samples[0].name, 'read_file');
  assert.equal(samples[0].transport, 'pi-ai');
  assert.equal(samples[0].ok, true);

  const broken = toPiAiTools(makeRuntime(), { onTiming: () => { throw new Error('计时炸了'); } });
  const result = await broken[0].execute('call-10', { text: 'b' }, undefined);
  assert.equal(result.isError, undefined, '诊断旁路失败不能变成工具失败');
  assert.match(result.content[0].text, /hello b/);
});
