'use strict';
// Conversation titles from the model, instead of using the user's question verbatim.
//
// One short request after the first exchange, no streaming, never fatal: the caller keeps the
// derived title when this fails (rate limit, offline, bad JSON), so a conversation is never blocked
// or left unnamed by a title call.

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 3_000;
const MAX_TITLE_CHARS = 24;
// Rate limits are common right after a reply stream finishes; one retry is enough to ride it out.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;

const TITLE_PROMPT = `You name conversations. Read the exchange below and reply with JSON only:
{"title":"..."}

Rules:
- Write the title in the user's language, at most 12 Chinese characters or 6 words.
- Name the topic or task, not the greeting: "把登录页改成深色" not "用户要求修改界面".
- No quotes, no trailing period, no "标题：" prefix, no emoji.
- Never include secrets, keys, passwords, phone numbers or file paths.
- If the exchange has no clear topic, return {"title":""}.`;

function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function joinEndpoint(base, path) {
  const root = String(base || '').replace(/\/+$/, '');
  // A base that already carries the version must not grow a second one.
  if (root.endsWith('/v1') && path.startsWith('/v1/')) return `${root}${path.slice(3)}`;
  return `${root}${path}`;
}

function endpointFor(provider) {
  return provider.protocol === 'anthropic'
    ? joinEndpoint(provider.baseUrl, '/v1/messages')
    : joinEndpoint(provider.baseUrl, '/chat/completions');
}

function headersFor(provider, key) {
  if (provider.protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    accept: 'application/json',
  };
}

function bodyFor(provider, model, system, user) {
  if (provider.protocol === 'anthropic') {
    return {
      model: model.id,
      max_tokens: 64,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    };
  }
  return {
    model: model.id,
    temperature: 0.2,
    max_tokens: 64,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

function textFromPayload(protocol, payload) {
  if (protocol === 'anthropic') {
    return (payload?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('');
  }
  return payload?.choices?.[0]?.message?.content ?? '';
}

/**
 * The model answers with JSON, but small models sometimes wrap it in a fence or add a prefix, so
 * the first JSON object is read out of the text, then the value is cleaned to a bare title.
 */
function parseTitle(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let value = '';
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = false;
  if (match) {
    try {
      const json = JSON.parse(match[0]);
      parsed = true;
      if (typeof json?.title === 'string') value = json.title;
    } catch { parsed = false; }
  }
  // A well-formed answer that names nothing is a deliberate "no title": do not fall back to
  // echoing the raw JSON back as one.
  if (!value && !parsed) {
    // No JSON at all: some models ignore the format request, so a single line is still usable.
    value = text.replace(/^```[a-z]*\s*|\s*```$/g, '').split('\n')[0];
  }
  return clip(value
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    .replace(/[。．,.!！?？]+$/, ''), MAX_TITLE_CHARS);
}

function createChatTitleGenerator(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const logger = options.logger || null;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : delay => new Promise(resolve => { setTimeout(resolve, delay); });
  const retry = options.retry !== false;

  /** ChatGPT 订阅：凭据不是 API key，而是账号池里的 access token（由调用方注入取号函数）。 */
  const isChatgptSubscription = provider => Boolean(provider)
    && (provider.id === 'subscription:chatgpt' || provider.subscriptionProvider === 'chatgpt');

  /**
   * 用 ChatGPT 订阅通道取一次标题。
   *
   * 为什么必须单独一条路：内置订阅 provider 的 `loadProviderKey()` 恒返回空串（凭据是本机 OAuth），
   * 所以按 key 判断的那条 HTTP 分支对订阅用户**永远**返回空——用户看到的就是「标题一直不更新」。
   * 这里走 pi-ai 的 `openai-codex-responses`（与聊天同一条协议），一次短请求即可。
   * 模型对象复用 chat-agent 的 `piModel()`，避免两处各写一份 codex 模型字段。
   */
  async function chatgptTitle({ provider, model, body }) {
    if (typeof options.acquireChatgptToken !== 'function') return '';
    const turn = await options.acquireChatgptToken();
    const token = typeof turn?.accessToken === 'string' ? turn.accessToken : '';
    if (!token) return '';
    const [{ piModel }, { streamSimple }] = await Promise.all([
      import('../chat-agent.mjs'),
      import('@earendil-works/pi-ai/api/openai-codex-responses'),
    ]);
    // 按模型分配了线路时用代理 fetch：chatapt.com 在直连环境下不可达，取名不能因此永远失败。
    const proxied = typeof options.resolveFetch === 'function'
      ? await Promise.resolve(options.resolveFetch(provider.id, model.id)).catch(() => null)
      : null;
    const stream = streamSimple(piModel(model, provider), {
      systemPrompt: TITLE_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: body }], timestamp: Date.now() }],
      tools: [],
    }, {
      apiKey: token,
      // 原生 WebSocket 会绕过我们分配的线路（见 chat-agent 的 streamFor）：有代理时钉死 SSE。
      ...(proxied ? { transport: 'sse', fetch: proxied } : {}),
      maxRetries: 0,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let text = '';
    let final = '';
    for await (const event of stream) {
      if (event?.type === 'text_delta' && typeof event.delta === 'string') text += event.delta;
      if (event?.type === 'done' && event.message) {
        final = (event.message.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('');
      }
      if (event?.type === 'error') return '';
    }
    return final || text;
  }

  async function resolveTarget({ providerId, modelId } = {}) {
    if (typeof options.resolve === 'function') return options.resolve();
    const providers = options.providers || require('../providers.cjs');
    // 优先用「这条对话真正在跑的模型」：`resolveActive()` 读的是持久化的选择，
    // 和输入框里选中的模型可能不是同一个——拿错 provider 就会连 key 都取不到，标题永远生成不出来。
    let target = null;
    if (typeof providerId === 'string' && providerId && typeof modelId === 'string' && modelId) {
      try {
        target = await providers.resolveModel(providerId, modelId);
      } catch {
        target = null; // 手填/已删除的模型：退回持久化的 active，不要让标题拖垮发送
      }
    }
    if (!target) target = await providers.resolveActive();
    // 内置订阅 provider 没有 API key（凭据是本机 CLI / OAuth）：这里如实返回空串，
    // 由 generate() 走注入的 subscriptionTitle 分支，而不是假装「没有可用的模型」。
    const key = options.key || await providers.loadProviderKey(target.provider.id).catch(() => '');
    return { provider: target.provider, model: target.model, key };
  }

  /** Returns a title, or '' when there is nothing usable (never throws for a bad title). */
  async function generate({ user, assistant, providerId, modelId } = {}) {
    const question = clip(user, MAX_INPUT_CHARS);
    if (!question) return '';
    const answer = clip(assistant, MAX_INPUT_CHARS);
    const body = answer
      ? `User: ${question}\n\nAssistant: ${answer}`
      : `User: ${question}`;
    const target = await resolveTarget({ providerId, modelId });
    if (!target?.provider || !target?.model) return '';
    if (!target.key) {
      // 内置订阅 provider 没有 API key（凭据是本机 OAuth / CLI 登录态）。
      if (isChatgptSubscription(target.provider)) {
        try {
          return clip(parseTitle(await chatgptTitle({ provider: target.provider, model: target.model, body })), MAX_TITLE_CHARS);
        } catch (error) {
          logger?.warn?.(`[chat-title] subscription title failed: ${error?.message || error}`);
          return '';
        }
      }
      // Gemini 订阅的 agent 循环在 `agy` 里，没有便宜的一次性文本接口：
      // 如实返回空串，调用方保留「即时标题」（绝不为取名去 spawn 一个 CLI 进程）。
      logger?.info?.(`[chat-title] no api key for ${target.provider.id}; keeping the derived title`);
      return '';
    }
    if (typeof fetchImpl !== 'function') return '';
    let response;
    for (let attempt = 1; ; attempt += 1) {
      try {
        response = await fetchImpl(endpointFor(target.provider), {
          method: 'POST',
          headers: headersFor(target.provider, target.key),
          body: JSON.stringify(bodyFor(target.provider, target.model, TITLE_PROMPT, body)),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        logger?.warn?.(`[chat-title] request failed: ${error?.message || error}`);
        return '';
      }
      if (!RETRYABLE_STATUS.has(Number(response?.status)) || !retry || attempt >= MAX_ATTEMPTS) break;
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      await sleep(RETRY_DELAY_MS * attempt);
    }
    if (!response?.ok) {
      try { await response?.body?.cancel?.(); } catch { /* best effort */ }
      logger?.info?.(`[chat-title] HTTP ${response?.status}, keeping the derived title`);
      return '';
    }
    let payload;
    try { payload = await response.json(); } catch { return ''; }
    const title = parseTitle(textFromPayload(target.provider.protocol, payload));
    if (title) logger?.info?.(`[chat-title] ${target.provider.id}/${target.model.id} -> ${title}`);
    return title;
  }

  return { generate, parseTitle };
}

module.exports = { createChatTitleGenerator, parseTitle, TITLE_PROMPT, MAX_TITLE_CHARS };
