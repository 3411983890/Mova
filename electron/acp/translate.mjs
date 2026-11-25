/**
 * ACP 反向/正向消息 → Mova 流事件的纯翻译层。
 *
 * 负责：形状转换 + 状态归一（round 累计、tool 增量合并、plan 归一、审批/提问判别）。
 * 不负责：IPC、进程管理、节流上屏、审批落库、会话生命周期 —— 那些在接线层。
 * 调用方：electron/acp 的会话适配器（每收到一条 session/update 调一次，把返回的
 * state 原样传回下一次；events 直接按顺序交给渲染端）。全部零 IO，可在 node 里直跑。
 *
 * ID 全部由 state 计数器派生（不用 Date.now / random），保证同一条流在测试里可复现。
 */

// 工具输出单条上限（字符）：再长就不是工具摘要而是日志，渲染端也会被撑爆。
const MAX_OUTPUT_ENTRY = 8192;
// 工具输出保留条数：只留尾部，前面的已被后续输出覆盖掉价值。
const MAX_OUTPUT_ENTRIES = 20;
// 计划步骤上限：ACP 计划可能很长，Mova 计划卡只承载「当前这一步」。
const MAX_STEPS = 20;
const MAX_LABEL = 200;
const MAX_DETAIL = 400;
const MAX_ID = 120;

// 带语义的审批选项 kind（§11.6）：出现任意一个就说明这是一次权限请求。
const APPROVAL_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
// ACP tool call status → Mova 四态。cancelled 归 denied：中断后不能留 running。
const TOOL_STATUS = {
  pending: 'running',
  in_progress: 'running',
  completed: 'done',
  failed: 'error',
  cancelled: 'denied',
  canceled: 'denied',
};
// ACP plan entry status → Mova 三态 + 失败/取消的附带说明。
const PLAN_STATUS = {
  pending: 'pending',
  in_progress: 'active',
  completed: 'done',
  failed: 'done',
  cancelled: 'done',
  canceled: 'done',
};
const PLAN_META = { failed: '失败', cancelled: '已取消', canceled: '已取消' };
const NOTICE_TONES = ['info', 'warn', 'error'];

/** 元数据类字段统一 trim + 截断；正文（思考/文本/输出）不能走这里，否则会吃掉换行。 */
const str = (value, limit = MAX_LABEL) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
const count = value => (Number.isFinite(value) && value > 0 ? value : 0);

/** 取一条 session/update（兼容 {params:{update}} / {update} / 直接传 update 三种形状）。 */
function pickUpdate(notification) {
  if (!notification || typeof notification !== 'object') return null;
  const wrapped = notification.params?.update ?? notification.update;
  if (wrapped && typeof wrapped === 'object') return wrapped;
  return typeof notification.sessionUpdate === 'string' ? notification : null;
}

/** 取 update 的正文：ACP 是 `content:{type:'text',text}`，也兼容纯字符串与数组。 */
function textOf(update) {
  const content = update?.content;
  if (typeof content === 'string') return content;
  if (typeof content?.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content.filter(part => typeof part?.text === 'string').map(part => part.text).join('');
  }
  return typeof update?.text === 'string' ? update.text : '';
}

/**
 * CLI 自己打印的诊断行（上游 API 失败、自动重试、连接断开）**不是模型说的话**。
 * `agy` 会把它们当作 `agent_message` 流吐出来，直接进正文就是「⚠ API error (attempt 1): ... EOF」
 * 糊在回答开头，用户会以为整轮失败。所以这里把它们单独抠出来，改走可折叠的 thinking 块。
 *
 * 只认几类明确形态，宁可漏判也不误吞模型正文：一条真正以「Error:」开头的回答
 * 只有同时命中 `request failed` / `fetch failed` 这类网络失败词才会被搬走。
 */
const DIAGNOSTIC_LINE = /^\s*(?:\[(?:agy|cli|mcp)\]\s*)?[⚠!]?\s*(?:API error\s*\(attempt\s*\d+\)|request failed:\s*(?:Post|Get|Put|Patch|Delete)\b|fetch failed\b|socket hang up\b|ECONNRESET\b|ETIMEDOUT\b|EAI_AGAIN\b)/i;

/** 诊断块上限：超过就收口，避免一条畸形流把正文永久吞进折叠块。 */
const MAX_DIAGNOSTICS_CHARS = 4000;

/**
 * 折叠块的标题行：渲染端拿 `paragraphs[0]` 当收起状态的单行摘要，
 * 所以第一行必须是中性说明，不能是原始错误文本（否则收起时仍然糊在时间线上）。
 */
const DIAGNOSTICS_HEADER = '模型服务重试记录（点开可查看原始错误）\n\n';

/**
 * 把一段 chunk 拆成「正文」与「CLI 诊断」。
 * 诊断块内的缩进续行（栈帧、URL 折行）算同一块；一旦遇到不缩进的普通行就收口。
 * @param {string} chunk
 * @returns {{ body: string, diagnostics: string }}
 */
export function splitCliDiagnostics(chunk) {
  if (typeof chunk !== 'string' || !chunk) return { body: chunk ?? '', diagnostics: '' };
  if (!DIAGNOSTIC_LINE.test(chunk)) return { body: chunk, diagnostics: '' };
  const lines = chunk.split(/(?<=\n)/);
  const body = [];
  const diagnostics = [];
  let inDiagnostics = false;
  for (const line of lines) {
    if (DIAGNOSTIC_LINE.test(line)) {
      inDiagnostics = true;
      diagnostics.push(line);
      continue;
    }
    if (inDiagnostics && /^\s+\S/.test(line)) {
      diagnostics.push(line);
      continue;
    }
    inDiagnostics = false;
    body.push(line);
  }
  return { body: body.join(''), diagnostics: diagnostics.join('') };
}

/** 工具调用的「一句话说明」：命令优先，其次路径/描述/查询，够审批条一行看明白。 */
function describeInput(rawInput) {
  if (typeof rawInput === 'string') return str(rawInput, MAX_DETAIL);
  if (!rawInput || typeof rawInput !== 'object') return '';
  return str(rawInput.command, MAX_DETAIL)
    || pathOfInput(rawInput)
    || str(rawInput.description, MAX_DETAIL)
    || str(rawInput.query, MAX_DETAIL);
}

/**
 * CLI 自己工具的「文件路径」参数（`read_file` / `view_file` / `write_file` 这类）。
 *
 * 为什么不复用 `electron/skills/tool-path.mjs` 的 `firstPathOf`：那是 Mova 自己工具的命名习惯
 * （path / file / filePath / cwd / dir），而 CLI 侧用的是 snake_case（`file_path` / `target_file`）。
 * 两套名字都认，但优先级各按各的——模型看不到这份代码，它只按自己工具的 schema 传参。
 */
function pathOfInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return '';
  return str(rawInput.path, MAX_DETAIL)
    || str(rawInput.file_path ?? rawInput.filePath, MAX_DETAIL)
    || str(rawInput.target_file ?? rawInput.absolute_path, MAX_DETAIL);
}

/** 审批选项上的安全警告；ACP 既可能挂在选项上，也可能挂在 toolCall 上。 */
function securityWarning(meta) {
  const warning = meta?.security_warning ?? meta?.securityWarning;
  if (!warning || typeof warning !== 'object') return '';
  return str(warning.message, 300) || str(warning.title, 120);
}

/**
 * 翻译状态：一次 prompt 轮次内有效，调用方负责保存与回传。
 * 全是可序列化数据（没有函数），方便日志里排查为什么某一行没出现。
 */
export function createTranslateState() {
  return {
    // 思考轮次：每次「新的思考段」+1，渲染端按 round 分块。
    round: 0,
    thinkingOpen: false,
    thinking: '',
    // CLI 自己打印的诊断（上游 API 失败 / 自动重试）累计成一条可折叠块，不混进正文。
    diagnostics: '',
    diagnosticsOpen: false,
    // 文本段：同一段内的多个 chunk 共用一个 id（增量追加），换段才换 id。
    textOpen: false,
    textSeq: 0,
    // toolCallId → 已合并的工具行；tool_call_update 只带增量字段，所以要留底。
    tools: {},
    // 当前计划（整表替换），用于 plan_removed 之外的一致性。
    plan: null,
    // 审批/提问判别时的兜底 id 序号。
    permSeq: 0,
  };
}

/**
 * 一条 session/update → 若干个 Mova 事件。
 * 未知 update 必须安全返回空数组：ACP 演进很快，翻译层不认识的东西不能拖垮整轮对话。
 */
export function translateSessionUpdate(notification, state) {
  const next = state && typeof state === 'object' ? state : createTranslateState();
  const update = pickUpdate(notification);
  if (!update) return { events: [], state: next };

  const kind = str(update.sessionUpdate ?? update.type, 60);
  // 一段流里「思考 → 文本 → 工具」交替出现；换段就闭合上一段，避免 id 串到下一段里。
  const isThought = kind === 'agent_thought_chunk' || kind === 'agent_thought';
  const isText = kind === 'agent_message_chunk' || kind === 'agent_message';
  if (!isThought) next.thinkingOpen = false;
  if (!isText) next.textOpen = false;

  switch (kind) {
    case 'agent_thought_chunk':
    case 'agent_thought': {
      const chunk = textOf(update);
      if (!chunk) return { events: [], state: next };
      if (!next.thinkingOpen) {
        next.thinkingOpen = true;
        next.thinking = '';
        next.round += 1;
      }
      next.thinking += chunk;
      // 同轮累计成一条：渲染端按 id 覆盖那一行，不必自己拼增量。
      return {
        events: [{ type: 'thinking', id: `thinking-${next.round}`, round: next.round, text: next.thinking }],
        state: next,
      };
    }

    case 'agent_message_chunk':
    case 'agent_message': {
      const chunk = textOf(update);
      // 只丢真正的空串：纯空白块可能是两个词之间的空格，丢了会粘字。
      if (!chunk) return { events: [], state: next };
      const events = [];
      const { body, diagnostics } = splitCliDiagnostics(chunk);
      // 诊断块可能被拆成多个 chunk 送达（「...request failed: 」+「EOF」）：
      // 上一块没以换行收尾时继续把后续**短片段**归入同一个折叠块，直到遇到换行或超上限。
      // 只吞短片段是有意的：宁可漏掉半行错误，也不把真正的回答吞进折叠块里。
      const streamingDiagnostics = next.diagnosticsOpen === true
        && !/\n\s*$/.test(next.diagnostics)
        && next.diagnostics.length < MAX_DIAGNOSTICS_CHARS;
      const carried = diagnostics || (streamingDiagnostics && chunk.length <= 200 ? chunk : '');
      // 整块被当作诊断续行时，正文必须清空——否则「EOF」这类尾巴会同时进折叠块和正文。
      const rest = carried && !diagnostics ? '' : body;
      if (carried) {
        const previous = typeof next.diagnostics === 'string' ? next.diagnostics : '';
        next.diagnostics = (previous || DIAGNOSTICS_HEADER) + carried;
        next.diagnosticsOpen = !/\n\s*$/.test(next.diagnostics) && next.diagnostics.length < MAX_DIAGNOSTICS_CHARS;
        events.push({ type: 'thinking', id: 'cli-diagnostics', round: next.round, text: next.diagnostics });
      } else {
        next.diagnosticsOpen = false;
      }
      if (rest) {
        if (!next.textOpen) {
          next.textOpen = true;
          next.textSeq += 1;
        }
        events.push({ type: 'text', id: `text-${next.textSeq}`, text: rest });
      }
      return { events, state: next };
    }

    case 'tool_call':
    case 'tool_call_update':
      return translateTool(update, next);

    case 'plan':
    case 'plan_update':
      return translatePlan(update, next, false);

    case 'plan_removed':
      next.plan = null;
      return { events: [{ type: 'plan', plan: null }], state: next };

    case 'compaction_update':
      return { events: [createNotice('上下文已压缩', 'info')], state: next };

    case 'turn_end':
      // 少数 ACP 实现用显式 turn_end 收尾；主路径仍是 PromptResponse。
      return { events: [], state: next, done: true };

    default:
      return { events: [], state: next, ...(update._meta?.done === true ? { done: true } : {}) };
  }
}

/** 工具行：call 与 update 共用一条合并逻辑，后到的字段只覆盖它自己带了的那些。 */
function translateTool(update, state) {
  const id = str(update.toolCallId ?? update.toolCall_id ?? update.id, MAX_ID);
  if (!id) return { events: [], state };

  const prev = state.tools[id];
  const tool = {
    name: 'tool',
    label: '',
    status: 'running',
    detail: '',
    output: [],
    diff: null,
    path: '',
    ...(prev ? { ...prev, output: [...prev.output] } : {}),
  };

  const name = str(update.kind ?? update._meta?.toolName ?? update.toolName, 60);
  if (name) tool.name = name;
  const label = str(update.title, MAX_LABEL);
  if (label) tool.label = label;
  const detail = describeInput(update.rawInput);
  if (detail) tool.detail = detail;
  // CLI 工具读/写了哪个文件：渲染层拿它画可点击的路径（左键右侧打开、Ctrl+点击外部打开）。
  const inputPath = pathOfInput(update.rawInput);
  if (inputPath) tool.path = inputPath;
  const status = TOOL_STATUS[str(update.status, 30)];
  if (status) tool.status = status;

  for (const part of Array.isArray(update.content) ? update.content : []) {
    if (part?.type === 'diff') {
      // diff 直接喂 changes 面板与审批预览，不做行级切分（切分是渲染层的事）。
      const path = str(part.path ?? part.newPath, MAX_DETAIL);
      tool.diff = {
        path,
        before: typeof part.oldText === 'string' ? part.oldText : null,
        after: typeof part.newText === 'string' ? part.newText : null,
      };
      if (path) tool.path = path;
      continue;
    }
    if (part?.type === 'content' && part.content?.type === 'text' && typeof part.content.text === 'string') {
      if (!part.content.text) continue;
      tool.output.push(part.content.text.slice(0, MAX_OUTPUT_ENTRY));
      if (tool.output.length > MAX_OUTPUT_ENTRIES) tool.output = tool.output.slice(-MAX_OUTPUT_ENTRIES);
    }
  }

  state.tools[id] = tool;
  return {
    events: [{
      type: 'tool',
      id,
      name: tool.name,
      label: tool.label || tool.name,
      status: tool.status,
      detail: tool.detail,
      ...(tool.diff ? { diff: tool.diff } : {}),
      ...(tool.path ? { path: tool.path } : {}),
      ...(tool.output.length ? { output: [...tool.output] } : {}),
    }],
    state,
  };
}

/** 计划整表替换：ACP 每次给全量 entries，翻译层不做增量合并。 */
function translatePlan(update, state, removed) {
  if (removed) {
    state.plan = null;
    return { events: [{ type: 'plan', plan: null }], state };
  }
  const entries = Array.isArray(update.entries)
    ? update.entries
    : (Array.isArray(update.plan?.entries) ? update.plan.entries : []);
  const { steps } = planEntriesToSteps(entries);
  state.plan = steps.length ? { steps } : null;
  // 空计划等于没有计划：给渲染端 null，别画一张空卡。
  return { events: [{ type: 'plan', plan: state.plan }], state };
}

/**
 * ACP plan entries → Mova steps。
 * 归一规则来自 §11.3：多个 in_progress 只留第一个为 active（否则计划卡同时高亮两行，
 * 用户看不出在做哪一步）；failed 落成 done + meta「失败」，因为 Mova 计划没有失败态。
 */
export function planEntriesToSteps(entries) {
  const steps = (Array.isArray(entries) ? entries : []).slice(0, MAX_STEPS).flatMap(entry => {
    const label = str(typeof entry === 'string' ? entry : entry?.content ?? entry?.label ?? entry?.step, MAX_LABEL);
    if (!label) return [];
    const raw = str(entry?.status, 30);
    const meta = PLAN_META[raw] ?? str(entry?.meta, 60);
    return [{ label, status: PLAN_STATUS[raw] ?? 'pending', ...(meta ? { meta } : {}) }];
  });

  let activeSeen = false;
  for (const step of steps) {
    if (step.status !== 'active') continue;
    if (activeSeen) step.status = 'pending';
    activeSeen = true;
  }
  return { steps };
}

/**
 * PromptResponse.usage → Mova 的 usage 事件（Gemini 口径，§11.2）。
 * Gemini 的 inputTokens 不含缓存命中、outputTokens 不含思考，直接相加会少算；
 * 这里把两段并进 input/output，并把 cacheRead 归零 —— 否则下游逐字段累加时会重复计一次。
 */
export function translateUsage(usage) {
  const raw = usage && typeof usage === 'object' ? usage : {};
  const inputTokens = count(raw.inputTokens ?? raw.input ?? raw.promptTokens);
  const outputTokens = count(raw.outputTokens ?? raw.output ?? raw.completionTokens);
  const cachedRead = count(raw.cachedReadTokens ?? raw.cached_read_tokens ?? raw.cacheRead);
  const thought = count(raw.thoughtTokens ?? raw.thought_tokens ?? raw.reasoningTokens);
  const input = inputTokens + cachedRead;
  const output = outputTokens + thought;
  const model = str(raw.model, MAX_ID);
  const provider = str(raw.provider, MAX_ID);
  return {
    type: 'usage',
    call: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: count(raw.totalTokens ?? raw.total_tokens) || input + output,
      cost: count(typeof raw.cost === 'number' ? raw.cost : raw.cost?.total),
    },
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

/**
 * session/request_permission → 提问卡 or 审批条（§11.4 / §11.6）。
 * 判别依据只有选项集合形态：带语义 kind = 权限请求；纯 {optionId,name} = Antigravity 的「让用户选一个」。
 * 拿不准时按审批处理（更保守：审批不会替用户编造答案）。
 */
export function translatePermissionRequest(request, state) {
  if (state && typeof state === 'object') state.permSeq = count(state.permSeq) + 1;
  const params = request?.params && typeof request.params === 'object' ? request.params : (request ?? {});
  const toolCall = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : null;
  const options = Array.isArray(params.options) ? params.options : [];
  const kinds = options.map(option => str(option?.kind, 40)).filter(Boolean);
  const hasApprovalKind = kinds.some(kind => APPROVAL_KINDS.includes(kind));
  const id = str(toolCall?.toolCallId ?? params.toolCallId, MAX_ID)
    || `permission-${count(state?.permSeq) || 1}`;

  // 没有 toolCall 就说不清「在批什么」，只能保守当审批。
  if (!toolCall) {
    return { kind: 'approval', approval: buildApproval(null, options), uncertain: true };
  }

  if (!hasApprovalKind) {
    if (kinds.length) {
      // 有 kind 但一个都不认识（§11.6「无匹配」）：只能当审批，UI 会退化成「取消」。
      return { kind: 'approval', approval: buildApproval(toolCall, options), uncertain: true };
    }
    if (options.length) {
      return {
        kind: 'question',
        question: {
          id,
          header: '需要你确认',
          question: str(toolCall.title, MAX_LABEL) || '需要你确认',
          // 不在这里做 4 项 / 26 字裁剪：截断属于渲染层，「查看全部」还需要原文。
          options: options.map(option => ({
            value: str(option?.optionId, MAX_ID),
            label: str(option?.name, MAX_LABEL) || str(option?.optionId, MAX_ID),
          })).filter(option => option.value),
        },
      };
    }
    // 一个选项都没有：用户无从回答，按审批 + uncertain 交回调用方决定（多半直接取消）。
    return { kind: 'approval', approval: buildApproval(toolCall, options), uncertain: true };
  }

  const approval = buildApproval(toolCall, options);
  // 有语义 kind，但选项集合不完整（部分选项缺 kind）时仍算拿不准。
  const complete = kinds.length === options.length;
  return { kind: 'approval', approval, ...(complete ? {} : { uncertain: true }) };
}

function buildApproval(toolCall, options) {
  return {
    message: str(toolCall?.title, MAX_LABEL) || '需要你确认',
    detail: describeInput(toolCall?.rawInput) || textOf(toolCall).slice(0, MAX_DETAIL).trim(),
    options: options.map(option => {
      const warning = securityWarning(option?._meta) || securityWarning(toolCall?._meta);
      return {
        id: str(option?.optionId, MAX_ID),
        label: str(option?.name, MAX_LABEL) || str(option?.optionId, MAX_ID),
        // 保留原始 kind：未知 kind 也不能改写，否则回填 optionId 时对不上上游语义。
        kind: str(option?.kind, 40) || 'other',
        ...(warning ? { warning } : {}),
      };
    }).filter(option => option.id),
  };
}

/** 时间线上的一行浅色提示；tone 非法时按 info 处理（notice 永不该让一轮对话失败）。 */
export function createNotice(text, tone) {
  return {
    type: 'notice',
    tone: NOTICE_TONES.includes(tone) ? tone : 'info',
    text: typeof text === 'string' ? text.trim() : '',
  };
}
