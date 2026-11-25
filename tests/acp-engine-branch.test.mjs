/**
 * `engine:'acp'` 支路的可达性与失败语义。
 *
 * 为什么单独测：这是 chat-agent 里唯一一条「提前返回」的支路，
 * 一旦判定写错，用户点了 Gemini 会得到一条看不懂的网络错误，或者更糟——
 * 被静默降级到 API Key 通道（那等于用错额度）。
 * 这里锁三件事：支路可达、缺 CLI 明确报 not_configured、普通模型不受影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runChatAgent } from '../electron/chat-agent.mjs';

const entry = { id: 'gemini-test', name: 'Gemini', vision: false, efforts: [] };
const provider = { id: 'subscription:gemini', kind: 'subscription', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
const messages = [{ role: 'user', text: '看一下项目结构' }];

function run(request, extra = {}) {
  return runChatAgent({
    key: '', provider, entry, request, signal: new AbortController().signal,
    emit: () => {}, fetchModel: async () => { throw new Error('不该走到 HTTP 通道'); },
    ...extra,
  });
}

test('engine=acp 且没有 acpCommand：明确报 not_configured，不静默降级', async () => {
  await assert.rejects(
    () => run({ engine: 'acp', messages }),
    error => {
      assert.equal(error.code, 'not_configured', '必须报「未配置」，而不是 network/protocol');
      return true;
    },
  );
});

test('engine=acp 且有 acpCommand 但提示词为空：报 request，不启动进程', async () => {
  await assert.rejects(
    () => run({ engine: 'acp', acpCommand: 'C:/nonexistent/agy.exe', messages: [{ role: 'user', text: '   ' }] }),
    error => {
      assert.equal(error.code, 'request');
      return true;
    },
  );
});

test('engine=acp 且有 acpCommand 但文件不存在：仍然收敛成 not_configured（不抛裸异常）', async () => {
  await assert.rejects(
    () => run({ engine: 'acp', acpCommand: 'C:/nonexistent-'+Date.now()+'/agy.exe', messages }),
    error => {
      assert.equal(typeof error.code, 'string', '必须是带 code 的 ModelError');
      assert.equal(error.code, 'not_configured');
      return true;
    },
  );
});

test('没有 engine 字段时走原有通道，ACP 支路不介入', async () => {
  let payload = null;
  const chunk = `data: ${JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', created: 1, model: entry.id,
    choices: [{ index: 0, delta: { content: '好的' }, finish_reason: 'stop' }],
  })}\n\n`;
  await runChatAgent({
    key: 'test', provider: { id: 'plain', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' },
    entry, request: { messages }, signal: new AbortController().signal, emit: () => {},
    fetchModel: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response(`${chunk}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  assert.ok(payload, '普通 provider 必须真的发出 HTTP 请求');
});
