/**
 * 负责：把 `electron/agent-tools.cjs`（createProjectTools 的 15 个项目工具）包成技能 handler——
 *   逐字段校验参数、写/执行前先申请授权（并给审批卡带上变更预览）、调用既有实现、把返回值与 diff 透传给前端。
 *   另加一个 `apply_patch` 兼容垫片：把统一 diff 拆成 hunk 后交给既有的 replace_in_file。
 * 不负责：realpath/symlink 逃逸校验、`.git` 保护、能力位复查、审批弹条、审计与撤销记录
 *   （全部留在 agent-tools.cjs / permissions.cjs），也不做结果截断（adapters/mcp.mjs 负责）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-pack-handlers.test.mjs。
 *
 * `deps.projectTools` 两种形态（由接线层决定）：
 *   1) 数组：`createProjectTools({...})` 的返回值。工具内部的 tool 事件直接走接线层自己的 emit，
 *      本 handler 因此拿不到 diff / 命令输出（返回值照常透传）。
 *   2) 工厂：`({ emit, callId, signal }) => ProjectTool[]`。每次调用新建一份工具，把 agent-tools
 *      自己的 tool 事件挂到同一个 callId 上——前端同一行原地更新，并能拿到 write_file 的 diff
 *      与 run_command 的命令行/输出。**推荐形态**。
 *
 * 硬约束：本文件的 handler 永不 throw（MCP 里一个异常就会打断整轮），失败一律收敛成 isError 结果；
 * 写/执行类在拿到 `allowed !== true` 时零副作用直接返回拒绝结果，绝不「先写再问」。
 */

import { readFile, stat } from 'node:fs/promises';

import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';
import { invalidArgumentsResult, validateInput } from '../../input-schema.mjs';

/** 路径参数上限：与 manifest 的 schema 和 agent-tools 保持一致。 */
const MAX_PATH = 400;
/** apply_patch 的 hunk 数与单 hunk 字符上限（一个 hunk 一次审批，太多就是灾难）。 */
const MAX_HUNKS = 20;
const MAX_HUNK_CHARS = 8_000;
const MAX_PATCH_CHARS = 20_000;
/** 事件 detail 只用于一行摘要，不转储日志。 */
const DETAIL_CHARS = 300;
/**
 * 审批卡预览唯一需要读整份文件的场景是 `write_file` 的 before。超过这个大小的文本文件不读：
 * 预览本身还会被 `approval-bridge` 截到 300 行 / 100_000 字符（与 agent-tools 的预览预算同口径），
 * 为一个看不全的预览把大文件整份读进内存不值——不读就降级成「没有 diff 的卡」，授权照常。
 */
const PREVIEW_FILE_BYTES = 1_000_000;

/** 会真正落盘或执行命令的工具：必须先过 ctx.authorize()。 */
const WRITE_TOOLS = new Set([
  'write_file', 'apply_patch', 'replace_in_file', 'delete_path', 'move_path', 'apply_changes',
  'undo_change', 'run_command',
]);

/**
 * 逐工具的参数规则。只声明「本 handler 负责校验」的字段：类型、必填、长度/范围/枚举。
 * 方言是 `electron/skills/input-schema.mjs` 那一份（JSON Schema 子集 + 字段级 required 简写），
 * 本文件不再自带校验器：同一件事只允许一处实现。
 * 不做业务判断（路径是否越界、原文是否唯一）——那属于 agent-tools.cjs，抄一份必然漂移。
 */
const SPECS = Object.freeze({
  read_file: {
    path: { type: 'string', required: true, maxLength: MAX_PATH },
    startLine: { type: 'integer', minimum: 1 },
    endLine: { type: 'integer', minimum: 1 },
  },
  list_files: {
    path: { type: 'string', maxLength: MAX_PATH },
    depth: { type: 'integer', minimum: 1, maximum: 3 },
  },
  write_file: {
    path: { type: 'string', required: true, maxLength: MAX_PATH },
    content: { type: 'string', required: true, maxLength: 512_000, allowEmpty: true },
  },
  search_files: {
    query: { type: 'string', required: true, maxLength: 200 },
    path: { type: 'string', maxLength: MAX_PATH },
    regex: { type: 'boolean' },
    ignoreCase: { type: 'boolean' },
    maxResults: { type: 'integer', minimum: 1, maximum: 120 },
  },
  project_tree: {
    path: { type: 'string', maxLength: MAX_PATH },
    depth: { type: 'integer', minimum: 1, maximum: 4 },
    maxEntries: { type: 'integer', minimum: 1, maximum: 400 },
  },
  find_symbol: {
    name: { type: 'string', required: true, maxLength: 120 },
    kind: { type: 'string', enum: ['any', 'definition', 'reference'] },
    path: { type: 'string', maxLength: MAX_PATH },
    maxResults: { type: 'integer', minimum: 1, maximum: 120 },
    ignoreCase: { type: 'boolean' },
  },
  git_status: { path: { type: 'string', maxLength: MAX_PATH } },
  git_diff: {
    path: { type: 'string', maxLength: MAX_PATH },
    staged: { type: 'boolean' },
  },
  list_changes: { limit: { type: 'integer', minimum: 1, maximum: 30 } },
  replace_in_file: {
    path: { type: 'string', required: true, maxLength: MAX_PATH },
    oldText: { type: 'string', required: true, maxLength: MAX_HUNK_CHARS },
    newText: { type: 'string', maxLength: 512_000, allowEmpty: true },
    all: { type: 'boolean' },
  },
  delete_path: {
    path: { type: 'string', required: true, maxLength: MAX_PATH },
    recursive: { type: 'boolean' },
  },
  move_path: {
    from: { type: 'string', required: true, maxLength: MAX_PATH },
    to: { type: 'string', required: true, maxLength: MAX_PATH },
    overwrite: { type: 'boolean' },
  },
  apply_changes: {
    changes: { type: 'array', required: true, minItems: 1, maxItems: 20, items: { type: 'object' } },
  },
  undo_change: { changeId: { type: 'string', required: true, maxLength: 80 } },
  run_command: {
    command: { type: 'string', maxLength: 2_000 },
    argv: { type: 'array', maxItems: 64, items: { type: 'string' } },
    shell: { type: 'boolean' },
    path: { type: 'string', maxLength: MAX_PATH },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: 120_000 },
  },
});

/** 参数错误的唯一出口：错误码与形状由 input-schema.mjs 统一拼（技能层只有那一处写 invalid_arguments）。 */
function invalid(message) {
  return invalidArgumentsResult([{ path: '', message }]);
}

/** 事件通道：优先 per-call 的 ctx.emit（同一轮），其次 deps.emit（接线层注入）。 */
function emitOf(deps, ctx) {
  if (typeof ctx?.emit === 'function') return ctx.emit;
  if (typeof deps?.emit === 'function') return deps.emit;
  return null;
}

/** 拒绝时补一条旁白：handler 不抛错，前端工具行不会变红，旁白是唯一能说清原因的地方。 */
function notice(deps, ctx, text) {
  const emit = emitOf(deps, ctx);
  if (!emit) return;
  try {
    emit({ type: 'notice', tone: 'warn', text: String(text).slice(0, DETAIL_CHARS) });
  } catch { /* 旁白发不出去不影响拒绝结论 */ }
}

/** run_command 的互斥约束在 schema 里表达不了，只能在入口判一次。 */
function checkCommand(args) {
  const hasCommand = typeof args.command === 'string' && args.command.trim().length > 0;
  const hasArgv = Array.isArray(args.argv) && args.argv.length > 0 && String(args.argv[0] ?? '').trim().length > 0;
  if (hasCommand && hasArgv) return { ok: false, message: 'command 与 argv 只能二选一' };
  if (!hasCommand && !hasArgv) return { ok: false, message: '必须给 command 或 argv' };
  if (hasCommand && args.shell === false) return { ok: false, message: 'command 始终经 shell 解释，不能传 shell:false（要直接执行请用 argv）' };
  return { ok: true };
}

/**
 * 取这一次调用可用的工具集。
 * 工厂形态下顺带把 agent-tools 自己的 tool 事件转发到同一个 callId 上：前端同一行原地更新，
 * 也让 write_file 的 diff、run_command 的命令行与输出能到前端。
 */
function openTools(deps, ctx) {
  const source = deps?.projectTools;
  if (typeof source === 'function') {
    const events = [];
    const callId = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : undefined;
    const emit = emitOf(deps, ctx);
    const list = source({
      callId,
      signal: ctx.signal,
      emit(event) {
        if (!event || typeof event !== 'object') return;
        events.push(event);
        if (!emit) return;
        try {
          emit(callId ? { ...event, id: callId } : event);
        } catch { /* 事件发不出去不影响工具结果 */ }
      },
    });
    return { tools: Array.isArray(list) ? list : [], events };
  }
  return { tools: Array.isArray(source) ? source : [], events: null };
}

function findTool(tools, name) {
  return Array.isArray(tools) ? (tools.find(tool => tool?.name === name && typeof tool.execute === 'function') ?? null) : null;
}

function lastEvent(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && typeof event === 'object' && typeof event.status === 'string') return event;
  }
  return null;
}

/** agent-tools 的预览形状 {kind,path,before,after,truncated} → 前端 ToolDiff 的 {path,before,after}。 */
function diffOf(event) {
  const diff = event?.diff;
  if (!diff || typeof diff !== 'object') return null;
  return {
    path: typeof diff.path === 'string' ? diff.path : '',
    before: typeof diff.before === 'string' ? diff.before : null,
    after: typeof diff.after === 'string' ? diff.after : null,
    ...(diff.truncated === true ? { truncated: true } : {}),
  };
}

/** handler 返回值上的附加信息：detail 一句话摘要 + diff 变更卡。 */
function metaOf(events) {
  const last = lastEvent(events);
  if (!last) return {};
  const diff = diffOf(last);
  return {
    ...(typeof last.detail === 'string' && last.detail.trim()
      ? { detail: last.detail.trim().slice(0, DETAIL_CHARS) } : {}),
    ...(diff ? { diff } : {}),
  };
}

/**
 * `write_file` 的审批卡预览：before = 磁盘上的当前内容（新建按空串），after = 参数里的 content。
 *
 * 返回的是**延迟构造的闭包**而不是值：绝对路径只有路径闸门知道（`resolveInRoots` 是唯一实现，
 * handler 不许自己拼），所以 `approval-bridge` 会在闸门解析完、弹卡之前用 `{ path }` 回调它。
 *
 * 任何异常都往上抛（由 bridge 降级成不带预览的卡并记 debug），二进制/超大返回 null 表示「不给预览」。
 * 预览永远不能阻塞授权：读不出来只是少一张 diff。
 */
function writePreview(args) {
  return async ({ path }) => {
    const shown = String(args.path ?? '');
    const after = typeof args.content === 'string' ? args.content : '';
    // ENOENT 是正常情况（新建文件，before 就是空串）；其他 stat 失败（权限/非目录…）交给 bridge 降级。
    const info = await stat(path).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return { kind: 'write', path: shown, before: '', after };
    if (!info.isFile() || info.size > PREVIEW_FILE_BYTES) return null;
    const current = await readFile(path, 'utf8');
    if (current.includes('\0')) return null; // 二进制没有可读的文本对照（agent-tools 也会拒绝覆盖它）
    return { kind: 'write', path: shown, before: current, after };
  };
}

/**
 * `replace_in_file` 的审批卡预览：与 agent-tools 的 `previewOf('replace', …, args.oldText, newText)`
 * 同一份结构——展示「被替换的片段 → 新片段」，所以不需要读盘，也不会因为文件读不出来而失败。
 */
function replacePreview(args) {
  return {
    kind: 'replace',
    path: String(args.path ?? ''),
    before: typeof args.oldText === 'string' ? args.oldText : '',
    after: typeof args.newText === 'string' ? args.newText : '',
  };
}

/**
 * `apply_patch` 的审批卡预览：把所有 hunk 的「删掉的行 / 加上的行」按顺序拼起来。
 * 与它真正的执行方式（逐个 hunk 交给 replace_in_file）同源，不另算一套 diff。
 */
function patchPreview(args, hunks) {
  const list = Array.isArray(hunks) ? hunks : [];
  return {
    kind: 'replace',
    path: String(args.path ?? ''),
    before: list.map(hunk => (typeof hunk?.oldText === 'string' ? hunk.oldText : '')).join('\n'),
    after: list.map(hunk => (typeof hunk?.newText === 'string' ? hunk.newText : '')).join('\n'),
  };
}

/**
 * 写类工具在授权时要带的变更预览。只给「真能看见改了什么」的三类；
 * 其余（删除/移动/批量/撤销/命令）暂不构造——`undefined` 表示这张卡不带预览。
 */
function previewFor(name, args) {
  if (name === 'write_file') return writePreview(args);
  if (name === 'replace_in_file') return replacePreview(args);
  return undefined;
}

/** 授权：没有通道一律拒绝（宁可要不到工具，也不要静默放行写操作）。 */
async function requestAuthorization(deps, ctx, args, preview) {
  if (typeof ctx?.authorize !== 'function') {
    return { allowed: false, code: 'permission_unavailable', reason: '缺少授权通道（ctx.authorize），写/执行操作已拒绝' };
  }
  try {
    const verdict = await ctx.authorize(undefined, args, preview ? { preview } : {});
    if (verdict === true) return { allowed: true };
    if (verdict && typeof verdict === 'object') {
      const allowed = verdict.allowed === true || verdict.ok === true;
      return allowed ? { allowed: true } : {
        allowed: false,
        code: typeof verdict.code === 'string' && verdict.code ? verdict.code : 'approval_denied',
        reason: typeof verdict.reason === 'string' && verdict.reason ? verdict.reason : '未获授权',
      };
    }
    return { allowed: false, code: 'approval_denied', reason: '授权通道没有给出明确结论' };
  } catch (error) {
    return { allowed: false, code: 'approval_failed', reason: messageOf(error) };
  }
}

/** agent-tools 的返回值本身已经是 MCP 形状；这里只补 detail/diff，并把 isError 原样透传。 */
function adoptResult(raw, meta) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
    return { content: raw.content, ...(raw.isError === true ? { isError: true } : {}), ...meta };
  }
  if (typeof raw === 'string') return { ...textResult(raw), ...meta };
  try {
    return { ...textResult(JSON.stringify(raw ?? null)), ...meta };
  } catch {
    return { ...textResult(String(raw)), ...meta };
  }
}

/** 工具结果里的 error/message（agent-tools 用 JSON 文本回错误），用于拒绝/失败时的旁白。 */
function resultErrorOf(raw) {
  const text = Array.isArray(raw?.content) ? raw.content.find(part => part?.type === 'text')?.text : '';
  if (typeof text !== 'string' || !text) return '';
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object' && typeof payload.error === 'string') {
      return typeof payload.message === 'string' ? payload.message : payload.error;
    }
  } catch { /* 非 JSON 结果（正常返回值）不是错误 */ }
  return '';
}

/**
 * 包装一个 agent-tools 工具。
 * @param {object} deps
 * @param {string} name 工具名（与 agent-tools 的 tool.name 一致）
 */
function wrapTool(deps, name) {
  const spec = SPECS[name];
  const needsApproval = WRITE_TOOLS.has(name);
  return async function handler(rawArgs, rawCtx) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
    // 入参校验走技能层唯一的入口（electron/skills/input-schema.mjs）：未声明的键一律丢弃。
    const checked = validateInput({ type: 'object', properties: spec, additionalProperties: false }, args);
    if (!checked.ok) return invalidArgumentsResult(checked.errors);
    if (name === 'run_command') {
      const verdict = checkCommand(checked.value);
      if (!verdict.ok) return invalid(verdict.message);
    }
    const { tools, events } = openTools(deps, ctx);
    const tool = findTool(tools, name);
    if (!tool) return errorResult('tool_unavailable', `当前会话没有可用的 ${name}（项目文件夹或能力位不足）`);
    if (needsApproval) {
      const verdict = await requestAuthorization(deps, ctx, checked.value, previewFor(name, checked.value));
      if (verdict.allowed !== true) {
        notice(deps, ctx, `已拒绝 ${name}：${verdict.reason}`);
        return errorResult(verdict.code, verdict.reason);
      }
    }
    let raw;
    try {
      raw = await tool.execute(ctx.callId ?? name, checked.value, ctx.signal);
    } catch (error) {
      return errorResult(error?.code ?? 'tool_failed', messageOf(error));
    }
    const meta = metaOf(events);
    if (raw?.isError === true) {
      const reason = resultErrorOf(raw) || '操作失败';
      // 失败原因挂在**工具行自己**的 detail 上（前端那一行显示红色失败 + 原因）。
      // 不要另外发 notice：那会变成时间线底部一条与工具行重复的提示（用户明确要求去掉）。
      return { ...adoptResult(raw, {}), detail: reason.slice(0, DETAIL_CHARS) };
    }
    return adoptResult(raw, meta);
  };
}

/**
 * 把 `patch`（统一 diff）或 `oldText/newText`（精确替换）换成 hunk 列表。
 * 每个 hunk 单独交给 replace_in_file：这样 `.git` 保护、realpath 校验、审批与撤销记录
 * 全都还是 agent-tools 那同一份实现，本函数只做「diff 文本 → 既有工具入参」的形状转换。
 */
function parsePatch(args) {
  if (typeof args.patch === 'string' && args.patch.trim()) {
    const text = args.patch;
    if (text.length > MAX_PATCH_CHARS) {
      return { ok: false, message: `patch 超过 ${MAX_PATCH_CHARS} 字符上限（当前 ${text.length}）` };
    }
    const hunks = [];
    let current = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('@@')) {
        current = { removed: [], added: [] };
        hunks.push(current);
        continue;
      }
      if (/^(?:---|\+\+\+|diff|index) /.test(line)) continue;
      if (!current) continue;
      if (line.startsWith('-')) { current.removed.push(line.slice(1)); continue; }
      if (line.startsWith('+')) { current.added.push(line.slice(1)); continue; }
      // 上下文行与 "\ No newline at end of file" 不参与替换。
    }
    if (!hunks.length) return { ok: false, message: 'patch 里没有 @@ hunk 头，无法定位要替换的位置' };
    if (hunks.length > MAX_HUNKS) return { ok: false, message: `一次最多 ${MAX_HUNKS} 个 hunk（当前 ${hunks.length}）` };
    const list = [];
    for (const hunk of hunks) {
      const oldText = hunk.removed.join('\n');
      const newText = hunk.added.join('\n');
      if (!oldText) {
        return { ok: false, message: '有 hunk 不含以 "-" 开头的待替换原文（纯新增请用 write_file，或改用 oldText/newText）' };
      }
      if (oldText.length > MAX_HUNK_CHARS || newText.length > MAX_HUNK_CHARS) {
        return { ok: false, message: `单个 hunk 超过 ${MAX_HUNK_CHARS} 字符上限，请拆小或改用 oldText/newText` };
      }
      list.push({ oldText, newText });
    }
    return { ok: true, list };
  }
  const oldText = typeof args.oldText === 'string' ? args.oldText : '';
  if (!oldText) return { ok: false, message: 'patch 与 oldText 至少给一个' };
  if (oldText.length > MAX_HUNK_CHARS) {
    return { ok: false, message: `oldText 超过 ${MAX_HUNK_CHARS} 字符上限（当前 ${oldText.length}）` };
  }
  const newText = typeof args.newText === 'string' ? args.newText : '';
  if (newText.length > MAX_HUNK_CHARS) {
    return { ok: false, message: `newText 超过 ${MAX_HUNK_CHARS} 字符上限（当前 ${newText.length}）` };
  }
  if (args.all !== undefined && typeof args.all !== 'boolean') return { ok: false, message: 'all 必须是布尔值' };
  return { ok: true, list: [{ oldText, newText, ...(args.all === true ? { all: true } : {}) }] };
}

/** apply_patch：一次授权，然后按 hunk 顺序委托给 replace_in_file。 */
function wrapApplyPatch(deps) {
  return async function handler(rawArgs, rawCtx) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
    const path = typeof args.path === 'string' ? args.path : '';
    if (!path.trim()) return invalid('缺少必填参数 path');
    if (path.length > MAX_PATH) return invalid(`path 超过 ${MAX_PATH} 字符上限（当前 ${path.length}）`);
    const parsed = parsePatch(args);
    if (!parsed.ok) return invalid(parsed.message);

    const { tools, events } = openTools(deps, ctx);
    const replace = findTool(tools, 'replace_in_file');
    if (!replace) return errorResult('tool_unavailable', '当前会话没有可用的 replace_in_file（项目文件夹未授予写权限）');

    const verdict = await requestAuthorization(deps, ctx, { path }, patchPreview(args, parsed.list));
    if (verdict.allowed !== true) {
      notice(deps, ctx, `已拒绝 apply_patch：${verdict.reason}`);
      return errorResult(verdict.code, verdict.reason);
    }

    const applied = [];
    for (const hunk of parsed.list) {
      let raw;
      try {
        raw = await replace.execute(ctx.callId ?? 'apply_patch', { path, ...hunk }, ctx.signal);
      } catch (error) {
        return errorResult(error?.code ?? 'tool_failed', `第 ${applied.length + 1}/${parsed.list.length} 个 hunk 失败：${messageOf(error)}`);
      }
      if (raw?.isError === true) {
        const reason = resultErrorOf(raw) || '替换失败';
        // 不额外发 notice：下面这个错误结果本身就已经带上「第几个 hunk 失败 + 原因 + 可否撤销」，
        // 会显示在工具行的 detail 上。
        return errorResult(
          'patch_failed',
          applied.length
            ? `已应用 ${applied.length}/${parsed.list.length} 个 hunk，第 ${applied.length + 1} 个失败：${reason}（前面的改动已落盘，可用 undo_change 撤销）`
            : `第 1 个 hunk 失败：${reason}`,
        );
      }
      applied.push(hunk);
    }

    const meta = metaOf(events);
    const payload = {
      path,
      hunks: applied.length,
      replacements: applied.map(hunk => ({ oldText: hunk.oldText.slice(0, 200), newText: hunk.newText.slice(0, 200) })),
    };
    return { ...textResult(JSON.stringify(payload)), ...meta };
  };
}

/**
 * @param {{ projectTools?: object[]|Function, emit?: Function }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const source = deps?.projectTools;
  if (source === undefined || source === null || source === false) return {};
  let available = null;
  if (Array.isArray(source)) {
    available = source.filter(tool => tool && typeof tool.name === 'string' && typeof tool.execute === 'function')
      .map(tool => tool.name);
  } else if (typeof source === 'function') {
    // 探测一次「这一轮到底有哪些工具」：模型不该看见一个一调就报 tool_unavailable 的工具。
    try {
      const probe = source({ emit() {}, callId: undefined, signal: undefined });
      available = (Array.isArray(probe) ? probe : [])
        .filter(tool => tool && typeof tool.name === 'string' && typeof tool.execute === 'function')
        .map(tool => tool.name);
    } catch {
      return {};
    }
  }
  if (!available || !available.length) return {};

  const handlers = {};
  for (const name of available) {
    if (!SPECS[name]) continue; // agent-tools 将来新增的工具：先显式声明 schema，再自动生效
    handlers[name] = wrapTool(deps, name);
  }
  // apply_patch 是垫片：只要有 replace_in_file 就有实现。
  if (available.includes('replace_in_file')) handlers.apply_patch = wrapApplyPatch(deps);
  return handlers;
}
