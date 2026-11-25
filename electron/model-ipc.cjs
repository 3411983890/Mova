const path = require('node:path');
const { ipcMain, app } = require('electron');
const { ModelError } = require('./local-model.cjs');
const providers = require('./providers.cjs');
const credentials = require('./model-credentials.cjs');
const { searchWeb, SearchError } = require('./anysearch.cjs');
const { siteIcon } = require('./site-icons.cjs');
const { createAgentMemorySearch } = require('./services/agent-memory-search.cjs');
const { createEmbeddingService } = require('./services/embedding.cjs');
const searchConfigModule = require('./search-config.cjs');
const searchProviders = require('./search/providers.cjs');
const { createSearchService } = require('./search/index.cjs');
const { createCache } = require('./search/cache.cjs');
const { describeStatus } = require('./search/providers/errors.cjs');
const { createAuditLog, effectiveProjectCapabilities } = require('./permissions.cjs');
const { createTimingLog } = require('./browser/timing-log.cjs');
const { redactSensitive } = require('./services/memory-redaction.cjs');
// 静默 / 硬上限计时抽成纯逻辑模块：可注入假时钟单测，且「审批挂起期间不算空闲」只在这里一处实现。
const { createIdleGuard, holdIdleDuringApprovals, DEFAULT_IDLE_MS, DEFAULT_CEILING_MS } = require('./services/idle-guard.mjs');
// 审批之外的人工等待（浏览器人工接管等）：同一套 hold 语义，信号源在 services/human-wait.mjs。
const { holdIdleDuringHumanWait } = require('./services/human-wait.mjs');
// 截图/图片的落盘通道（技能层 design_screenshot 用它把像素存成 chat-images/<id>）：
// 这里拿模块级实例，`saveImage` 绑定的默认实例由 memory-runtime 在启动时注入配额与目录。
const chatImages = require('./chat-images.cjs');

// ── 技能层授权审计 ─────────────────────────────────────────────────────
// 负责：给两条聊天链路的技能装配提供**同一个** `audit` 实例（`approval-bridge.mjs` 的
//   `audit.record(entry)` 形状，`createAuditLog` 返回的函数正好也是这个签名）。
// 不负责：能力位授予的审计（那是 main.cjs 的 `permissionAudit` → permissions.cjs 自己记账）。
//
// 为什么是模块级单例：每回合新建一个实例会在 userData 里堆出一串审计文件，且「谁批准了这次写入」
// 会被摊到不同文件里，事后没法按时间线还原。惰性创建一次，之后整进程复用。
// 审计写不进盘（Electron 之外的测试环境没有 app）只降级为不落盘，绝不挡住工具调用。
let skillsAuditLog = null;
function resolveSkillsAudit() {
  if (skillsAuditLog) return skillsAuditLog;
  try {
    skillsAuditLog = createAuditLog(path.join(app.getPath('userData'), 'skills-audit.jsonl'));
  } catch {
    skillsAuditLog = null;
  }
  return skillsAuditLog;
}

// 进程级共享缓存：多轮对话里同一个查询不必重复外呼（TTL 15 分钟，最多 200 条）。
const searchCache = createCache({ ttlMs: 15 * 60_000, max: 200 });

// ── 正文选段的本地向量（Wave E）────────────────────────────────────────
// 只在「本地已缓存模型」时启用：allowRemoteModels=false 保证对话中绝不下载模型；
// 模型缺失/加载失败就永久走关键词选段，失败结果缓存到进程结束，不重试、不刷屏。
// MOVA_SEARCH_VECTOR=0 可整体关闭（默认「可用则启用」）。
const SEARCH_VECTOR_DISABLED = String(process.env.MOVA_SEARCH_VECTOR ?? '').trim() === '0';
let searchEmbedderPromise = null;
let searchVectorWarned = false;

/** 与 memory-runtime 共用同一个模型缓存目录：userData/models。 */
function searchModelsDir() {
  try {
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'models');
  } catch { /* Electron 之外的测试环境没有 app，交给 embedding 服务用默认目录 */ }
  return null;
}

/** 只提示一次；不打印堆栈，也不带任何 provider 正文。 */
function warnSearchVector(error) {
  if (searchVectorWarned) return;
  searchVectorWarned = true;
  try {
    console.warn(`[search] 本地向量模型不可用，正文选段改用关键词版：${String(error?.message || error).slice(0, 200)}`);
  } catch { /* 无 stdout 时忽略 */ }
}

function searchEmbedder() {
  if (!searchEmbedderPromise) {
    const cacheDir = searchModelsDir();
    searchEmbedderPromise = (async () => {
      const service = createEmbeddingService({
        ...(cacheDir ? { cacheDir } : {}),
        allowRemoteModels: false,
      });
      // 预热只读本地缓存：模型不在本地时立刻失败，绝不在对话里下载。
      const status = await service.warmup();
      if (!service.ready) {
        throw new Error(status?.lastError?.message || '本地向量模型不可用');
      }
      return async (texts, options) => {
        try {
          return await service.embed(texts, options);
        } catch (error) {
          // 运行期故障也永久降级：后续段落不再反复重试同一个坏模型。
          searchEmbedderPromise = Promise.reject(error);
          searchEmbedderPromise.catch(() => {});
          throw error;
        }
      };
    })().catch(error => {
      warnSearchVector(error);
      throw error;
    });
    // 失败也要被缓存：后续调用立刻拿到同一个 rejection，避免反复慢重试。
    searchEmbedderPromise.catch(() => {});
  }
  return searchEmbedderPromise;
}

/** 传给 createSearchService 的 embed；关闭时返回 null，行为与 Wave A-D 完全一致。 */
function searchVectorEmbed() {
  if (SEARCH_VECTOR_DISABLED) return null;
  return (texts, options) => searchEmbedder().then(embed => embed(texts, options));
}

// 每个搜索源各存一个加密文件；缺 key 时返回 undefined，让 createProviders 跳过该源。
const searchKeyring = {
  async key(providerId) {
    try { return await credentials.searchCredentialStore(providerId).loadKey(); }
    catch { return undefined; }
  },
};

/** 按深度映射检索力度（契约 §5）。 */
const SEARCH_DEPTH_OPTIONS = {
  fast: { readCount: 0, maxResults: 5, maxQueries: 1 },
  standard: { readCount: 3, maxResults: 10, maxQueries: 3 },
  deep: { readCount: 6, maxResults: 10, maxQueries: 5 },
};
const SEARCH_TEST_QUERY = '香港旅遊發展局 Hong Kong Tourism Board';

function pickOneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function searchOptionsFor(request, config) {
  const depth = pickOneOf(request?.searchDepth, Object.keys(SEARCH_DEPTH_OPTIONS), config.depth);
  const zone = pickOneOf(request?.searchZone, searchConfigModule.ZONES, config.zone);
  const language = pickOneOf(request?.searchLanguage, searchConfigModule.LANGUAGES, config.language);
  const recency = pickOneOf(request?.searchRecency, ['any', 'month', 'year'], 'any');
  return {
    ...SEARCH_DEPTH_OPTIONS[depth],
    depth,
    recency,
    ...(zone && zone !== 'auto' ? { zone } : {}),
    ...(language && language !== 'auto' ? { lang: language } : {}),
    // 预算默认值由配置覆盖（契约 §4）。
    limits: { ...config.limits },
  };
}

function searchProviderId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!searchConfigModule.PROVIDER_IDS.includes(id)) throw new ModelError('未知的搜索源');
  return id;
}

function searchProviderLabel(id) {
  return searchConfigModule.PROVIDERS.find(item => item.id === id)?.label || id;
}

// ── 中断重试的动作记录（P0-5）────────────────────────────────────────────
// 负责：把一轮里收到的工具事件折叠成可复述的动作记录（做了什么、对什么、结果、证据）。
// 不负责：渲染恢复提示（见 chat-agent.mjs 的 renderResumeChecklist）、落盘、脱敏规则本身。
// 被谁调用：model:complete 的 emit 逐条累积 → 重试前 buildActionRecord 折叠 → runChatAgent 的 resume。
//
// 为什么只需要改这一层：工具执行层发的事件里本来就有 id / label / detail
//（agent-tools.cjs:501、browser/tools.cjs:45、desktop/tools.cjs:86 都在发），
// 旧实现只留了 name + status，于是同一工具调两次会被合成一条，结果与证据全部丢失。
// 这里按 actionId 折叠：同一 id 的后续事件只更新原记录，running → done 不会变成两条。
const ACTION_LIMIT = 20;
// 与旧的 slice(-4000) 同量级：恢复提示是提示词的一部分，不能挤掉对话正文。
const ACTION_BUDGET = 4000;
// 累积侧的防呆上限：工具事件远多于动作记录（一次调用至少两条），攒太多只是白占内存。
const ACTION_EVENT_LIMIT = 200;
const ACTION_TARGET_LIMIT = 120;
const ACTION_EVIDENCE_LIMIT = 200;
// 只认这四种状态：done 才算真的完成；error / denied 都是失败；
// running（中止时还在跑的）一律算未确定——恢复时先观察再决定，既不能当成功也不能当失败。
const ACTION_RESULT = { done: 'done', error: 'failed', denied: 'failed', running: 'unknown' };

/**
 * 动作摘要：折叠空白并按长度截断。
 * 事件里的 detail 可能带着命令输出或页面片段，只留前若干字符即等价于「不保存页面全文」。
 */
function actionSummary(value, limit) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  // 脱敏复用记忆模块：密码 / 验证码 / 令牌 / 卡号 / 身份证都在那里统一处理，不在这里另写正则。
  const text = redactSensitive(raw).text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 越靠后越接近中断点，恢复时最有用：先按条数截，再按字符预算从最旧的开始丢。 */
function trimActionRecords(records) {
  const kept = records.slice(-ACTION_LIMIT);
  const cost = item => item.actionId.length + item.tool.length + item.target.length
    + (item.evidence ? item.evidence.length : 0);
  let total = kept.reduce((sum, item) => sum + cost(item), 0);
  while (kept.length > 1 && total > ACTION_BUDGET) total -= cost(kept.shift());
  return kept;
}

/**
 * 把工具事件流折叠成 ActionRecord 列表（纯函数；只给测试与 model:complete 用）。
 * 同一 actionId 的后续事件更新同一条记录：target/evidence 取最新一次非空值，
 * result 取最新一次状态——这样 running 先出现、done 后到达时仍是一条。
 * @param {Array<{type?:string,id?:string,name?:string,label?:string,status?:string,detail?:string}>} events
 * @returns {{actionId:string,tool:string,target:string,result:string,evidence?:string}[]}
 */
function buildActionRecord(events) {
  const records = [];
  const byId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    // 事件流里还混着 text / delta 之类，这里只认工具事件。
    if (event.type && event.type !== 'tool') continue;
    const tool = actionSummary(event.name, 80);
    if (!tool) continue;
    const actionId = event.id === undefined || event.id === null ? '' : String(event.id).slice(0, 120);
    let record = actionId ? byId.get(actionId) : null;
    if (!record && !actionId) {
      // 少数发射方不带 id：按「同名且还没有结论」认下上一条，避免 running / done 变成两条。
      const last = records[records.length - 1];
      if (last && last.tool === tool && last.result === 'unknown') record = last;
    }
    if (!record) {
      record = { actionId: actionId || `${tool}#${records.length + 1}`, tool, target: '', result: 'unknown' };
      records.push(record);
      if (actionId) byId.set(actionId, record);
    }
    const target = actionSummary(event.label, ACTION_TARGET_LIMIT);
    if (target) record.target = target;
    const evidence = actionSummary(event.detail, ACTION_EVIDENCE_LIMIT);
    if (evidence) record.evidence = evidence;
    if (typeof event.status === 'string' && event.status) {
      record.result = ACTION_RESULT[event.status] ?? 'unknown';
    }
  }
  return trimActionRecords(records);
}

function installModelIpc(authorize, memoryRepository, options = {}) {
  const permissions = options.permissions ?? null;
  const approvals = options.approvals ?? null;
  // 人工等待登记表（浏览器接管等）：由 main.cjs 注入，与 browser controller 共用同一个实例。
  const humanWait = options.humanWait ?? null;
  const historyDir = options.historyDir ?? null;
  const mcpManager = options.mcpManager ?? null;
  const cloudProjects = options.cloudProjects ?? null;
  const designRuntime = options.designRuntime ?? null;
  const browser = options.browser ?? null;
  const desktop = options.desktop ?? null;
  const browserSettings = options.browserSettings ?? null;
  const asks = options.asks ?? null;
  const resolveHistoryDir = () => (typeof historyDir === 'function' ? historyDir() : historyDir);
  // 端到端计时日志：userData/browser/timing/timing-YYYY-MM-DD.jsonl。
  // 拿不到 userData（纯 Node 测试）时就静默不落盘，绝不影响对话。
  const timingLog = (() => {
    try {
      if (!app || typeof app.getPath !== 'function') return null;
      return createTimingLog({ directory: path.join(app.getPath('userData'), 'browser', 'timing') });
    } catch { return null; }
  })();
  const runs = new Map();
  const runKey = (sender, id) => `${sender.id}:${id}`;
  const clampMs = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
  };
  const REASON_LABEL = {
    timeout: '响应超时', network: '网络中断', upstream: '上游服务异常',
    empty: '空回复', protocol: '响应格式异常', interrupted: '连接中断',
  };

  function handler(channel, operation) {
    if (['providers:list', 'providers:active', 'model:complete', 'model:cancel'].includes(channel) && options.edgeHandlers) {
      options.edgeHandlers[channel] = operation;
    }
    ipcMain.handle(channel, async (event, ...args) => {
      const win = authorize(event);
      try {
        const input = channel === 'model:complete' ? args.slice(0, 2) : args;
        return { ok: true, value: await operation(event.sender, ...input, win) };
      } catch (error) {
        return { ok: false, error: error instanceof ModelError ? error.code : 'network', message: error?.message || '' };
      }
    });
  }

  handler('providers:list', () => providers.listProviders());
  handler('providers:save', (_sender, input) => providers.saveProvider(input));
  handler('providers:remove', (_sender, id) => providers.removeProvider(id));
  handler('providers:fetch', (_sender, input) => providers.fetchModels(input));
  handler('providers:defaults', (_sender, id) => providers.defaultModels(id));
  handler('providers:active', (_sender, active) => providers.setActive(active));
  // 订阅 provider 单独两条：它们不能走 save/remove（内置 id 会被拒绝），只能编辑模型目录。
  handler('providers:subscription-save', (_sender, input) => providers.saveSubscription(input));
  handler('providers:subscription-fetch', (_sender, input) => providers.fetchSubscriptionModels(input));

  handler('model:search-save', (_sender, key) => credentials.searchCredentials.storeKey(key));
  handler('model:search-test', async (_sender, key) => {
    try {
      return (await searchWeb(key ? credentials.validateKey(key) : await credentials.searchCredentials.loadKey(),
        '香港旅遊發展局 Hong Kong Tourism Board', AbortSignal.timeout(15_000))).length;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError(error instanceof SearchError ? error.message : '无法连接 AnySearch');
    }
  });

  handler('site:icon', (_sender, host) => siteIcon(host));

  // ── 搜索设置（契约 §5）────────────────────────────────────────────
  const hasSearchKey = async id => {
    try { return await credentials.searchCredentialStore(id).hasKey(); }
    catch { return false; }
  };
  const searchSnapshot = async () => {
    const config = await searchConfigModule.searchConfig.read();
    const flags = {};
    for (const meta of searchConfigModule.PROVIDERS) flags[meta.id] = await hasSearchKey(meta.id);
    return searchConfigModule.configSnapshot(config, flags);
  };

  handler('search:config-get', () => searchSnapshot());

  handler('search:config-save', async (_sender, patch) => {
    await searchConfigModule.searchConfig.save(patch);
    return searchSnapshot();
  });

  handler('search:provider-save', async (_sender, input) => {
    const id = searchProviderId(input?.providerId);
    const key = typeof input?.key === 'string' ? input.key.trim() : '';
    const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
    if (!key && !baseUrl) throw new ModelError('请填写密钥或服务地址');
    if (key) {
      try { await credentials.searchCredentialStore(id).storeKey(key); }
      catch { throw new ModelError('密钥保存失败，请检查格式后重试'); }
    }
    // 地址合法性由 search-config 校验；不合法直接报错，避免「看起来保存了」。
    if (baseUrl) await searchConfigModule.searchConfig.save({ providers: { [id]: { baseUrl } } });
    return searchSnapshot();
  });

  handler('search:provider-test', async (_sender, input) => {
    const id = searchProviderId(input?.providerId);
    const query = typeof input?.query === 'string' && input.query.trim()
      ? input.query.trim().slice(0, 200) : SEARCH_TEST_QUERY;
    const config = await searchConfigModule.searchConfig.read();
    // 只测这一个源：其它源即使启用也不参与，测试不是一次真实的多源检索。
    const only = {};
    for (const meta of searchConfigModule.PROVIDERS) {
      only[meta.id] = { ...config.providers[meta.id], enabled: meta.id === id };
    }
    const built = await searchProviders.createProviders({
      credentials: searchKeyring,
      config: { providers: only, order: [id] },
    }).catch(() => []);
    const target = built.find(item => item.id === id);
    if (!target) {
      throw new ModelError(id === 'searxng'
        ? '还没有填写 SearXNG 服务地址'
        : `还没有保存 ${searchProviderLabel(id)} 密钥`);
    }
    let rows;
    try {
      rows = await target.search(query, { maxResults: 5 }, AbortSignal.timeout(20_000));
    } catch (error) {
      // provider 只抛 SearchProviderError（只有状态码，没有响应体），这里转成中文原因。
      if (error?.name === 'SearchProviderError') throw new ModelError(describeStatus(error.provider, error.status));
      throw new ModelError('无法连接搜索服务，请检查网络或服务地址');
    }
    const list = Array.isArray(rows) ? rows : [];
    return {
      count: list.length,
      sample: list.slice(0, 3).map(row => ({
        title: String(row?.title || '').slice(0, 200),
        url: String(row?.url || ''),
      })),
    };
  });

  handler('model:complete', async (sender, id, request, win, edgeBrowser, edgeSignal, edgeApprovals) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new ModelError('request');
    const key = runKey(sender, id);
    if (runs.has(key) || runs.size >= 4) throw new ModelError('busy');
    const { provider, model } = await providers.resolveModel(request?.provider, request?.model);
    // 订阅 provider 没有 API Key：凭据在本机 CLI 自己的登录态里（见开发文档 §5.1）。
    // 先判身份再取 key，否则 loadProviderKey 会在进入 ACP 支路之前就抛 not_configured。
    const subscriptionAcp = isSubscriptionGeminiProvider(provider);
    // ChatGPT 订阅也没有 API Key：令牌由订阅服务按账号现取（可能每轮换号），
    // 所以这里不读 providers 的密钥，也不让它抛 not_configured。
    const subscriptionChatgpt = isSubscriptionChatgptProvider(provider);
    const apiKey = subscriptionAcp || subscriptionChatgpt ? '' : await providers.loadProviderKey(provider.id);
    const searchKey = request.search === true && await credentials.searchCredentials.hasKey()
      ? await credentials.searchCredentials.loadKey() : undefined;
    // 搜索开关打开时按配置与凭据建检索服务；没有任何可用源就不注入 service，
    // chat-agent 会退回旧版单查询工具（searchKey 存在时）或直接不提供搜索。
    let searchService = null;
    let searchOptions = null;
    if (request?.search === true) {
      const config = await searchConfigModule.searchConfig.read();
      const active = await searchProviders.createProviders({ credentials: searchKeyring, config })
        .catch(() => []);
      if (active.length) {
        searchService = createSearchService({
          providers: active,
          cache: searchCache,
          limits: config.limits,
          // 本地模型已缓存时才真正用向量选段；不可用/被关掉时保持关键词版。
          embed: searchVectorEmbed(),
        });
        searchOptions = searchOptionsFor(request, config);
      }
    }
    // Project roots come from the renderer as opaque ids only; the main process
    // maps them to paths it registered itself, so a request can never widen scope.
    const approvalPreset = ['default', 'auto', 'full'].includes(request?.permissionPreset)
      ? request.permissionPreset : 'default';
    const runApprovals = edgeApprovals ?? (approvalPreset === 'full' ? {
      ask: async (_sender, _request, signal) => signal?.aborted ? 'deny' : 'once',
    } : approvals);
    const requestedRoots = !edgeBrowser && Array.isArray(request?.projectRootIds)
      ? [...new Set(request.projectRootIds.filter(item => typeof item === 'string'))].slice(0, 32) : [];
    let projectRoots = [];
    if (permissions && requestedRoots.length) {
      const { roots } = await permissions.list();
      projectRoots = roots.filter(root => requestedRoots.includes(root.id)).map(root => ({
        ...root, capabilities: effectiveProjectCapabilities(root.capabilities, approvalPreset),
      })).filter(root => root.capabilities.read || root.capabilities.write || root.capabilities.exec);
    }
    const conversationId = typeof request?.conversationId === 'string' ? request.conversationId.slice(0, 800) : id;
    // 订阅 Gemini 走 ACP：CLI 路径 / 子命令 / 工作目录必须在这里解析完。
    // 刻意放在 runs.set 之前——这段时间抛出的错误还没被 finally 接管，先登记会留下永不清理的运行条目。
    const agentRequest = subscriptionAcp ? await buildAcpRequest(request, projectRoots, model) : request;
    // 按模型 VPN 线路（可选能力）：这三个值在「没装 VPN / 没给这个模型分配线路」时
    // 全是 null / 原引用，runChatAgent 收到的入参与改动前逐字相同。
    const vpnRuntime = await readVpnRuntime();
    const vpnProxyUrl = vpnRuntime?.routeFor?.(provider.id, model?.id ?? '')?.proxyUrl || '';
    const vpnFetch = vpnProxyUrl ? vpnRuntime.createModelFetch(vpnProxyUrl) : null;
    // 「用之前先测一次」：只在真的分配了线路时才做。
    // `ensureHealthyForModel` 内部已经吞掉所有异常、只返回结论（它自己 warn + 推 vpn:event），
    // 所以这里不需要 try/catch，而且**绝不阻断**这次请求 —— 网络抖一下就发不出消息比走慢线路糟得多。
    if (vpnProxyUrl && typeof vpnRuntime.ensureHealthyForModel === 'function') {
      await vpnRuntime.ensureHealthyForModel(provider.id, model?.id ?? '', { maxAgeMs: 60_000 });
    }
    // ChatGPT 订阅默认走 pi-ai 的 transport:'auto'，会优先用原生 WebSocket —— 那条路
    // 完全忽略 fetch/ProxyAgent，流量会绕过我们分配的线路。有代理时必须钉死 SSE。
    const vpnAgentRequest = vpnFetch && subscriptionChatgpt
      ? { ...agentRequest, forceSseTransport: true }
      : agentRequest;
    // ChatGPT 订阅：把「选号 + 取令牌」的能力准备在这一轮开始前。
    // 注册表里没有这个服务 = 订阅功能没装上，直接给可读原因，不要空 key 打上游。
    const subscriptionService = subscriptionChatgpt ? await readSubscriptionService() : null;
    if (subscriptionChatgpt && typeof subscriptionService?.acquireChatgptTurn !== 'function') {
      throw missingChatgptAccountError();
    }
    const controller = new AbortController();
    runs.set(key, controller);
    const { runChatAgent } = await import('./chat-agent.mjs');
    // Merely check the switch here; retrieval happens only when the model
    // deliberately calls the tool. Temporary sessions never access memory.
    const memoryEnabled = Boolean(memoryRepository && request?.memoryScope && !request.temporary
      && (await memoryRepository.settings())?.memoryEnabled === true);
    const memorySearch = createAgentMemorySearch(memoryRepository, request, memoryEnabled);
    const RETRYABLE = new Set(['timeout', 'network', 'upstream', 'empty', 'protocol', 'interrupted']);
    let lastReason = 'unknown';
    // 超时口径：只惩罚「真的没有进展」，不惩罚「回答很长」。
    // IDLE 是上游连续静默多久算卡死；CEILING 是单次尝试的硬上限。
    // 以前是整轮 180 秒墙钟，长输出 + 多轮工具必然撞线，那才是「输出多了就超时」的原因。
    // 默认 4 分钟静默才算卡死：单次工具（等页面、跑命令）也可能安静几十秒到几分钟。
    // 默认值与上下限都从 services/idle-guard.mjs 取，与抽出前逐字一致（240_000 / 30 分钟）。
    const IDLE_MS = clampMs(request?.idleTimeoutMs, DEFAULT_IDLE_MS, 30_000, 30 * 60_000);
    const CEILING_MS = clampMs(request?.runCeilingMs, DEFAULT_CEILING_MS, 60_000, 3 * 60 * 60_000);
    // 中断过的上一轮做了什么：重试时交给模型，避免它从头再来或重复已完成的副作用操作。
    let checkpoint = null;
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        // 每次尝试都重新选号：上一个号被标成限流/过期后，pool.pick 自然会给下一个。
        // 取不到令牌就是「没有可用账号」，直接抛可读错误，绝不空 key 打 chatgpt.com。
        const chatgptTurn = subscriptionChatgpt
          ? await Promise.resolve(subscriptionService.acquireChatgptTurn()).catch(() => null)
          : null;
        if (subscriptionChatgpt && (!chatgptTurn || typeof chatgptTurn.accessToken !== 'string' || !chatgptTurn.accessToken)) {
          throw missingChatgptAccountError();
        }
        // 订阅通道遇到限流/认证失效要换号重试，而这两个原因对普通 provider 是终局。
        const retryable = subscriptionChatgpt
          ? new Set([...RETRYABLE, 'rate_limit', 'auth', 'quota_exhausted'])
          : RETRYABLE;
        const timeout = new AbortController();
        let timedOut = false;
        // 静默 / 硬上限计时：逻辑在 services/idle-guard.mjs（纯模块，可被假时钟单测）。
        // 与抽出前完全等价：每次 emit 重新起算静默，硬上限只起一次且不被 emit 顺延，
        // 到期一律 timedOut = true + abort（错误码仍是 ModelError('timeout')）。
        const idle = createIdleGuard({
          idleMs: IDLE_MS,
          ceilingMs: CEILING_MS,
          onExpire: () => { timedOut = true; timeout.abort(); },
        });
        // 审批条挂起期间不算空闲：用户在审批条上慢慢看/慢慢点，不该被「4 分钟没有 emit」判定卡死。
        // 只订阅真实 broker（本轮的 runApprovals 可能是 full 模式的自动放行壳，没有挂起可言）。
        const releaseApprovalHold = holdIdleDuringApprovals({ approvals, guard: idle, senderId: sender.id });
        // 人工等待（browser handoff 最长 10 分钟）同样不算空闲：期间既不调 approvals.ask，
        // 也一行 emit 都没有，只靠上面的审批订阅照样会被 240s 误杀。
        // hold 是计数式的：审批 1 条 + 人工等待 1 个同时挂起时，结束其中一个仍保持暂停。
        const releaseHumanWaitHold = holdIdleDuringHumanWait({ humanWait, guard: idle, senderId: sender.id });
        const signal = AbortSignal.any([controller.signal, timeout.signal, ...(edgeSignal ? [edgeSignal] : [])]);
        let attemptText = '';
        // 只累积原始工具事件，不在这里折叠：折叠要看到同一 id 的全部事件
        //（running → done → 事后补 detail），统一交给 buildActionRecord 一次算清。
        const toolEvents = [];
        try {
          await runChatAgent({
            key: chatgptTurn ? chatgptTurn.accessToken : apiKey, searchKey, provider, entry: model, request: vpnAgentRequest, signal,
            // 只有真的分配了线路才注入 fetchModel：不注入时 chat-agent 用的是全局 fetch，
            // 与改动前完全一致（不挂 dispatcher、不受任何代理环境影响）。
            ...(vpnFetch ? { fetchModel: vpnFetch } : {}),
            searchService, searchOptions,
            memorySearch,
            // 技能层写长期记忆的唯一通道（mova_memory_write）：repository 代理自带 saveMemory。
            memoryRuntime: memoryRepository,
            // 技能层授权审计：同一实例（模块级单例）贯穿全进程，两条链路都拿到它。
            audit: resolveSkillsAudit(),
            permissions, projectRoots, sessionKey: `${sender.id}:${JSON.stringify([conversationId, approvalPreset, requestedRoots])}`, win,
            mcpManager: edgeBrowser ? null : mcpManager,
            cloudProjects: edgeBrowser ? null : cloudProjects,
            designRuntime: edgeBrowser ? null : designRuntime,
            // 截图落盘：技能层 design_screenshot 只有拿到它才能把图片内联到对话里；缺了会降级成纯文本。
            chatImages,
            browser: edgeBrowser || browser,
            browserSettings,
            desktop: edgeBrowser ? null : desktop,
            browserOnly: Boolean(edgeBrowser),
            asks: asks ? { ask: (target, input, askSignal) => asks.ask(target, { ...input, conversationId }, askSignal) } : null, sender,
            approvals: runApprovals ? { ask: (target, input, approvalSignal) => runApprovals.ask(target, { ...input, conversationId }, approvalSignal) } : null, approvalPreset,
            historyDir: projectRoots.length ? resolveHistoryDir() : null,
            // Project rules only make sense with the project's own files in scope.
            projectInstructions: typeof request?.projectInstructions === 'string' ? request.projectInstructions : '',
            emit: event => {
              // 只用于重试时的「已完成步骤」说明：记动作摘要与关键结果，不保存正文、不保存参数原值。
              if (event?.type === 'tool' && event.name) {
                toolEvents.push({
                  id: event.id, name: event.name, label: event.label,
                  status: event.status, detail: event.detail,
                });
                if (toolEvents.length > ACTION_EVENT_LIMIT) toolEvents.shift();
              }
              if (event?.type === 'text' && typeof event.text === 'string') {
                attemptText = (attemptText + event.text).slice(-4000);
              }
              // 每收到一点数据就重置静默计时：长回答只要还在流式输出就不算超时。
              idle.touch();
              if (!sender.isDestroyed()) sender.send('model:delta', id, event);
            },
            resume: checkpoint,
            onTiming: summary => {
              // 端到端计时只落盘，不进入对话事件流：避免历史记录被计时数据撑大。
              try { timingLog?.write({ ...summary, conversationId, permissionPreset: approvalPreset, edge: Boolean(edgeBrowser) }); }
              catch { /* 计时永远不影响对话 */ }
            },
          });
          return;
        } catch (error) {
          if (controller.signal.aborted) throw new ModelError('cancelled');
          const reason = timedOut ? 'timeout' : (error?.code || 'network');
          lastReason = reason;
          checkpoint = {
            reason,
            text: attemptText.slice(-4000),
            actions: buildActionRecord(toolEvents),
          };
          // 把这一轮的结果回写给订阅服务：限流的号进入冷却，认证失效的号标过期，
          // 下一轮 pool.pick 才会跳过它。失败不阻断重试，账目不准也比把对话搞挂好。
          if (subscriptionChatgpt && chatgptTurn) {
            const outcome = reason === 'rate_limit' || reason === 'quota_exhausted'
              ? { limited: true, resetsAt: 0 }
              : reason === 'auth' ? { expired: true } : null;
            if (outcome) {
              await Promise.resolve(subscriptionService.reportChatgptTurn?.(chatgptTurn.accountId, outcome)).catch(() => {});
            }
          }
          if (edgeBrowser || !retryable.has(reason) || attempt === 5) {
            const exhausted = new ModelError(reason);
            const label = REASON_LABEL[reason] || reason;
            exhausted.message = attempt === 5
              ? `模型连续 5 次失败（最后原因：${label}），已停止。已完成的进度会保留，点「重试」或直接说「继续」都能接着做。`
              : `模型运行中断（${label}），已停止。已完成的进度会保留，点「重试」或直接说「继续」都能接着做。`;
            throw exhausted;
          }
          // 已执行过的工具也照样重试：checkpoint 会把上一轮做过的步骤交给模型，
          // 让它接着做而不是重做（旧实现只要动过工具就直接放弃重试）。
          if (!sender.isDestroyed()) sender.send('model:delta', id, { type: 'retry', attempt, max: 5, reason });
          await new Promise(resolve => setTimeout(resolve, 800 * attempt));
        } finally {
          // 先退订两条 hold 来源，再清计时器：顺序反了会让迟到的 close/end 事件重新 arm 一个计时器。
          releaseApprovalHold();
          releaseHumanWaitHold();
          idle.dispose();
        }
      }
    } finally {
      runs.delete(key);
      // 一轮对话结束就必须收尾桌面操作，否则浮层留在屏幕上、鼠标钩子还在拦真实点击
      //（用户实测：点终止后浮层不消失、也停不下操作）。
      try {
        const state = desktop?.status?.()?.session?.state;
        if (controller.signal.aborted || state === 'running' || state === 'paused') {
          void desktop?.stop?.(controller.signal.aborted ? 'user-cancel' : 'turn-end');
        }
      } catch { /* 引擎可能没启动 */ }
    }
  });
  handler('model:cancel', (sender, id) => {
    if (typeof id === 'string') runs.get(runKey(sender, id))?.abort();
    // Close the approval bar right away: a cancelled run must not be committed
    // by a late click that is still waiting for an answer.
    approvals?.cancelSender(sender.id);
    // 终止对话必须真的结束桌面操作：否则浮层留在屏幕上、鼠标还被钩子拦着。
    try {
      void desktop?.stop?.('user-cancel');
    } catch { /* 桌面引擎可能还没启动 */ }
  });
  return senderId => {
    for (const [key, run] of runs) {
      if (key.startsWith(`${senderId}:`)) run.abort();
    }
  };
}

// ── 订阅 Gemini：ACP 入参装配 ────────────────────────────────────────────
// 为什么订阅 provider 需要单独解析 CLI：API Key 型 provider 的「上游是谁」写在 baseUrl 里，
// 主进程只要有 key 就能发请求；订阅 provider 的模型根本不在 Mova 进程里跑——它是用户
// 自己安装的 antigravity CLI 进程，Mova 只是 ACP 客户端。所以每轮对话前都得把
// 「可执行文件、子命令、工作目录」解析出来；解析不到就没有通道，只能明确报错，
// 绝不能悄悄退回 pi-ai（那会把「订阅额度」偷偷变成「API Key 计费」）。

/**
 * provider 是否自报「订阅通道」。契约里没有单一写法，所以两种都认：
 * `kind:'subscription'`（开发文档 §5.1 的内置 provider 标记）与 `id` 前缀 `subscription:`。
 */
function isSubscriptionProvider(provider) {
  const kind = typeof provider?.kind === 'string' ? provider.kind.trim().toLowerCase() : '';
  const type = typeof provider?.type === 'string' ? provider.type.trim().toLowerCase() : '';
  const id = typeof provider?.id === 'string' ? provider.id.trim().toLowerCase() : '';
  return kind === 'subscription' || type === 'subscription' || id.startsWith('subscription:');
}

/** provider 是否对应 Gemini：显式字段优先，其次看 id；名字只在没有显式字段时才作数。 */
function isGeminiSubscriptionTarget(provider) {
  const declared = [provider?.subscriptionProvider, provider?.subscription?.provider, provider?.provider]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase());
  if (declared.includes('gemini')) return true;
  const id = typeof provider?.id === 'string' ? provider.id.toLowerCase() : '';
  if (id.includes('gemini')) return true;
  const name = typeof provider?.name === 'string' ? provider.name.toLowerCase() : '';
  return declared.length === 0 && name.includes('gemini');
}

/**
 * 判定「这一轮该走 ACP 而不是 pi-ai」的唯一条件：既是订阅通道、又是 Gemini。
 * 两个条件必须同时成立，普通 provider（哪怕名字里带 gemini）一个字段都不会被改。
 */
function isSubscriptionGeminiProvider(provider) {
  return isSubscriptionProvider(provider) && isGeminiSubscriptionTarget(provider);
}

/** provider 是否对应 ChatGPT：判定顺序与 Gemini 完全一致，绝不靠名字猜普通 provider。 */
function isChatgptSubscriptionTarget(provider) {
  const declared = [provider?.subscriptionProvider, provider?.subscription?.provider, provider?.provider]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase());
  if (declared.includes('chatgpt')) return true;
  const id = typeof provider?.id === 'string' ? provider.id.toLowerCase() : '';
  if (id.includes('chatgpt')) return true;
  const name = typeof provider?.name === 'string' ? provider.name.toLowerCase() : '';
  return declared.length === 0 && /chat\s*gpt/.test(name);
}

function isSubscriptionChatgptProvider(provider) {
  return isSubscriptionProvider(provider) && isChatgptSubscriptionTarget(provider);
}

/**
 * 读订阅服务：只读注册表，不装配、不抛错。
 * ChatGPT 订阅每轮都要从这里「选号 + 取令牌」，拿不到就当通道不可用。
 */
async function readSubscriptionService() {
  try {
    const { getSubscriptionRuntime } = await import('./subscription/runtime.mjs');
    const service = typeof getSubscriptionRuntime === 'function' ? getSubscriptionRuntime() : null;
    return service && typeof service === 'object' ? service : null;
  } catch {
    return null;
  }
}

/** 没有可用账号时给用户一句能照做的话，而不是一个光秃秃的错误码。 */
function missingChatgptAccountError() {
  const error = new ModelError('not_configured');
  error.message = 'ChatGPT 订阅账号还没登录，或额度都已用完：请到「设置 → CLI 模型」登录或换号后重试。';
  return error;
}

/** 把「没有 CLI / 版本不兼容」收敛进既有错误壳：code 仍是 not_configured，只换成可读文案。 */
function acpNotConfigured(message) {
  const error = new ModelError('not_configured');
  error.message = message;
  return error;
}

/**
 * 读「按模型 VPN 线路」的运行时单例（`electron/vpn/runtime.mjs` 的注册表）。
 *
 * 为什么惰性 + 容错：VPN 是可选能力，模块装不上、单例还没装配、内核没起，
 * 都只意味着「这一轮直连」，绝不允许把一轮对话搞挂。未装配时返回 null。
 */
async function readVpnRuntime() {
  try {
    const mod = await import('./vpn/runtime.mjs');
    return typeof mod.getVpnRuntime === 'function' ? mod.getVpnRuntime() : null;
  } catch {
    return null;
  }
}

/**
 * 读订阅设置。注册表可能还没装配、方法也可能还没实现（另一路在补），
 * 所以逐层容错：任何一步失败都当作「订阅不可用」，绝不让 model:complete 抛错。
 */
async function readSubscriptionSettings() {
  try {
    const { getSubscriptionRuntime } = await import('./subscription/runtime.mjs');
    const service = typeof getSubscriptionRuntime === 'function' ? getSubscriptionRuntime() : null;
    if (!service) return null;
    if (typeof service.getSettings === 'function') return await service.getSettings();
    // 兼容现行服务面的命名（ipc.mjs 目前叫 settings）。
    if (typeof service.settings === 'function') return await service.settings();
    return null;
  } catch {
    return null;
  }
}

/**
 * 调 cli.mjs 的 `locateCli`。模块还没落地、签名不合、探测抛错都返回 null，
 * 调用方据此退回 settings.cliPath——CLI 探测永远不能把一轮对话搞挂。
 */
async function runCliLocator(settings) {
  try {
    const mod = await import('./subscription/cli.mjs');
    if (typeof mod?.locateCli !== 'function') return null;
    // 只为探测注入 IO：不新增依赖，用 Node 自带能力适配（全局 fetch/require 之外的都可注入）。
    const { access } = require('node:fs/promises');
    const { execFile } = require('node:child_process');
    const { homedir } = require('node:os');
    return await mod.locateCli({
      settings,
      platform: process.platform,
      env: process.env,
      home: homedir(),
      // 只回答「在不在」且不抛错：布尔约定和「抛异常=不存在」两种用法都成立。
      access: async target => {
        try { await access(target); return true; } catch { return false; }
      },
      // 只用来读版本号：固定短超时，失败也 resolve，不把子进程错误变成对话错误。
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
    });
  } catch {
    return null;
  }
}

/** ACP 子命令：默认 `acp`（开发文档 §10.2「agy acp」），探测给了就用探测的。 */
function acpArgsFrom(value) {
  return Array.isArray(value) && value.length && value.every(item => typeof item === 'string')
    ? value.slice(0, 16) : ['acp'];
}

/**
 * 解析 CLI：settings.cliPath（用户显式指定）优先，locateCli 兜底（PATH / 常见安装位置）。
 * 只有探测明确说 compatible === false 才算不兼容；拿不到版本信息一律放行。
 */
async function resolveSubscriptionCli(settings) {
  const located = await runCliLocator(settings);
  if (located?.found === true && typeof located.command === 'string' && located.command.trim()) {
    return {
      found: true,
      command: located.command.trim(),
      args: acpArgsFrom(located.args),
      compatible: located.compatible !== false,
    };
  }
  const configured = typeof settings?.cliPath === 'string' ? settings.cliPath.trim() : '';
  if (configured) {
    // 兜底探测没落地/没认出来时仍然尊重用户手填的路径：真不可执行会由引擎 spawn 失败转成 not_configured。
    return { found: true, command: configured, args: ['acp'], compatible: true };
  }
  return { found: false, command: '', args: ['acp'], compatible: true };
}

/**
 * ACP 的工作目录 = 项目根：CLI 用它决定相对路径与项目规则。
 * 先看渲染层给的 request.projectRoots，再退回主进程自己登记过的 projectRoots
 *（渲染层通常只传不透明的 projectRootIds，所以真正生效的往往是后者）。都没有就省略。
 */
function acpWorkspace(request, registeredRoots) {
  for (const group of [request?.projectRoots, registeredRoots]) {
    for (const item of Array.isArray(group) ? group : []) {
      const value = typeof item === 'string' ? item : item?.path ?? item?.root ?? item?.dir;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/**
 * 组装 ACP 入参：只补 engine / acpCommand / acpArgs / acpCwd 四个字段，其余原样透传，
 * 所以 runs、预算、审批、权限、搜索注入全部不受影响。
 * CLI 缺失或版本过旧一律抛 not_configured：用户选了 Gemini 就该看到明确原因，
 * 静默降级到 pi-ai 会让「订阅额度」莫名其妙变成 API Key 账单。
 */
async function buildAcpRequest(request, registeredRoots, model = null) {
  const settings = await readSubscriptionSettings();
  const cli = await resolveSubscriptionCli(settings);
  if (!cli.found) throw acpNotConfigured('未找到 antigravity CLI，请先安装，或在设置 → CLI 模型中指定它的路径');
  if (cli.compatible === false) throw acpNotConfigured('antigravity CLI 版本过旧，与当前 Mova 不兼容，请升级后再使用 Gemini 订阅通道');
  const cwd = acpWorkspace(request, registeredRoots);
  // 目录里一条模型对应多个真实 id（每个思考档位一个）：这里把「家族 + 档位」翻译成要发给 CLI 的 id。
  // 没有 variants 的老目录/用户自建条目就退回条目 id 本身。
  let acpModelId = '';
  if (model) {
    try {
      const { resolveVariantId } = await import('./subscription/cli-models.mjs');
      acpModelId = resolveVariantId(model, request?.thinking);
    } catch {
      acpModelId = typeof model.id === 'string' ? model.id : '';
    }
  }
  // 按模型 VPN：给 `agy` 子进程注入该模型专属端口的代理环境变量。
  // 未分配线路（或内核没起）时 envForModel 返回 null，下面的字段不会出现在请求里，
  // engine/client 收到的就是默认的「继承 process.env」，与改动前一致。
  const vpnRuntime = await readVpnRuntime();
  const acpEnv = vpnRuntime?.envForModel?.('subscription:gemini', model?.id ?? '') ?? null;
  return {
    ...(request && typeof request === 'object' ? request : {}),
    engine: 'acp',
    acpCommand: cli.command,
    acpArgs: cli.args,
    ...(acpModelId ? { acpModelId } : {}),
    ...(cwd ? { acpCwd: cwd } : {}),
    ...(acpEnv ? { acpEnv } : {}),
  };
}

module.exports = { installModelIpc, searchOptionsFor };
// 只给测试用的出口：不可枚举，既不进 IPC 装配面，也不会被别的模块当成依赖。
Object.defineProperty(module.exports, '__test__', {
  value: Object.freeze({ buildActionRecord }),
  enumerable: false,
});
