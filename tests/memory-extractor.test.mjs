import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLlmMemoryExtractor } = require('../electron/services/memory-extractor.cjs');

const provider = { id: 'local', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1' };
const model = { id: 'deepseek-v4.1-flash' };

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    body: { async cancel() {} },
  };
}

function fixture(fetchImpl, options = {}) {
  return createLlmMemoryExtractor({
    resolve: async () => ({ provider, model, key: 'test-key' }),
    fetch: fetchImpl,
    timeoutMs: 1_000,
    ...options,
  });
}

test('LLM extractor sends a JSON extraction request and parses fenced memories', async () => {
  let request;
  const extractor = fixture(async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return response({
      choices: [{ message: { content: '```json\n{"memories":[{"text":"用户使用 PostgreSQL","kind":"fact","key":"database","confidence":0.91}]}\n```' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
  });
  const result = await extractor.extract('记住：我们的数据库是 PostgreSQL', { projectId: 'Alpha' });
  assert.equal(request.url, 'http://127.0.0.1:8788/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'deepseek-v4.1-flash');
  assert.equal(request.body.response_format.type, 'json_object');
  assert.match(request.body.messages[0].content, /long-term memory extractor/);
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].text, '用户使用 PostgreSQL');
  assert.equal(result.memories[0].key, 'database');
  assert.equal(result.usage.totalTokens, 150);
  assert.equal(result.providerId, 'local');
});

test('订阅通道上对话时，记忆提取退到第一个有密钥的通道', async () => {
  // 订阅通道（ChatGPT / Gemini）没有 API Key：凭据在 CLI 自己手里。
  // 提取器如果死盯「当前 provider」，用户每条消息都会看到「记忆提取不可用」。
  let request = null;
  const providers = {
    resolveActive: async () => ({
      provider: { id: 'subscription:chatgpt', kind: 'subscription', protocol: 'openai', baseUrl: 'https://chatgpt.com/backend-api' },
      model: { id: 'gpt-6.1-sol' },
    }),
    loadProviderKey: async id => (id === 'local' ? 'local-key' : ''),
    listProviders: async () => ({
      providers: [
        { id: 'subscription:chatgpt', kind: 'subscription', protocol: 'openai', baseUrl: 'https://chatgpt.com/backend-api', models: [{ id: 'gpt-6.1-sol' }] },
        { id: 'local', protocol: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', models: [{ id: 'deepseek-chat' }] },
      ],
    }),
  };
  const extractor = createLlmMemoryExtractor({
    providers,
    fetch: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return response({ choices: [{ message: { content: '{"memories":[]}' } }] });
    },
    retry: false,
  });

  const result = await extractor.extract('记住：我们的数据库是 PostgreSQL');
  assert.equal(request.url, 'http://127.0.0.1:8788/v1/chat/completions', '要打到有密钥的那个通道');
  assert.equal(request.init.headers.authorization, 'Bearer local-key');
  assert.equal(request.body.model, 'deepseek-chat');
  assert.equal(result.providerId, 'local');
});

test('一个带密钥的通道都没有时，仍然明确报 llm-unavailable', async () => {
  const extractor = createLlmMemoryExtractor({
    providers: {
      resolveActive: async () => ({
        provider: { id: 'subscription:gemini', kind: 'subscription', protocol: 'openai', baseUrl: 'https://chatgpt.com/backend-api' },
        model: { id: 'gemini-4-argon' },
      }),
      loadProviderKey: async () => '',
      listProviders: async () => ({ providers: [{ id: 'subscription:gemini', kind: 'subscription', models: [{ id: 'gemini-4-argon' }] }] }),
    },
    fetch: async () => response({ choices: [{ message: { content: '{"memories":[]}' } }] }),
    retry: false,
  });
  await assert.rejects(() => extractor.extract('记住 1887'), error => error.code === 'llm-unavailable');
});

test('LLM extractor redacts secrets before sending and never emits sensitive candidates', async () => {
  let body;
  const extractor = fixture(async (_url, init) => {
    body = init.body;
    return response({ choices: [{ message: { content: '{"memories":[]}' } }] });
  });
  await extractor.extract('我的密码是 hunter2，记住 sk-abcdefghijklmnop');
  assert.doesNotMatch(body, /hunter2/);
  assert.doesNotMatch(body, /sk-abcdefghijklmnop/);
  assert.match(body, /\[REDACTED\]/);
});

test('LLM extractor exposes stable failure codes without falling back to rules', async () => {
  const unauthorized = fixture(async () => response({ error: 'bad key' }, 401));
  await assert.rejects(() => unauthorized.extract('记住 1887'), error => error.code === 'llm-auth');

  const timeout = fixture(async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; });
  await assert.rejects(() => timeout.extract('记住 1887'), error => error.code === 'llm-timeout');

  const invalid = fixture(async () => response({ choices: [{ message: { content: 'not json' } }] }));
  await assert.rejects(() => invalid.extract('记住 1887'), error => error.code === 'llm-invalid-output');
});

test('A rate-limited extraction is retried instead of losing the memory', async () => {
  // One 429 followed by success: the memory must survive, because the user cannot re-run
  // extraction for a message that has already been sent.
  let calls = 0;
  const delayed = [];
  const extractor = fixture(async () => {
    calls += 1;
    if (calls === 1) return response({ error: 'rate limited' }, 429);
    return response({
      choices: [{ message: { content: '{"memories":[{"text":"用户使用 PostgreSQL","kind":"fact","key":"database","confidence":0.9}]}' } }],
    });
  }, { sleep: async delay => { delayed.push(delay); } });
  const result = await extractor.extract('记住：数据库是 PostgreSQL');
  assert.equal(calls, 2, 'should retry once after 429');
  assert.equal(delayed.length, 1);
  assert.equal(result.memories.length, 1);

  // A provider that stays limited still fails, with the same code, after bounded attempts.
  let exhausted = 0;
  const limited = fixture(async () => { exhausted += 1; return response({ error: 'rate limited' }, 429); }, { sleep: async () => {} });
  await assert.rejects(() => limited.extract('记住 1887'), error => error.code === 'llm-rate-limit');
  assert.equal(exhausted, 3, 'three attempts in total');
});

test('LLM reranker only returns IDs that exist in the candidate set', async () => {
  const extractor = fixture(async () => response({
    choices: [{ message: { content: '{"ids":["b","invented","a"]}' } }],
  }));
  const result = await extractor.rerank('数据库选型', [
    { id: 'a', text: '使用 PostgreSQL' },
    { id: 'b', text: '数据库是 PostgreSQL' },
    { id: 'c', text: '喜欢简洁界面' },
  ], 2);
  assert.deepEqual(result.ids, ['b', 'a']);
  assert.equal(result.reranked, true);
});

test('Anthropic protocol uses messages endpoint and x-api-key', async () => {
  let request;
  const extractor = createLlmMemoryExtractor({
    resolve: async () => ({ provider: { id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }, model: { id: 'claude-test' }, key: 'secret' }),
    fetch: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return response({ content: [{ type: 'text', text: '{"memories":[{"text":"用户喜欢中文","kind":"preference"}]}' }], usage: { input_tokens: 10, output_tokens: 5 } });
    },
  });
  const result = await extractor.extract('我喜欢中文');
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.headers['x-api-key'], 'secret');
  assert.equal(request.body.system.length > 0, true);
  assert.equal(result.memories[0].kind, 'preference');
  assert.equal(result.usage.totalTokens, 15);
});
