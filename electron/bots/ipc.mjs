/**
 * 负责：将 Mova Bot 与小程序后端运行时挂载到 Electron 主进程 IPC，并将状态事件推送给渲染窗口；
 *   同时对接已配置的模型凭据（若存在真实可用 API Key 则调用真实模型，否则回退到本地策略合成），并管理后台常驻关闭判定。
 * 不负责：具体业务状态机实现（全部委托给 electron/bots/runtime.mjs）。
 * 被谁调用：electron/main.cjs。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBotRuntime } from './runtime.mjs';
import { waitForCloudTask } from '../../src/services/cloud-tasks.mjs';

const require = createRequire(import.meta.url);

export function mapMemorySnapshotToExternalChats(snapshot) {
  const rows = snapshot?.sessions?.conversations;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const convId = String(row[0] || '');
    const data = row[1];
    if (!convId || !data || typeof data !== 'object') continue;
    let parts = null;
    try { parts = JSON.parse(convId); } catch { parts = null; }
    if (data.temporary || data.archived || data.vault || data.deleted || data.deletedAt) continue;
    if (Array.isArray(parts) && /temporary|临时/i.test(String(parts[0] || ''))) continue;

    const rawMsgs = Array.isArray(data) ? data : (Array.isArray(data.messages) ? data.messages : []);
    const messages = [];
    for (const m of rawMsgs) {
      if (!m || typeof m !== 'object') continue;
      if (m.temporary || m.mock || m.demo || ['mock', 'demo'].includes(m.source)) continue;
      const msgAt = typeof m.createdAt === 'number'
        ? m.createdAt
        : (Date.parse(m.createdAt || '') || Number(data.updatedAt) || 0);
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const primaryText = typeof (m.text ?? m.user ?? m.content) === 'string'
        ? (m.text ?? m.user ?? m.content).trim()
        : '';
      if (primaryText) {
        messages.push({
          id: m.id || `${convId}_${messages.length}`,
          role,
          text: primaryText,
          senderId: role === 'user' ? 'user' : 'assistant',
          senderName: role === 'user' ? '用户' : 'Mova',
          createdAt: msgAt,
        });
      }
      const reply = m.reply;
      const replyText = typeof reply === 'string' ? reply : reply?.text;
      if (
        typeof replyText === 'string'
        && replyText.trim()
        && !reply?.mock
        && !reply?.demo
        && !['mock', 'demo'].includes(reply?.source)
      ) {
        messages.push({
          id: `${m.id || messages.length}-assistant`,
          role: 'assistant',
          text: replyText.trim(),
          senderId: 'assistant',
          senderName: 'Mova',
          createdAt: msgAt,
        });
      }
    }
    if (!messages.length) continue;
    const title = (typeof data.title === 'string' && data.title.trim())
      || (Array.isArray(parts) && parts[2] ? String(parts[2]).trim() : '')
      || '主对话';
    out.push({
      id: convId,
      title,
      temporary: false,
      vault: false,
      deleted: false,
      updatedAt: Number(data.updatedAt) || messages.at(-1)?.createdAt || 0,
      messages,
    });
  }
  return out;
}

export function registerBotIpcHandlers({
  ipcMain,
  getMainWindow,
  senderWindow,
  userDataPath,
  pgPool = null,
  memoryRepository = null,
  Notification = null,
  cloudTaskCall = null,
  onOpenConversation = null,
  logger = console,
} = {}) {
  const filePath = userDataPath ? path.join(userDataPath, 'bots', 'state.json') : null;
  let botRuntime = null;
  let cachedMainChats = [];
  let lastMainChatRefreshAt = 0;
  let pendingCacheRefresh = null;

  async function refreshExternalChatCache({ force = false, timeoutMs = 1500 } = {}) {
    if (!memoryRepository || typeof memoryRepository.read !== 'function') return cachedMainChats;
    if (!force && Date.now() - lastMainChatRefreshAt < 15_000) return cachedMainChats;
    if (!pendingCacheRefresh) {
      pendingCacheRefresh = Promise.resolve()
        .then(() => memoryRepository.read())
        .then(snapshot => {
          cachedMainChats = mapMemorySnapshotToExternalChats(snapshot);
          lastMainChatRefreshAt = Date.now();
          return cachedMainChats;
        })
        .catch(() => cachedMainChats)
        .finally(() => {
          pendingCacheRefresh = null;
        });
    }
    if (timeoutMs > 0) {
      await Promise.race([
        pendingCacheRefresh,
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    } else {
      await pendingCacheRefresh;
    }
    return cachedMainChats;
  }

  function joinEndpoint(base, routePath) {
    const root = String(base || '').replace(/\/+$/, '');
    if (root.endsWith('/v1') && routePath.startsWith('/v1/')) return `${root}${routePath.slice(3)}`;
    return `${root}${routePath}`;
  }

  function isSubProvider(provider) {
    const kind = typeof provider?.kind === 'string' ? provider.kind.trim().toLowerCase() : '';
    const type = typeof provider?.type === 'string' ? provider.type.trim().toLowerCase() : '';
    const id = typeof provider?.id === 'string' ? provider.id.trim().toLowerCase() : '';
    return kind === 'subscription' || type === 'subscription' || id.startsWith('subscription:');
  }

  function isProviderReady(provider) {
    if (!provider || !Array.isArray(provider.models) || !provider.models.length) return false;
    return isSubProvider(provider) ? provider.configured === true : provider.hasKey === true;
  }

  function subProviderKind(provider) {
    const declared = [provider?.subscriptionProvider, provider?.subscription?.provider, provider?.provider]
      .filter(v => typeof v === 'string')
      .map(v => v.trim().toLowerCase());
    if (declared.includes('chatgpt')) return 'chatgpt';
    if (declared.includes('gemini')) return 'gemini';
    const id = String(provider?.id || '').toLowerCase();
    if (id.includes('chatgpt')) return 'chatgpt';
    if (id.includes('gemini')) return 'gemini';
    return '';
  }

  function pickReadyProviderAndModel(state, bot) {
    const all = Array.isArray(state?.providers) ? state.providers : [];
    const ready = all.filter(isProviderReady);
    if (!ready.length) return null;

    const reqProviderId = typeof bot?.capabilityConfig?.providerId === 'string' ? bot.capabilityConfig.providerId.trim() : '';
    const reqModelId = typeof (bot?.capabilityConfig?.model || bot?.model) === 'string'
      ? (bot.capabilityConfig?.model || bot.model).trim()
      : '';

    if (reqProviderId && reqModelId) {
      const p = ready.find(item => item.id === reqProviderId);
      const m = p?.models?.find(item => item.id === reqModelId);
      if (p && m) return { providerId: p.id, modelId: m.id };
    }
    if (reqModelId) {
      for (const p of ready) {
        const m = p.models.find(item => item.id === reqModelId);
        if (m) return { providerId: p.id, modelId: m.id };
      }
    }
    if (state?.active?.providerId && state?.active?.modelId) {
      const p = ready.find(item => item.id === state.active.providerId);
      const m = p?.models?.find(item => item.id === state.active.modelId);
      if (p && m) return { providerId: p.id, modelId: m.id };
    }
    const first = ready[0];
    return { providerId: first.id, modelId: first.models[0].id };
  }

  function toChatAgentMessages(messages, prependSystemPrompt = '') {
    const list = (Array.isArray(messages) ? messages : [])
      .map(m => ({
        role: m?.role === 'assistant' || m?.role === 'bot' ? 'assistant' : 'user',
        text: String(m?.content ?? m?.text ?? '').trim(),
      }))
      .filter(m => m.text);
    if (!list.length || list.at(-1)?.role !== 'user') {
      list.push({ role: 'user', text: '请根据当前上下文继续回复。' });
    }
    if (prependSystemPrompt) {
      const last = list[list.length - 1];
      last.text = `[系统设定与上下文]\n${prependSystemPrompt}\n\n[当前对话输入]\n${last.text}`;
    }
    return list;
  }

  async function resolveActiveProviderContext(bot) {
    const providers = require('../providers.cjs');
    if (typeof providers.listProviders !== 'function') return null;
    const state = await providers.listProviders();
    const picked = pickReadyProviderAndModel(state, bot);
    if (!picked) return null;

    const resolved = await providers.resolveModel(picked.providerId, picked.modelId);
    const provider = resolved?.provider;
    const modelEntry = resolved?.model;
    if (!provider || !modelEntry) return null;

    let vpnRuntime = null;
    try {
      const vpnMod = await import('../vpn/runtime.mjs');
      vpnRuntime = typeof vpnMod?.getVpnRuntime === 'function' ? vpnMod.getVpnRuntime() : null;
    } catch {
      vpnRuntime = null;
    }
    const vpnProxyUrl = vpnRuntime?.routeFor?.(provider.id, modelEntry.id ?? '')?.proxyUrl || '';
    const vpnFetch = vpnProxyUrl ? vpnRuntime.createModelFetch(vpnProxyUrl) : null;
    if (vpnProxyUrl && typeof vpnRuntime?.ensureHealthyForModel === 'function') {
      await vpnRuntime.ensureHealthyForModel(provider.id, modelEntry.id ?? '', { maxAgeMs: 60_000 });
    }

    if (isSubProvider(provider)) {
      return { provider, modelEntry, vpnRuntime, vpnFetch, apiKey: null, isSubscription: true };
    }
    const apiKey = await providers.loadProviderKey(provider.id);
    if (!apiKey) return null;
    return { provider, modelEntry, vpnRuntime, vpnFetch, apiKey, isSubscription: false };
  }

  async function callSubscriptionModel({ provider, modelEntry, vpnRuntime, vpnFetch, systemPrompt, messages, abortSignal }) {
    const subKind = subProviderKind(provider);
    const { runChatAgent } = await import('../chat-agent.mjs');
    const signal = abortSignal || new AbortController().signal;

    if (subKind === 'chatgpt') {
      const { getSubscriptionRuntime } = await import('../subscription/runtime.mjs');
      const sub = typeof getSubscriptionRuntime === 'function' ? getSubscriptionRuntime() : null;
      const turn = sub && typeof sub.acquireChatgptTurn === 'function' ? await sub.acquireChatgptTurn() : null;
      if (!turn || typeof turn.accessToken !== 'string' || !turn.accessToken) {
        throw new Error('chatgpt_subscription_unavailable');
      }
      let collected = '';
      let tokenUsage;
      await runChatAgent({
        key: turn.accessToken,
        provider,
        entry: modelEntry,
        request: {
          messages: toChatAgentMessages(messages),
          thinking: 'off',
          attachments: [],
          temporary: true,
          ...(vpnFetch ? { forceSseTransport: true } : {}),
        },
        ...(vpnFetch ? { fetchModel: vpnFetch } : {}),
        browserOnly: true,
        projectInstructions: String(systemPrompt || '').slice(0, 4000),
        signal,
        emit: evt => {
          if (evt?.type === 'text' && typeof evt.text === 'string') collected += evt.text;
          if (evt?.type === 'usage' && evt.run) {
            tokenUsage = { input: evt.run.input || 0, output: evt.run.output || 0 };
          }
        },
      });
      if (!collected.trim()) return null;
      return { text: collected.trim(), ...(tokenUsage ? { tokenUsage } : {}) };
    }

    if (subKind === 'gemini') {
      const { getSubscriptionRuntime } = await import('../subscription/runtime.mjs');
      const sub = typeof getSubscriptionRuntime === 'function' ? getSubscriptionRuntime() : null;
      const settings = (await (sub?.getSettings?.() ?? sub?.settings?.())) || {};
      const cliMod = await import('../subscription/cli.mjs').catch(() => null);
      const { access } = require('node:fs/promises');
      const { execFile } = require('node:child_process');
      const { homedir } = require('node:os');
      const located = typeof cliMod?.locateCli === 'function'
        ? await cliMod.locateCli({
          settings,
          platform: process.platform,
          env: process.env,
          home: homedir(),
          access: async target => {
            try { await access(target); return true; } catch { return false; }
          },
          exec: (command, args = [], options = {}) => new Promise(resolve => {
            try {
              execFile(command, args, { timeout: 4000, windowsHide: true, ...options },
                (error, stdout, stderr) => resolve({
                  ok: !error,
                  code: typeof error?.code === 'number' ? error.code : 0,
                  stdout: String(stdout ?? '').slice(0, 4000),
                  stderr: String(stderr ?? '').slice(0, 4000),
                }));
            } catch (error) {
              resolve({ ok: false, code: 0, stdout: '', stderr: String(error?.message || '') });
            }
          }),
        }).catch(() => null)
        : null;
      const acpCommand = (located?.found && located.command) || String(settings?.cliPath || '').trim();
      if (!acpCommand || located?.compatible === false) {
        throw new Error('gemini_cli_unavailable');
      }
      const acpArgs = Array.isArray(located?.args) && located.args.length ? located.args : ['acp'];
      let acpModelId = modelEntry.id;
      try {
        const { resolveVariantId } = await import('../subscription/cli-models.mjs');
        acpModelId = resolveVariantId(modelEntry, undefined) || modelEntry.id;
      } catch { /* fallback to modelEntry.id */ }
      const acpEnv = vpnRuntime?.envForModel?.(provider.id, modelEntry.id) ?? null;
      let collected = '';
      await runChatAgent({
        key: '',
        provider,
        entry: modelEntry,
        request: {
          engine: 'acp',
          acpCommand,
          acpArgs,
          acpModelId,
          ...(acpEnv ? { acpEnv } : {}),
          messages: toChatAgentMessages(messages, systemPrompt),
          attachments: [],
          temporary: true,
        },
        browserOnly: true,
        signal,
        emit: evt => {
          if (evt?.type === 'text' && typeof evt.text === 'string') collected += evt.text;
        },
      });
      if (!collected.trim()) return null;
      return { text: collected.trim() };
    }
    return null;
  }

  function buildToolsForBotTurn(bot, conversation) {
    const allTools = Array.isArray(botRuntime?.collabTools) ? botRuntime.collabTools : [];
    const allowedToolSet = new Set(bot?.capabilityConfig?.tools || []);
    return allTools.filter(tool => {
      if (tool.name === 'chat_history_search' || tool.name === 'chat_history_read') {
        const allowMem = bot?.memoryConfig?.enableGlobalChatSearch !== false
          || bot?.memoryConfig?.enableIndependentMemory !== false
          || bot?.memoryConfig?.enableGroupMemory !== false;
        return allowMem && (allowedToolSet.size === 0 || allowedToolSet.has('memory') || allowedToolSet.has('search'));
      }
      if (['bot_ask_peer_memory', 'bot_delegate_task', 'bot_propose_consensus'].includes(tool.name)) {
        return conversation?.type === 'group';
      }
      return true;
    });
  }

  function parseToolArguments(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  async function executeBotCollabTool(tool, rawArgs, { bot, conversation, collector }) {
    const args = parseToolArguments(rawArgs);
    if (tool.name === 'chat_history_search' || tool.name === 'chat_history_read') {
      await refreshExternalChatCache({ force: false, timeoutMs: 1200 });
      return tool.execute({ ...args, requesterBotId: bot.id });
    }
    if (tool.name === 'bot_ask_peer_memory') {
      return tool.execute({
        ...args,
        fromBotId: bot.id,
        currentConversationId: args.currentConversationId || conversation?.id || null,
      });
    }
    if (tool.name === 'bot_delegate_task') {
      const receiver = runtime.registry.getBot(args.toBotId || args.receiverBotId);
      if (!receiver || receiver.status !== 'active') throw new Error('目标 Bot 不存在或未启用');
      if (!conversation?.memberBotIds?.includes(receiver.id)) throw new Error('目标 Bot 不在当前群聊中');
      if (receiver.id === bot.id) throw new Error('不能委派给自己');
      collector.handoffTo = { receiverBotId: receiver.id, goal: String(args.goal || ''), silentIntermediate: true };
      return { queued: true, receiverBotId: receiver.id, note: '委派已排队，将在本轮回复后执行；尚未完成。' };
    }
    if (tool.name === 'bot_propose_consensus') {
      const res = await tool.execute({
        ...args,
        proposerBotId: bot.id,
        botId: bot.id,
        conversationId: conversation?.id || args.conversationId || null,
      });
      if (res?.message) collector.postedConsensus = true;
      return { ok: true, messageId: res?.message?.id || null };
    }
    if (tool.name === 'bot_incubate_mini_app') {
      const res = await tool.execute({
        ...args,
        botId: bot.id,
        conversationId: conversation?.id || null,
        postCardMessage: false,
      });
      if (res?.cardPayload) collector.structuredPayload = res.cardPayload;
      return {
        ok: true,
        appId: res?.app?.appId || null,
        name: res?.app?.name || args.name || '轻应用',
        version: res?.app?.version || '1.0.0',
        note: '小程序与直达卡片已生成，你可直接向用户说明如何使用。',
      };
    }
    if (tool.name === 'bot_query_mini_app_data') {
      return tool.execute({ ...args, requesterBotId: bot.id });
    }
    return tool.execute(args);
  }

  async function postHttpJson(url, headers, body, doFetch, abortSignal, tag) {
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger?.warn?.(`[bots] ${tag} HTTP`, res.status, detail.slice(0, 200));
      return { ok: false, status: res.status, detail };
    }
    return { ok: true, json: await res.json() };
  }

  async function runAnthropicToolLoop({ ctx, bot, conversation, systemPrompt, messages, temperature, tools, abortSignal, updateStatus }) {
    const doFetch = ctx.vpnFetch || fetch;
    const url = joinEndpoint(ctx.provider.baseUrl, '/v1/messages');
    const headers = {
      'content-type': 'application/json',
      'x-api-key': ctx.apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    };
    const convo = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    }));
    const anthroTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
    const collector = { structuredPayload: null, postedConsensus: false };
    let totalIn = 0;
    let totalOut = 0;
    let enableTools = anthroTools.length > 0;

    for (let round = 0; round < 4; round += 1) {
      const body = {
        model: ctx.modelEntry.id,
        max_tokens: Math.min(Number(ctx.modelEntry.maxTokens) || 4096, 4096),
        temperature,
        system: systemPrompt,
        messages: convo,
        ...(enableTools && anthroTools.length ? { tools: anthroTools } : {}),
      };
      let resp = await postHttpJson(url, headers, body, doFetch, abortSignal, 'liveModelRunner anthropic');
      if (!resp.ok && round === 0 && enableTools && (resp.status === 400 || resp.status === 422)) {
        enableTools = false;
        const { tools: _ignored, ...noToolBody } = body;
        resp = await postHttpJson(url, headers, noToolBody, doFetch, abortSignal, 'liveModelRunner anthropic-notools');
      }
      if (!resp.ok) return null;

      const json = resp.json;
      totalIn += Number(json?.usage?.input_tokens || 0);
      totalOut += Number(json?.usage?.output_tokens || 0);
      const blocks = Array.isArray(json?.content) ? json.content : [];
      const toolUses = blocks.filter(b => b?.type === 'tool_use');
      const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('').trim();

      if (!toolUses.length) {
        if (!text && collector.structuredPayload) {
          return {
            text: `已为你生成小程序「${collector.structuredPayload.name || '轻应用'}」，请点击下方卡片体验。`,
            structuredPayload: collector.structuredPayload,
            tokenUsage: totalIn || totalOut ? { input: totalIn, output: totalOut } : undefined,
          };
        }
        if (!text && collector.postedConsensus) return { text: 'NO_REPLY' };
        if (!text && collector.handoffTo) return { text: 'NO_REPLY', handoffTo: collector.handoffTo };
        if (!text) return null;
        return {
          text,
          ...(collector.handoffTo ? { handoffTo: collector.handoffTo } : {}),
          ...(collector.structuredPayload ? { structuredPayload: collector.structuredPayload } : {}),
          tokenUsage: totalIn || totalOut ? { input: totalIn, output: totalOut } : undefined,
        };
      }

      convo.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const tu of toolUses) {
        const matched = tools.find(t => t.name === tu.name);
        if (!matched) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: `unknown_tool:${tu.name}` }) });
          continue;
        }
        try {
          updateStatus?.(`正在执行工具 ${matched.name}…`);
          const out = await executeBotCollabTool(matched, tu.input, { bot, conversation, collector });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out ?? { ok: true }) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ error: String(err?.message || err) }) });
        }
      }
      convo.push({ role: 'user', content: results });
    }
    return collector.structuredPayload
      ? {
          text: `已为你完成「${collector.structuredPayload.name || '轻应用'}」组装，请查看下方卡片。`,
          structuredPayload: collector.structuredPayload,
          tokenUsage: totalIn || totalOut ? { input: totalIn, output: totalOut } : undefined,
        }
      : null;
  }

  async function runOpenAiToolLoop({ ctx, bot, conversation, systemPrompt, messages, temperature, tools, abortSignal, updateStatus }) {
    const doFetch = ctx.vpnFetch || fetch;
    const url = joinEndpoint(ctx.provider.baseUrl, '/chat/completions');
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.apiKey}`,
      accept: 'application/json',
    };
    const convo = [{ role: 'system', content: systemPrompt }, ...messages];
    const openaiTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
    const collector = { structuredPayload: null, postedConsensus: false };
    let totalIn = 0;
    let totalOut = 0;
    let enableTools = openaiTools.length > 0;

    for (let round = 0; round < 4; round += 1) {
      const body = {
        model: ctx.modelEntry.id,
        messages: convo,
        temperature,
        ...(enableTools && openaiTools.length ? { tools: openaiTools, tool_choice: 'auto' } : {}),
      };
      let resp = await postHttpJson(url, headers, body, doFetch, abortSignal, 'liveModelRunner openai');
      if (!resp.ok && round === 0 && enableTools && (resp.status === 400 || resp.status === 422)) {
        enableTools = false;
        const { tools: _t, tool_choice: _tc, ...noToolBody } = body;
        resp = await postHttpJson(url, headers, noToolBody, doFetch, abortSignal, 'liveModelRunner openai-notools');
      }
      if (!resp.ok) return null;

      const json = resp.json;
      totalIn += Number(json?.usage?.prompt_tokens || 0);
      totalOut += Number(json?.usage?.completion_tokens || 0);
      const choiceMsg = json?.choices?.[0]?.message || {};
      const toolCalls = Array.isArray(choiceMsg.tool_calls) ? choiceMsg.tool_calls : [];
      const rawContent = choiceMsg.content;
      const text = typeof rawContent === 'string'
        ? rawContent.trim()
        : Array.isArray(rawContent)
          ? rawContent.filter(b => b?.type === 'text').map(b => b.text).join('').trim()
          : '';

      if (!toolCalls.length) {
        if (!text && collector.structuredPayload) {
          return {
            text: `已为你生成小程序「${collector.structuredPayload.name || '轻应用'}」，请点击下方卡片体验。`,
            structuredPayload: collector.structuredPayload,
            tokenUsage: totalIn || totalOut ? { input: totalIn, output: totalOut } : undefined,
          };
        }
        if (!text && collector.postedConsensus) return { text: 'NO_REPLY' };
        if (!text && collector.handoffTo) return { text: 'NO_REPLY', handoffTo: collector.handoffTo };
        if (!text) return null;
        return {
          text,
          ...(collector.handoffTo ? { handoffTo: collector.handoffTo } : {}),
          ...(collector.structuredPayload ? { structuredPayload: collector.structuredPayload } : {}),
          tokenUsage: totalIn || totalOut ? { input: totalIn, output: totalOut } : undefined,
        };
      }

      convo.push({
        role: 'assistant',
        content: rawContent ?? null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const fnName = tc?.function?.name || '';
        const matched = tools.find(t => t.name === fnName);
        let resultPayload;
        if (!matched) {
          resultPayload = { error: `unknown_tool:${fnName}` };
        } else {
          try {
            updateStatus?.(`正在执行工具 ${matched.name}…`);
            resultPayload = await executeBotCollabTool(matched, tc?.function?.arguments, { bot, conversation, collector });
          } catch (err) {
            resultPayload = { error: String(err?.message || err) };
          }
        }
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(resultPayload ?? { ok: true }),
        });
      }
    }
    return collector.structuredPayload
      ? {
          text: `已为你完成「${collector.structuredPayload.name || '轻应用'}」组装，请查看下方卡片。`,
          structuredPayload: collector.structuredPayload,
          tokenUsage: totalIn || totalOut ? { input: totalIn, output: totalOut } : undefined,
        }
      : null;
  }

  // 若用户在 设置 → 模型 配置了有效提供商/密钥或订阅通道，按真实配置调用模型并挂载 Bot 协作工具（OpenAI / Anthropic / ChatGPT 订阅 / Gemini ACP 订阅）。
  async function liveModelRunner({ bot, conversation, systemPrompt, messages, abortSignal, updateStatus }) {
    try {
      const ctx = await resolveActiveProviderContext(bot);
      if (!ctx) return null;

      if (ctx.isSubscription) {
        const subPrompt = `${systemPrompt}\n\n[内置行动协议]\n当需要为用户打造交互式轻应用（小程序）时，可在回复末尾追加一行：<mova_bot_action>{"type":"incubate_mini_app","name":"应用名","summary":"一句话说明","fields":["字段1","字段2"],"layout":"dashboard"}</mova_bot_action>。`;
        return callSubscriptionModel({
          provider: ctx.provider,
          modelEntry: ctx.modelEntry,
          vpnRuntime: ctx.vpnRuntime,
          vpnFetch: ctx.vpnFetch,
          systemPrompt: subPrompt,
          messages,
          abortSignal,
        });
      }

      const temperature = bot.personaConfig?.tone === 'rigorous' ? 0.3 : 0.7;
      const tools = buildToolsForBotTurn(bot, conversation);
      if (ctx.provider.protocol === 'anthropic') {
        return runAnthropicToolLoop({ ctx, bot, conversation, systemPrompt, messages, temperature, tools, abortSignal, updateStatus });
      }
      return runOpenAiToolLoop({ ctx, bot, conversation, systemPrompt, messages, temperature, tools, abortSignal, updateStatus });
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      logger?.warn?.('[bots] liveModelRunner failed:', err?.message || err);
      return null;
    }
  }

  // 根据用户需求由当前真实 LLM 生成定制化单文件 HTML/CSS/JS 小程序源码（接入 window.mova SDK，无外链）。
  async function generateMiniAppCodeViaLlm({ bot, spec, routes }) {
    try {
      const ctx = await resolveActiveProviderContext(bot);
      if (!ctx) return null;
      const sysPrompt = '你是专注单文件 HTML5 轻应用开发的工程师。你必须只输出完整可运行的单文件 HTML 代码（从 <!doctype html> 到 </html>），不要附加任何 markdown 说明文字以外的内容。';
      const userPrompt = [
        `请为 Mova 小程序「${spec.name || 'Bot 轻应用'}」生成完整单文件 HTML 源码：`,
        `- 用途描述：${spec.description || spec.summary || '个人效率工具'}`,
        spec.goal ? `- 详细需求：${spec.goal}` : '',
        Array.isArray(spec.fields) && spec.fields.length ? `- 关键字段：${spec.fields.join('、')}` : '',
        spec.layout ? `- 偏好交互形态：${spec.layout}` : '',
        `- 建议标签页/路由：${(routes || []).map(r => `${r.title}(${r.id})`).join('、')}`,
        '技术要求：',
        '1. 纯单文件内联 <style> 与 <script>，严禁引用任何外部 CDN 脚本或样式；',
        '2. 暗色现代 UI，优先使用 CSS 变量 --mova-bg(#1b1b1b)、--mova-surface(#242424)、--mova-fg(#efefef)、--mova-border(#383838)、--mova-accent(#5b9bf0)；',
        "3. 状态持久化统一使用异步 API：`await window.mova.storage.get('records')` 与 `await window.mova.storage.set('records', list)`，初始化前先判空 `if (window.mova)`；",
        '4. 支持用户实际录入、筛选、切换标签与修改/删除条目，交互完整可用。',
      ]
        .filter(Boolean)
        .join('\n');

      const msgs = [{ role: 'user', content: userPrompt }];
      if (ctx.isSubscription) {
        const res = await callSubscriptionModel({
          provider: ctx.provider,
          modelEntry: ctx.modelEntry,
          vpnRuntime: ctx.vpnRuntime,
          vpnFetch: ctx.vpnFetch,
          systemPrompt: sysPrompt,
          messages: msgs,
        });
        return res?.text || null;
      }
      if (ctx.provider.protocol === 'anthropic') {
        const res = await runAnthropicToolLoop({
          ctx,
          bot,
          conversation: null,
          systemPrompt: sysPrompt,
          messages: msgs,
          temperature: 0.35,
          tools: [],
        });
        return res?.text || null;
      }
      const res = await runOpenAiToolLoop({
        ctx,
        bot,
        conversation: null,
        systemPrompt: sysPrompt,
        messages: msgs,
        temperature: 0.35,
        tools: [],
      });
      return res?.text || null;
    } catch (err) {
      logger?.warn?.('[bots] generateMiniAppCodeViaLlm failed:', err?.message || err);
      return null;
    }
  }

  const runtime = createBotRuntime({
    filePath,
    pgPool,
    initialSeed: true,
    externalChatProvider: () => {
      if (Date.now() - lastMainChatRefreshAt > 15_000) {
        void refreshExternalChatCache({ force: false, timeoutMs: 0 });
      }
      return cachedMainChats;
    },
    autoStartScheduler: true,
    logger,
    modelRunner: async ctx => {
      if (ctx.conversation?.place?.origin) {
        if (!cloudTaskCall) throw new Error('请先在 Mova 桌面版配对远程主机');
        const call = (action, input) => cloudTaskCall(ctx.conversation.place.origin, action, input);
        ctx.abortSignal?.throwIfAborted();
        const history = ctx.messages.map(message => `${message.role === 'assistant' ? 'Bot' : '群聊'}\n${message.content ?? message.text ?? ''}`).join('\n\n');
        const prompt = [ctx.systemPrompt.slice(0, 3200), history.slice(-8500)].join('\n\n');
        const task = await call('submit', { id: ctx.runId, prompt });
        const done = await waitForCloudTask(call, task, { signal: ctx.abortSignal,
          onStatus: state => ctx.updateStatus(state === 'queued' ? '已在云端排队' : '正在云端执行…') });
        return { text: done.result };
      }
      const live = await liveModelRunner(ctx);
      if (live) return live;
      // 返回 null，交由 runService 的 defaultOfflineSynthesis 统一处理离线兜底与指令解析
      return null;
    },
  });
  botRuntime = runtime;
  runtime.miniAppService.setCodeGenerator(generateMiniAppCodeViaLlm);
  void refreshExternalChatCache({ force: true, timeoutMs: 0 });

  function maybeShowDesktopNotification(payload) {
    if (!Notification || (typeof Notification.isSupported === 'function' && !Notification.isSupported())) return;
    const isProactive = payload?.type === 'task:proactive-sent';
    const isRecovered = payload?.type === 'scheduler:recovered' && Number(payload.count) > 0;
    if (!isProactive && !isRecovered) return;

    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const isForeground = Boolean(win && !win.isDestroyed?.() && win.isVisible?.() && win.isFocused?.());
    if (isForeground) return;

    try {
      const botName = isProactive
        ? (runtime.registry.getBot(payload.botId)?.name || 'MovaBot')
        : 'Mova 定时任务';
      const title = isProactive ? `${botName} 发来新消息` : `已补发 ${payload.count} 条定时提醒`;
      const rawBody = isProactive
        ? String(payload.content || '你有一条新的 Bot 消息')
        : String(payload.recovered?.[0]?.finalText || '点击查看已恢复的定时任务通知');
      const targetConvId = payload.conversationId || payload.recovered?.[0]?.conversationId || null;
      const notif = new Notification({
        title,
        body: rawBody.slice(0, 120),
        silent: false,
      });
      notif.on('click', () => {
        try { onOpenConversation?.(targetConvId); } catch { /* ignore */ }
      });
      notif.show();
    } catch (err) {
      logger?.warn?.('[bots] desktop notification failed:', err?.message || err);
    }
  }

  const unsubscribeEvent = runtime.onEvent(payload => {
    maybeShowDesktopNotification(payload);
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (win && !win.isDestroyed?.()) {
      try { win.webContents.send('bots:event', payload); } catch { /* ignore */ }
    }
  });

  const guardHandle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (typeof senderWindow === 'function') {
        try {
          const ok = await senderWindow(event);
          if (ok === false) return { ok: false, error: 'unauthorized' };
        } catch {
          return { ok: false, error: 'unauthorized' };
        }
      }
      try {
        const value = await fn(...args);
        return { ok: true, value };
      } catch (err) {
        return {
          ok: false,
          error: err?.code || 'bot-error',
          message: String(err?.message || err),
        };
      }
    });
  };

  // Bot 通讯录与生命周期
  guardHandle('bots:list', opts => runtime.registry.listBots(opts));
  guardHandle('bots:get', id => runtime.registry.getBot(id));
  guardHandle('bots:create', payload => runtime.registry.createBot(payload));
  guardHandle('bots:create-template', (templateId, overrides) => runtime.registry.createFromTemplate(templateId, overrides));
  guardHandle('bots:create-nl', (prompt, overrides) => runtime.registry.createFromNaturalLanguage(prompt, overrides));
  guardHandle('bots:update', (id, patch) => runtime.registry.updateBot(id, patch));
  guardHandle('bots:rename', (id, newName) => runtime.registry.renameBot(id, newName));
  guardHandle('bots:clone', (id, overrides) => runtime.registry.cloneBot(id, overrides));
  guardHandle('bots:set-status', (id, status) => runtime.registry.setBotStatus(id, status));
  guardHandle('bots:check-model-switch', (id, nextModelId) => runtime.registry.checkModelSwitchImpact(id, nextModelId));
  guardHandle('bots:deletion-impact', id => runtime.registry.getDeletionImpact(id));
  guardHandle('bots:delete', (id, opts) => runtime.registry.deleteBot(id, opts));
  guardHandle('bots:export', id => runtime.registry.exportBotConfig(id));
  guardHandle('bots:import', payload => runtime.registry.importBotConfig(payload));
  guardHandle('bots:mention-candidates', (query, opts) => runtime.registry.findCandidatesByName(query, opts));

  // Bot 对话与群聊
  guardHandle('bot-chats:list', opts => runtime.conversationService.listConversations(opts));
  guardHandle('bot-chats:get', id => runtime.conversationService.getConversation(id));
  guardHandle('bot-chats:create-private', opts => runtime.conversationService.createPrivateTopicConversation(opts));
  guardHandle('bot-chats:get-or-create-private', botId => runtime.conversationService.getOrCreatePrivateConversation(botId));
  guardHandle('bot-chats:create-group', opts => runtime.conversationService.createGroupConversation(opts));
  guardHandle('bot-chats:update-meta', (id, patch) => runtime.conversationService.updateConversationMeta(id, patch));
  guardHandle('bot-chats:set-mode', (id, mode) => runtime.conversationService.setGroupMode(id, mode));
  guardHandle('bot-chats:add-members', (id, botIds) => runtime.conversationService.addGroupMembers(id, botIds));
  guardHandle('bot-chats:remove-member', (id, botId) => runtime.conversationService.removeGroupMember(id, botId));
  guardHandle('bot-chats:set-member-role', (id, botId, role) => runtime.conversationService.setMemberRole(id, botId, role));
  guardHandle('bot-chats:mark-read', id => runtime.conversationService.markConversationRead(id));
  guardHandle('bot-chats:delete', id => runtime.conversationService.deleteConversation(id));
  guardHandle('bot-chats:send', payload => runtime.sendUserMessage(payload));
  guardHandle('bot-chats:cancel', id => runtime.runService.cancelConversationRuns(id));
  guardHandle('bot-chats:vote-consensus', payload => {
    const updated = runtime.conversationService.voteOrConfirmConsensusCard(payload);
    if (payload.confirmTask && updated.structuredPayload?.taskDraft) {
      const task = runtime.taskService.createTask({
        conversationId: payload.conversationId,
        ownerBotId: updated.senderId || 'mova',
        title: updated.structuredPayload.taskDraft.title,
        goal: updated.structuredPayload.taskDraft.goal,
        status: 'running',
      });
      updated.structuredPayload.taskId = task.id;
    }
    return updated;
  });

  // 记忆与两阶段历史检索
  guardHandle('bot-memory:search-history', async params => {
    await refreshExternalChatCache({ force: false, timeoutMs: 1200 });
    return runtime.memoryGateway.chatHistorySearch(params);
  });
  guardHandle('bot-memory:read-history', params => runtime.memoryGateway.chatHistoryRead(params));
  guardHandle('bot-memory:list', params => runtime.memoryGateway.listMemories(params));
  guardHandle('bot-memory:save-bot', params => runtime.memoryGateway.writeBotMemory(params));
  guardHandle('bot-memory:save-group', params => runtime.memoryGateway.writeGroupMemory(params));
  guardHandle('bot-memory:update', (id, opts) => runtime.memoryGateway.updateMemory(id, opts));
  guardHandle('bot-memory:delete', (id, opts) => runtime.memoryGateway.deleteMemory(id, opts));
  guardHandle('bot-memory:ask-peer', params =>
    runtime.memoryGateway.askPeerBotMemoryInSharedGroup({
      ...params,
      postBotMessage: async payload => runtime.conversationService.addBotMessage(payload).message,
    }),
  );

  // 任务、触发器、审批与运行时设置
  guardHandle('bot-tasks:list', params => runtime.taskService.listTasks(params));
  guardHandle('bot-tasks:create', params => runtime.taskService.createTask(params));
  guardHandle('bot-tasks:transition', (id, nextStatus, opts) => runtime.taskService.transitionTask(id, nextStatus, opts));
  guardHandle('bot-tasks:create-trigger', params => runtime.taskService.createTrigger(params));
  guardHandle('bot-tasks:approvals-list', params => runtime.policyGateway.listApprovals(params));
  guardHandle('bot-tasks:approvals-resolve', (id, opts) => runtime.policyGateway.resolveApprovalRequest(id, opts));
  guardHandle('bots:settings-get', () => runtime.getRuntimeSettings());
  guardHandle('bots:settings-update', patch => runtime.updateRuntimeSettings(patch));

  // 自研小程序
  guardHandle('mini-apps:list', params => runtime.miniAppService.listApps(params));
  guardHandle('mini-apps:get', appId => runtime.miniAppService.getApp(appId));
  guardHandle('mini-apps:incubate', params => runtime.miniAppService.incubateMiniAppWithCodegen(params));
  guardHandle('mini-apps:upgrade', params => runtime.miniAppService.upgradeMiniApp(params));
  guardHandle('mini-apps:open', (appId, opts) => {
    const app = runtime.miniAppService.markOpened(appId) || runtime.miniAppService.getApp(appId);
    if (!app) throw new Error(`小程序不存在: ${appId}`);
    return {
      app,
      sandboxedHtml: runtime.miniAppService.buildSandboxedAppHtml(app, opts),
    };
  });
  guardHandle('mini-apps:storage-get', (appId, key, ns) => runtime.miniAppService.getStorage(appId, key, ns));
  guardHandle('mini-apps:storage-set', (appId, key, val, ns) => runtime.miniAppService.setStorage(appId, key, val, ns));
  guardHandle('mini-apps:export', (appId, format) => runtime.miniAppService.exportAppData(appId, format));
  guardHandle('mini-apps:query-data', params => runtime.miniAppService.queryMiniAppDataForBot(params));
  guardHandle('mini-apps:pin', (appId, pinned) => runtime.miniAppService.togglePin(appId, pinned));
  guardHandle('mini-apps:rename', (appId, newName) => runtime.miniAppService.renameApp(appId, newName));
  guardHandle('mini-apps:disable', (appId, disabled) => runtime.miniAppService.setDisabled(appId, disabled));
  guardHandle('mini-apps:permissions', (appId, opts) => runtime.miniAppService.updatePermissions(appId, opts));
  guardHandle('mini-apps:uninstall', (appId, opts) => runtime.miniAppService.uninstallApp(appId, opts));
  guardHandle('mini-apps:report-error', (appId, err) => runtime.miniAppService.reportRuntimeError(appId, err));
  guardHandle('mini-apps:request-repair', appId => runtime.miniAppService.requestBotRepair(appId));
  guardHandle('mini-apps:rpc', (appId, req) => runtime.miniAppService.handleSdkRpc(appId, req));

  return {
    runtime,
    dispose() {
      unsubscribeEvent();
      runtime.dispose();
    },
  };
}
