import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatTitleGenerator, parseTitle } = require('../electron/services/chat-title.cjs');

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
  return createChatTitleGenerator({
    resolve: async () => ({ provider, model, key: 'test-key' }),
    fetch: fetchImpl,
    timeoutMs: 1_000,
    sleep: async () => {},
    ...options,
  });
}

test('title generation asks the model for JSON and returns a clean title', async () => {
  let request;
  const generator = fixture(async (url, init) => {
    request = { url, body: JSON.parse(init.body), headers: init.headers };
    return response({ choices: [{ message: { content: '```json\n{"title":"深色登录页改版"}\n```' } }] });
  });
  const title = await generator.generate({ user: '把登录页改成深色', assistant: '好的，已调整。' });
  assert.equal(title, '深色登录页改版');
  assert.equal(request.url, 'http://127.0.0.1:8788/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.match(request.body.messages[1].content, /把登录页改成深色/);
  assert.match(request.body.messages[1].content, /好的，已调整。/);
});

test('a title is cleaned of quotes, prefixes, punctuation and length', () => {
  assert.equal(parseTitle('{"title":"「深色登录页」"}'), '「深色登录页」');
  assert.equal(parseTitle('标题：深色登录页。'), '深色登录页');
  assert.equal(parseTitle('"深色登录页"'), '深色登录页');
  assert.equal(parseTitle('{"title":""}'), '');
  assert.ok(parseTitle('一'.repeat(80)).length <= 24);
});

test('a failed or rate-limited title call yields an empty title instead of throwing', async () => {
  let calls = 0;
  const limited = fixture(async () => { calls += 1; return response({ error: 'rate' }, 429); });
  assert.equal(await limited.generate({ user: '问题' }), '');
  assert.equal(calls, 2, 'one retry after 429');

  const auth = fixture(async () => response({ error: 'bad key' }, 401));
  assert.equal(await auth.generate({ user: '问题' }), '', 'no retry for a credential error');

  const broken = fixture(async () => { throw new Error('offline'); });
  assert.equal(await broken.generate({ user: '问题' }), '');

  const garbage = fixture(async () => response({ choices: [{ message: { content: 'not json' } }] }));
  assert.equal(await garbage.generate({ user: '问题' }), 'not json', 'a plain answer is still usable');
});

test('an empty exchange never reaches the provider', async () => {
  let called = false;
  const generator = fixture(async () => { called = true; return response({}); });
  assert.equal(await generator.generate({ user: '   ' }), '');
  assert.equal(called, false);
});

test('anthropic protocol uses the messages endpoint', async () => {
  let request;
  const generator = createChatTitleGenerator({
    resolve: async () => ({ provider: { ...provider, protocol: 'anthropic' }, model, key: 'k' }),
    fetch: async (url, init) => {
      request = { url, body: JSON.parse(init.body), headers: init.headers };
      return response({ content: [{ type: 'text', text: '{"title":"登录改版"}' }] });
    },
    timeoutMs: 1_000,
  });
  assert.equal(await generator.generate({ user: '改登录页' }), '登录改版');
  assert.equal(request.url, 'http://127.0.0.1:8788/v1/messages');
  assert.equal(request.headers['x-api-key'], 'k');
  assert.equal(request.body.system.includes('name conversations'), true);
});

// ── 用「哪条对话真正在跑」的模型取名 ──────────────────────────────────────
test('generate 用调用方给的 providerId/modelId 解析模型，而不是持久化的 active', async () => {
  const seen = [];
  const providers = {
    resolveModel: async (providerId, modelId) => {
      seen.push([providerId, modelId]);
      return { provider: { ...provider, id: providerId }, model };
    },
    resolveActive: async () => { seen.push(['active']); return { provider, model }; },
    loadProviderKey: async () => 'key',
  };
  const generator = createChatTitleGenerator({
    providers,
    fetch: async () => response({ choices: [{ message: { content: '{"title":"深色登录页"}' } }] }),
    timeoutMs: 1_000,
  });
  assert.equal(await generator.generate({ user: '改登录页', providerId: 'local', modelId: 'deepseek-v4.1-flash' }), '深色登录页');
  assert.deepEqual(seen, [['local', 'deepseek-v4.1-flash']], '不能退回 resolveActive');
});

test('providerId/modelId 解析失败（模型被删/写错）时退回 active，绝不让取名抛错', async () => {
  const providers = {
    resolveModel: async () => { throw new Error('unknown model'); },
    resolveActive: async () => ({ provider, model }),
    loadProviderKey: async () => 'key',
  };
  const generator = createChatTitleGenerator({
    providers,
    fetch: async () => response({ choices: [{ message: { content: '{"title":"兜底标题"}' } }] }),
    timeoutMs: 1_000,
  });
  assert.equal(await generator.generate({ user: '改登录页', providerId: 'gone', modelId: 'gone' }), '兜底标题');
});

// ── 订阅账号：没有 API key，不能悄悄什么都不做 ────────────────────────────
const subscription = {
  chatgpt: { id: 'subscription:chatgpt', subscriptionProvider: 'chatgpt', protocol: 'openai', baseUrl: 'https://chatgpt.com/backend-api' },
  gemini: { id: 'subscription:gemini', subscriptionProvider: 'gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com' },
};

test('ChatGPT 订阅：没有 API key 时走取号函数，取不到号就如实返回空串（不发任何 HTTP）', async () => {
  let tokenCalls = 0;
  let httpCalls = 0;
  const generator = createChatTitleGenerator({
    providers: {
      resolveModel: async () => ({ provider: subscription.chatgpt, model }),
      resolveActive: async () => ({ provider: subscription.chatgpt, model }),
      // 内置订阅 provider 恒返回空串——这正是「标题永远不更新」的根因。
      loadProviderKey: async () => '',
    },
    acquireChatgptToken: async () => { tokenCalls += 1; return null; },
    fetch: async () => { httpCalls += 1; return response({}); },
    timeoutMs: 1_000,
  });
  assert.equal(await generator.generate({ user: '改登录页', providerId: 'subscription:chatgpt', modelId: 'gpt-6.1-sol' }), '');
  assert.equal(tokenCalls, 1, '必须真的去取号，而不是直接放弃');
  assert.equal(httpCalls, 0, '没有 key 时不能拿空 key 打上游');
});

test('Gemini 订阅：循环在 CLI 里，没有便宜的一次性文本接口 → 空串 + 不发 HTTP', async () => {
  let httpCalls = 0;
  const generator = createChatTitleGenerator({
    providers: {
      resolveModel: async () => ({ provider: subscription.gemini, model }),
      resolveActive: async () => ({ provider: subscription.gemini, model }),
      loadProviderKey: async () => '',
    },
    fetch: async () => { httpCalls += 1; return response({}); },
    timeoutMs: 1_000,
  });
  assert.equal(await generator.generate({ user: '改登录页', providerId: 'subscription:gemini', modelId: 'gemini-3.1-pro' }), '');
  assert.equal(httpCalls, 0);
});
