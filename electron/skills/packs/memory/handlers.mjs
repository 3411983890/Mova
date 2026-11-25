/**
 * 负责：把长期记忆的既有实现包成技能 handler——参数校验（含 P1 的过滤维度）、
 *   调用 `deps.memorySearch({query, scope, limit, source, kind, after, before, origin, projectId,
 *   includeArchived}, signal)` 与它的 `readSource`、调用 `deps.memoryRuntime` 的
 *   saveMemory / updateMemory / supersedeMemory 落盘，写入前的疑似重复提示，并发出前端认的事件。
 * 不负责：检索排序/过滤/预算/脱敏（electron/services/agent-memory-search.cjs 的 filterHits）、
 *   去重相似度算法（electron/services/memory-dedupe.cjs）、存储与配额
 *   （electron/memory-store.cjs / memory-runtime.cjs）、开关判定（memoryEnabled）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-pack-handlers.test.mjs、
 *   tests/memory-lifecycle.test.mjs、tests/memory-dedupe.test.mjs、tests/memory-search-filters.test.mjs。
 *
 * 依赖键（缺哪个就少哪个工具，绝不抛）：
 *   memorySearch      —— 已适配的 `({query, scope, limit, source, ...filters}) => hits`；带 `.readSource`
 *                        才有回查工具
 *   memoryRuntime     —— 暴露 saveMemory / updateMemory / supersedeMemory 的 repository（或 memory-ipc
 *                        代理，代理上同名存在）；缺 saveMemory 就没有 memory_write，
 *                        缺 updateMemory 就没有 memory_update / memory_archive，
 *                        缺 supersedeMemory 就没有 memory_supersede（写记忆绝不在 handler 里自己拼 JSON 落盘）
 *   projectId / memoryScope.projectId、conversationId、messageId —— 写入时的归属上下文，可缺省
 *
 * 三条纪律：
 * 1) 写工具一律**先 ctx.authorize() 再落盘**：拿不到授权就零副作用返回，绝不「先写再问」。
 * 2) 拒绝路径连检索都不改变任何状态（只有只读的 memorySearch，没有副作用）。
 * 3) 归档 = status 'disabled'（软删除），与 memory-maintenance 的 plan.archive 同一口径：
 *    不新增字段、不做迁移，检索侧的 `status = 'active'` 过滤天然生效。
 */

import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';
import { formatMemoryHit } from '../../../services/agent-memory-search.cjs';
import { findDuplicates } from '../../../services/memory-dedupe.cjs';

const MAX_QUERY = 400;
const MAX_ID = 200;
const MAX_TEXT = 4_000;
const MAX_READ_LIMIT = 6_000;
const DEFAULT_READ_LIMIT = 4_000;
const MAX_PROJECT_ID = 500;
const MAX_REASON = 200;
const READ_MODES = ['message', 'around', 'conversation'];
const MEMORY_KINDS = ['fact', 'preference', 'decision', 'note'];
const MEMORY_ORIGINS = ['manual', 'automatic'];
const MAX_COUNT = 12;
/** 去重提示最多回几个候选（与 memory-dedupe 的上限一致，这里只决定检索取几条）。 */
const DEDUPE_CANDIDATES = 5;
/**
 * 重复提示里那句「接下来怎么办」：措辞固定，模型才会照着调另两个工具。
 * 这里只说清有哪些选择，不替模型做决定，也不自动改写/合并任何条目。
 */
const DEDUPE_HINT = '可以用 memory_update 覆盖这条记忆，或用 memory_supersede 替换它（旧条目会退役并保留历史链）';

function invalid(message) {
  return errorResult('invalid_arguments', message);
}

function emitOf(deps, ctx) {
  if (typeof ctx?.emit === 'function') return ctx.emit;
  if (typeof deps?.emit === 'function') return deps.emit;
  return null;
}

function push(deps, ctx, event) {
  const emit = emitOf(deps, ctx);
  if (!emit) return;
  try {
    emit(event);
  } catch { /* 事件发不出去不影响结果 */ }
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 时间参数归一（与 services/agent-memory-search.cjs 的 toEpochMs 同规则）：
 * 毫秒时间戳（数字/纯数字字符串）与 ISO 字符串都接受，其余是 null → invalid_arguments。
 * 本地再实现一份是因为 handler 要**在调用前**判定「非法值」，而不是等检索层静默吞掉。
 */
function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d{10,16}$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? number : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 两种 hits 形状都能收：已用 formatMemoryHit 格式化过的（带 original 对象）原样留下，
 * 否则交给同一个 formatMemoryHit——绝不在本文件里再写一份字段映射。
 * 归档命中（`archived === true`）要保住标记：否则模型无法区分「活跃记忆」与「已归档的历史」。
 */
function normalizeHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  if (hit.original !== undefined || hit.kind === 'history') return hit;
  const formatted = formatMemoryHit(hit);
  if (hit.archived === true) formatted.archived = true;
  if (typeof hit.updatedAt === 'string' && hit.updatedAt) formatted.updatedAt = hit.updatedAt;
  if (typeof hit.memoryKind === 'string' && hit.memoryKind) formatted.kind = hit.memoryKind;
  return formatted;
}

/** 仓储错误的用户可读说明（码 → 一句话）。认不出的码一律透传原码 + 原始消息。 */
function describeFailure(code, error) {
  const detail = typeof error?.message === 'string' && error.message ? error.message.slice(0, 200) : '';
  switch (code) {
    case 'not-found': return '这条记忆不存在（可能已被删除），先用 memory_search 拿最新 id。';
    case 'invalid-status': return '这条记忆已退役或已归档，不能再按这个方式修改。';
    case 'sensitive-content': return '这条内容看起来含密码/密钥/证件等敏感信息，已拒绝写入长期记忆。';
    case 'memory-limit': return '长期记忆条数已达上限，请先在设置里清理。';
    case 'key-conflict': return '同一作用域里已有同名 key 的活跃记忆，先合并再写。';
    default: return detail ? `长期记忆写入失败（${code}）：${detail}` : `长期记忆写入失败（${code}）`;
  }
}

/**
 * @param {{ memorySearch?: Function, memoryRuntime?: object, emit?: Function,
 *   projectId?: string|null, memoryScope?: object, conversationId?: string, messageId?: string }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const memorySearch = typeof deps?.memorySearch === 'function' ? deps.memorySearch : null;
  // 没有检索能力就没有记忆工具：不返回任何 handler，注册表会把对应工具剔掉。
  if (!memorySearch) return {};

  const runtime = deps?.memoryRuntime && typeof deps.memoryRuntime === 'object' ? deps.memoryRuntime : null;
  const saveMemory = runtime && typeof runtime.saveMemory === 'function'
    ? runtime.saveMemory.bind(runtime)
    : runtime && typeof runtime.save === 'function' ? runtime.save.bind(runtime) : null;
  const updateMemory = runtime && typeof runtime.updateMemory === 'function' ? runtime.updateMemory.bind(runtime) : null;
  const supersedeMemory = runtime && typeof runtime.supersedeMemory === 'function'
    ? runtime.supersedeMemory.bind(runtime) : null;
  const projectId = typeof deps?.projectId === 'string' && deps.projectId
    ? deps.projectId
    : (typeof deps?.memoryScope?.projectId === 'string' && deps.memoryScope.projectId ? deps.memoryScope.projectId : null);
  const conversationId = typeof deps?.conversationId === 'string' && deps.conversationId ? deps.conversationId : '';
  const messageId = typeof deps?.messageId === 'string' && deps.messageId ? deps.messageId : '';

  /**
   * 统一授权闸门：`ctx.authorize()` 先行，任何不确定（抛错 / 没通道 / 结论含糊）都算拒绝。
   * 返回 `{ allowed: true }` 或 `{ allowed: false, code, reason }`——调用方据此决定是否落盘。
   */
  async function authorizeWrite(ctx, args) {
    if (typeof ctx?.authorize !== 'function') {
      return { allowed: false, code: 'permission_unavailable', reason: '缺少授权通道（ctx.authorize），写记忆已拒绝' };
    }
    try {
      const raw = await ctx.authorize(undefined, args);
      if (raw === true) return { allowed: true };
      if (raw && typeof raw === 'object') {
        return raw.allowed === true || raw.ok === true
          ? { allowed: true }
          : { allowed: false, code: raw.code ?? 'approval_denied', reason: raw.reason ?? '未获授权' };
      }
      return { allowed: false, code: 'approval_denied', reason: '授权通道没有给出明确结论' };
    } catch (error) {
      return { allowed: false, code: 'approval_failed', reason: messageOf(error) };
    }
  }

  /** 拒绝时的一条旁白：三种写工具共用同一句话，前端不会因为工具不同而样式不一致。 */
  function pushDenied(ctx, verdict, action) {
    push(deps, ctx, { type: 'notice', tone: 'warn', text: `已拒绝${action}：${verdict.reason}`.slice(0, 300) });
  }

  /**
   * 写入前的疑似重复检索。**失败一律当“没有重复”**：去重只是提示，绝不能让一次正常写入
   * 因为检索不可用而失败（记忆检索依赖本地服务，慢/未就绪都是常态）。
   */
  async function duplicateCandidates(ctx, text) {
    try {
      const hits = await memorySearch({ query: text, scope: 'current', limit: DEDUPE_CANDIDATES, source: 'memory' }, ctx.signal);
      return findDuplicates(text, Array.isArray(hits) ? hits : []);
    } catch {
      return [];
    }
  }

  const handlers = {
    async memory_search(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return invalid('query 必填且不能为空');
      if (query.length > MAX_QUERY) return invalid(`query 超过 ${MAX_QUERY} 字符上限（当前 ${query.length}）`);
      if (args.scope !== undefined && !['current', 'global'].includes(args.scope)) {
        return invalid('scope 只能是 current / global');
      }
      if (args.source !== undefined && !['auto', 'memory', 'history'].includes(args.source)) {
        return invalid('source 只能是 auto / memory / history');
      }
      if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit))) {
        return invalid('limit 必须是数字');
      }
      // —— 以下五个过滤维度全部可选：不传时底层入参一个键都不多（行为与今天逐字一致）。
      if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
        return invalid(`kind 只能是 ${MEMORY_KINDS.join(' / ')}`);
      }
      if (args.origin !== undefined && !MEMORY_ORIGINS.includes(args.origin)) {
        return invalid(`origin 只能是 ${MEMORY_ORIGINS.join(' / ')}`);
      }
      let after;
      if (args.after !== undefined && args.after !== null && args.after !== '') {
        after = parseTime(args.after);
        if (after === null) return invalid('after 必须是毫秒时间戳或 ISO 日期时间（如 2026-11-01）');
      }
      let before;
      if (args.before !== undefined && args.before !== null && args.before !== '') {
        before = parseTime(args.before);
        if (before === null) return invalid('before 必须是毫秒时间戳或 ISO 日期时间（如 2026-11-30）');
      }
      if (after !== undefined && before !== undefined && after > before) {
        return invalid('after 不能晚于 before');
      }
      let filterProjectId;
      if (args.projectId !== undefined && args.projectId !== null && args.projectId !== '') {
        if (typeof args.projectId !== 'string' || !args.projectId.trim()) return invalid('projectId 必须是非空字符串');
        if (args.projectId.length > MAX_PROJECT_ID) return invalid(`projectId 超过 ${MAX_PROJECT_ID} 字符上限`);
        filterProjectId = args.projectId.trim();
      }
      if (args.includeArchived !== undefined && typeof args.includeArchived !== 'boolean') {
        return invalid('includeArchived 必须是 boolean');
      }
      const limit = clampInt(args.limit, 1, MAX_COUNT, 8);
      const id = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'memory_search';
      push(deps, ctx, { type: 'memory', id, query, status: 'running' });
      try {
        const hits = await memorySearch({
          query,
          scope: args.scope ?? 'current',
          limit,
          source: args.source ?? 'auto',
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(args.origin !== undefined ? { origin: args.origin } : {}),
          ...(filterProjectId !== undefined ? { projectId: filterProjectId } : {}),
          ...(args.includeArchived !== undefined ? { includeArchived: args.includeArchived } : {}),
        }, ctx.signal);
        const memories = (Array.isArray(hits) ? hits : []).map(normalizeHit).filter(Boolean);
        push(deps, ctx, { type: 'memory', id, query, status: 'done', count: memories.length });
        return textResult(JSON.stringify(memories));
      } catch (error) {
        const detail = typeof error?.message === 'string' && error.message ? error.message.slice(0, 200) : '无法搜索长期记忆';
        push(deps, ctx, { type: 'memory', id, query, status: 'error', detail });
        return errorResult('memory_search_failed', detail);
      }
    },
  };

  if (typeof memorySearch.readSource === 'function') {
    handlers.memory_read_source = async function memoryReadSource(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return invalid('id 必填（用 memory_search 返回的记忆 id）');
      if (id.length > MAX_ID) return invalid(`id 超过 ${MAX_ID} 字符上限`);
      if (args.mode !== undefined && !READ_MODES.includes(args.mode)) {
        return invalid(`mode 只能是 ${READ_MODES.join(' / ')}`);
      }
      if (args.offset !== undefined && (typeof args.offset !== 'number' || !Number.isFinite(args.offset))) {
        return invalid('offset 必须是数字');
      }
      if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit))) {
        return invalid('limit 必须是数字');
      }
      const callId = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'memory_read_source';
      const label = '查看记忆原文';
      push(deps, ctx, { type: 'tool', id: callId, name: 'memory_read_source', label, status: 'running' });
      try {
        const result = await memorySearch.readSource({
          id,
          mode: args.mode ?? 'message',
          offset: clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0),
          limit: clampInt(args.limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT),
        }, ctx.signal);
        const message = result?.ok === true
          ? ''
          : result?.code === 'invalid-range'
            ? '原文分页范围无效。'
            : '该记忆的原文未保存、已删除或超出当前记忆范围。';
        push(deps, ctx, {
          type: 'tool', id: callId, name: 'memory_read_source', label,
          status: result?.ok === true ? 'done' : 'error',
          ...(message ? { detail: message } : {}),
        });
        const payload = message ? { ...result, message } : result;
        return {
          ...textResult(JSON.stringify(payload ?? null)),
          ...(result?.ok === true ? {} : { isError: true }),
        };
      } catch (error) {
        const detail = '读取原文失败。';
        push(deps, ctx, { type: 'tool', id: callId, name: 'memory_read_source', label, status: 'error', detail });
        return errorResult('memory_read_failed', `${detail}${messageOf(error) ? `（${messageOf(error).slice(0, 200)}）` : ''}`);
      }
    };
  }

  if (saveMemory) {
    handlers.memory_write = async function memoryWrite(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return invalid('text 必填且不能为空');
      if (text.length > MAX_TEXT) return invalid(`text 超过 ${MAX_TEXT} 字符上限（当前 ${text.length}）`);
      if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
        return invalid(`kind 只能是 ${MEMORY_KINDS.join(' / ')}`);
      }
      const callId = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'memory_write';
      const label = '写入长期记忆';
      // 去重提示走**只读**检索，放在审批之前：命中重复就不该再弹一次「要不要写入」，
      // 用户点了允许却什么都没写，比少弹一次卡更糟。
      const duplicates = await duplicateCandidates(ctx, text);
      if (duplicates.length) {
        const detail = `疑似重复，未写入：与 ${duplicates[0].id} 的相似度为 ${duplicates[0].similarity}；${DEDUPE_HINT}`;
        push(deps, ctx, { type: 'tool', id: callId, name: 'memory_write', label, status: 'done', detail: detail.slice(0, 300) });
        return textResult(JSON.stringify({
          ok: false,
          code: 'duplicate-suspected',
          duplicate: true,
          saved: false,
          candidates: duplicates,
          hint: DEDUPE_HINT,
          detail,
        }));
      }
      // 先要授权，再落盘：拿不到授权就零副作用返回（绝不「先写再问」）。
      const verdict = await authorizeWrite(ctx, args);
      if (verdict.allowed !== true) {
        pushDenied(ctx, verdict, '写入长期记忆');
        return errorResult(verdict.code, verdict.reason);
      }
      try {
        const saved = await saveMemory({
          text,
          kind: args.kind ?? 'fact',
          projectId,
          source: 'user',
          ...(conversationId ? { conversationId } : {}),
          ...(messageId ? { messageId } : {}),
        });
        return textResult(JSON.stringify({
          ok: true,
          id: typeof saved?.id === 'string' ? saved.id : null,
          kind: typeof saved?.kind === 'string' ? saved.kind : (args.kind ?? 'fact'),
          ...(typeof saved?.projectId === 'string' ? { projectId: saved.projectId } : {}),
        }));
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code ? error.code : 'memory_write_failed';
        const detail = code === 'sensitive-content'
          ? '这条内容看起来含密码/密钥/证件等敏感信息，已拒绝写入长期记忆。'
          : code === 'memory-limit'
            ? '长期记忆条数已达上限，请先在设置里清理。'
            : `写入长期记忆失败：${messageOf(error)}`;
        push(deps, ctx, { type: 'notice', tone: 'warn', text: detail.slice(0, 300) });
        return errorResult(code, detail);
      }
    };
  }

  if (updateMemory) {
    handlers.memory_update = async function memoryUpdate(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return invalid('id 必填（用 memory_search 返回的记忆 id）');
      if (id.length > MAX_ID) return invalid(`id 超过 ${MAX_ID} 字符上限`);
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return invalid('text 必填且不能为空');
      if (text.length > MAX_TEXT) return invalid(`text 超过 ${MAX_TEXT} 字符上限（当前 ${text.length}）`);
      // 先行授权：拒绝时一次落盘都不发生。
      const verdict = await authorizeWrite(ctx, args);
      if (verdict.allowed !== true) {
        pushDenied(ctx, verdict, '更新长期记忆');
        return errorResult(verdict.code, verdict.reason);
      }
      const callId = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'memory_update';
      const label = '更新长期记忆';
      try {
        const updated = await updateMemory(id, { text });
        push(deps, ctx, { type: 'tool', id: callId, name: 'memory_update', label, status: 'done', detail: `已更新记忆 ${id}` });
        return textResult(JSON.stringify({
          ok: true,
          id,
          kind: typeof updated?.kind === 'string' ? updated.kind : null,
          version: Number.isInteger(updated?.version) ? updated.version : null,
          updatedAt: typeof updated?.updatedAt === 'string' ? updated.updatedAt : null,
          text: typeof updated?.text === 'string' ? updated.text : text,
        }));
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code ? error.code : 'memory_update_failed';
        const detail = describeFailure(code, error);
        push(deps, ctx, { type: 'notice', tone: 'warn', text: detail.slice(0, 300) });
        return errorResult(code, detail);
      }
    };
  }

  if (supersedeMemory) {
    handlers.memory_supersede = async function memorySupersede(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return invalid('id 必填（要替代的那条记忆 id）');
      if (id.length > MAX_ID) return invalid(`id 超过 ${MAX_ID} 字符上限`);
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return invalid('text 必填且不能为空');
      if (text.length > MAX_TEXT) return invalid(`text 超过 ${MAX_TEXT} 字符上限（当前 ${text.length}）`);
      if (args.kind !== undefined && !MEMORY_KINDS.includes(args.kind)) {
        return invalid(`kind 只能是 ${MEMORY_KINDS.join(' / ')}`);
      }
      const verdict = await authorizeWrite(ctx, args);
      if (verdict.allowed !== true) {
        pushDenied(ctx, verdict, '替代长期记忆');
        return errorResult(verdict.code, verdict.reason);
      }
      const callId = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'memory_supersede';
      const label = '替代长期记忆';
      try {
        const replacement = await supersedeMemory({ id, text, ...(args.kind !== undefined ? { kind: args.kind } : {}) });
        const newId = typeof replacement?.id === 'string' ? replacement.id : null;
        if (!newId || newId === id) {
          const detail = '替代未生效：新旧记忆相同或写入被拒，原记忆保持不变。';
          push(deps, ctx, { type: 'notice', tone: 'warn', text: detail });
          return errorResult('memory_supersede_failed', detail);
        }
        push(deps, ctx, {
          type: 'tool', id: callId, name: 'memory_supersede', label, status: 'done',
          detail: `已用 ${newId.slice(0, 8)} 替代 ${id.slice(0, 8)}`,
        });
        return textResult(JSON.stringify({
          ok: true,
          id: newId,
          supersededId: id,
          kind: typeof replacement?.kind === 'string' ? replacement.kind : (args.kind ?? null),
          version: Number.isInteger(replacement?.version) ? replacement.version : null,
          supersedes: Array.isArray(replacement?.supersedes) ? replacement.supersedes : [id],
        }));
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code ? error.code : 'memory_supersede_failed';
        const detail = code === 'invalid-input'
          ? '新旧正文完全相同，没有可替代的内容：要改措辞请用 memory_update。'
          : describeFailure(code, error);
        push(deps, ctx, { type: 'notice', tone: 'warn', text: detail.slice(0, 300) });
        return errorResult(code, detail);
      }
    };
  }

  if (updateMemory) {
    handlers.memory_archive = async function memoryArchive(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) return invalid('id 必填（要归档的记忆 id）');
      if (id.length > MAX_ID) return invalid(`id 超过 ${MAX_ID} 字符上限`);
      if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.length > MAX_REASON)) {
        return invalid(`reason 只能是 ${MAX_REASON} 字符以内的字符串`);
      }
      const verdict = await authorizeWrite(ctx, args);
      if (verdict.allowed !== true) {
        pushDenied(ctx, verdict, '归档长期记忆');
        return errorResult(verdict.code, verdict.reason);
      }
      const callId = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'memory_archive';
      const label = '归档长期记忆';
      try {
        // 归档 = 软删除：落盘形态是既有 status 'disabled'（数据库 CHECK 本来就允许），
        // 检索与自动注入的 `status = 'active'` 过滤因此天然生效，不需要新字段/迁移。
        const updated = await updateMemory(id, { status: 'disabled' });
        push(deps, ctx, {
          type: 'tool', id: callId, name: 'memory_archive', label, status: 'done',
          detail: `已归档记忆 ${id}${typeof args.reason === 'string' && args.reason ? `（${args.reason.slice(0, 60)}）` : ''}`,
        });
        return textResult(JSON.stringify({
          ok: true,
          id,
          status: 'archived',
          archived: true,
          text: typeof updated?.text === 'string' ? updated.text : null,
          updatedAt: typeof updated?.updatedAt === 'string' ? updated.updatedAt : null,
        }));
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code ? error.code : 'memory_archive_failed';
        const detail = describeFailure(code, error);
        push(deps, ctx, { type: 'notice', tone: 'warn', text: detail.slice(0, 300) });
        return errorResult(code, detail);
      }
    };
  }

  return handlers;
}
