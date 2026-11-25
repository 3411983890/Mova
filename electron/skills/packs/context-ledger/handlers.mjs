/**
 * 负责：把 `electron/context/tools.mjs` 的 createContextTools 产出的 3 个工具包成技能 handler——
 *   参数类型校验、把 `ctx.signal` / `ctx.emit` 交给既有实现、把结果原样透传。
 * 不负责：台账口径、压缩算法、摘要生成、待生效队列（全在 electron/context/**）、
 *   工具文案与截断上限（那三个工具自己负责，本文件不再写第二份）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-pack-handlers.test.mjs。
 *
 * 依赖键：`contextTools` —— `createContextTools({ key, ledgerFor, pending, emit, now, contextWindow })`
 * 的返回值 `{ definitions, handlers }`。缺它（或它缺某个 handler）就不暴露对应工具，绝不抛。
 */

import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';

/** 上下文工具的规范名（与 electron/context/tools.mjs 的 definitions 一致）。 */
const TOOL_NAMES = Object.freeze(['context_status', 'context_compact', 'context_read']);
const MIN_KEEP_RECENT = 4;
const MAX_KEEP_RECENT = 30;
const MAX_READ_LIMIT = 6_000;
const MAX_REASON = 200;

function invalid(message) {
  return errorResult('invalid_arguments', message);
}

function isInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * @param {{ contextTools?: { definitions?: object[], handlers?: Record<string, Function> } }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const tools = deps?.contextTools;
  const source = tools && typeof tools === 'object' ? tools.handlers : null;
  if (!source || typeof source !== 'object') return {};

  const handlers = {};
  for (const name of TOOL_NAMES) {
    const run = source[name];
    if (typeof run !== 'function') continue; // 缺实现不暴露（延续 mcp/tools.mjs 的原则）
    handlers[name] = async function contextHandler(rawArgs, rawCtx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
      const checked = check(name, args);
      if (!checked.ok) return invalid(checked.message);
      try {
        // 既有实现自己会把异常收敛成 isError 文本，这里只需再兜一层（谁都不该让主循环吃到 throw）。
        const result = await run(checked.args, { signal: ctx.signal, emit: ctx.emit });
        if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
        if (typeof result === 'string') return textResult(result);
        try {
          return textResult(JSON.stringify(result ?? null));
        } catch {
          return textResult(String(result));
        }
      } catch (error) {
        return errorResult('tool_failed', `${name} 执行失败：${messageOf(error)}`);
      }
    };
  }
  return handlers;
}

/** 逐字段校验：只做类型与范围，语义（能不能压、范围是否有效）留给 context/tools.mjs 给提示。 */
function check(name, args) {
  if (name === 'context_status') {
    const extra = Object.keys(args);
    if (extra.length) return { ok: false, message: `context_status 不接受参数（收到 ${extra.join(', ')}）` };
    return { ok: true, args: {} };
  }
  if (name === 'context_compact') {
    const out = {};
    if (args.keepRecent !== undefined) {
      if (!isInteger(args.keepRecent)) return { ok: false, message: 'keepRecent 必须是整数' };
      if (args.keepRecent < MIN_KEEP_RECENT || args.keepRecent > MAX_KEEP_RECENT) {
        return { ok: false, message: `keepRecent 必须在 ${MIN_KEEP_RECENT}–${MAX_KEEP_RECENT} 之间` };
      }
      out.keepRecent = args.keepRecent;
    }
    if (args.reason !== undefined) {
      if (typeof args.reason !== 'string') return { ok: false, message: 'reason 必须是字符串' };
      if (args.reason.length > MAX_REASON) {
        return { ok: false, message: `reason 超过 ${MAX_REASON} 字符上限（当前 ${args.reason.length}）` };
      }
      if (args.reason.trim()) out.reason = args.reason;
    }
    return { ok: true, args: out };
  }
  // context_read
  const out = {};
  if (args.offset !== undefined) {
    if (!isInteger(args.offset) || args.offset < 0) return { ok: false, message: 'offset 必须是非负整数' };
    out.offset = args.offset;
  }
  if (args.limit !== undefined) {
    if (!isInteger(args.limit) || args.limit < 1) return { ok: false, message: 'limit 必须是 ≥1 的整数' };
    if (args.limit > MAX_READ_LIMIT) {
      return { ok: false, message: `limit 不能超过 ${MAX_READ_LIMIT}` };
    }
    out.limit = args.limit;
  }
  return { ok: true, args: out };
}
