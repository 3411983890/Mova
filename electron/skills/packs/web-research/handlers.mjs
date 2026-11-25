/**
 * 负责：把 `electron/search/**` 已有的检索能力包成 4 个技能 handler——参数校验、调用
 *   `searchService.search` / `searchService.read`（或已适配的 `search(query, options)`）、
 *   用既有排版/校验模块生成模型可见文本，并发出前端认的 `{type:'search'}` / `{type:'read'}` 事件。
 * 不负责：多源并发、去重、抓正文、预算、缓存（全在 `electron/search/**`），重试与垂直索引路由
 *   （仍在 chat-agent.mjs 的 createSearchTools；本包是它的瘦身版，见报告「偏离」）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-pack-handlers.test.mjs。
 *
 * 依赖键（缺哪个就少哪个工具，绝不抛）：
 *   search        —— 已适配的 `(query, options) => rows`（硬依赖，manifest 的 dependencies）
 *   searchService —— `{ search({queries, options, signal}), read({url, question, signal}), … }`
 *   searchOptions —— 用户检索设置（maxResults / readCount / recency / language / zone / markdown）
 *   searchKey     —— legacy（AnySearch）分支需要的 key
 */

import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';
import { describeIssues, evidenceText, validateCitations } from '../../../search/citation.cjs';
import { formatEvidence, toSourceSummary } from '../../../search/pack.cjs';

/** 单次展示的来源条数上限：与 chat-agent.mjs 的 SEARCH_MAX_SOURCES 一致。 */
const MAX_SOURCES = 10;
const MAX_QUERY_CHARS = 400;
const READ_DEFAULT_CHARS = 8_000;
const READ_MAX_CHARS = 20_000;
/** 引用校验保留的证据总量：跨批次共用，防止长会话无限增长。 */
const EVIDENCE_MAX_ITEMS = 40;

function invalid(message) {
  return errorResult('invalid_arguments', message);
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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
  } catch { /* 事件发不出去不影响检索结果 */ }
}

/** 模型给的查询：单条 query 与 queries 合并、去重、限长、限条数。 */
function queriesOf(args, maxQueries) {
  const raw = [
    ...(typeof args.query === 'string' ? [args.query] : []),
    ...(Array.isArray(args.queries) ? args.queries : []),
  ];
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, MAX_QUERY_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
    if (list.length >= maxQueries) break;
  }
  return list;
}

function failureText(error) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return message ? message.slice(0, 200) : '检索失败，请稍后再试。';
}

/**
 * @param {{ search?: Function, searchService?: object, searchOptions?: object, searchKey?: string,
 *   emit?: Function }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  const search = typeof deps?.search === 'function' ? deps.search : null;
  const service = deps?.searchService && typeof deps.searchService === 'object' ? deps.searchService : null;
  const settings = deps?.searchOptions && typeof deps.searchOptions === 'object' ? deps.searchOptions : {};
  const key = typeof deps?.searchKey === 'string' ? deps.searchKey : '';
  const serviceSearch = service && typeof service.search === 'function' ? service.search.bind(service) : null;
  const serviceRead = service && typeof service.read === 'function' ? service.read.bind(service) : null;
  // 检索能力一条都没有：整个包不暴露（不给模型一个一调就报错的假接口）。
  if (!serviceSearch && !search) return {};

  const maxQueries = clampInt(settings.maxQueries, 1, 5, 5);
  // 与 chat-agent.mjs 的 serviceCallOptions 同口径：只取服务真认识的键。
  const baseOptions = () => {
    const options = { maxResults: clampInt(settings.maxResults, 1, 10, 10) };
    if (settings.readCount !== undefined && settings.readCount !== null) {
      options.readCount = clampInt(settings.readCount, 0, 8, 3);
    }
    if (typeof settings.recency === 'string' && settings.recency) options.recency = settings.recency;
    const language = settings.lang || settings.language;
    if (typeof language === 'string' && language) options.language = language;
    if (typeof settings.zone === 'string' && settings.zone) options.zone = settings.zone;
    if (settings.markdown === false) options.markdown = false;
    return options;
  };

  /** 证据批次：verify_citations 只核对本会话真的返回过的来源，不做任何外呼。 */
  const batches = [];
  let evidenceCount = 0;
  const remember = items => {
    const batch = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      if (!url || seen.has(url)) continue;
      if (evidenceCount >= EVIDENCE_MAX_ITEMS) break;
      seen.add(url);
      batch.push(item);
      evidenceCount += 1;
    }
    if (batch.length) batches.push(batch);
  };

  /**
   * 跑一次检索，返回统一形状。
   * 走 service 时用 evidence（已读正文）优先、退回 rows；两处条数上限一致。
   */
  async function runSearch(queries, options, signal) {
    if (serviceSearch) {
      const result = await serviceSearch({ queries, options, signal });
      const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      return {
        shown: (evidence.length ? evidence : rows).slice(0, MAX_SOURCES),
        meta: result?.meta && typeof result.meta === 'object' ? result.meta : {},
      };
    }
    // legacy（AnySearch）：单查询、返回 {url, title, snippet}，条数由它自己封顶。
    const rows = await search(key, queries[0], signal);
    return { shown: (Array.isArray(rows) ? rows : []).slice(0, MAX_SOURCES), meta: {} };
  }

  async function webSearch(rawArgs, rawCtx) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
    if (args.recency !== undefined && !['any', 'month', 'year'].includes(args.recency)) {
      return invalid('recency 只能是 any / month / year');
    }
    if (args.lang !== undefined && (typeof args.lang !== 'string' || args.lang.length > 40)) {
      return invalid('lang 必须是 ≤40 字符的字符串');
    }
    if (args.maxResults !== undefined) {
      if (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > 10) {
        return invalid('maxResults 必须是 1–10 的整数');
      }
    }
    if (args.queries !== undefined && !Array.isArray(args.queries)) {
      return invalid('queries 必须是字符串数组');
    }
    const queries = queriesOf(args, maxQueries);
    const id = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'web_search';
    push(deps, ctx, { type: 'search', id, queries, status: 'running' });
    if (!queries.length) {
      const detail = '请提供至少一个搜索词（query 或 queries）。';
      push(deps, ctx, { type: 'search', id, queries, status: 'error', detail });
      return invalid(detail);
    }
    const options = baseOptions();
    if (args.maxResults !== undefined) options.maxResults = clampInt(args.maxResults, 1, 10, options.maxResults);
    if (['any', 'month', 'year'].includes(args.recency)) options.recency = args.recency;
    if (typeof args.lang === 'string' && args.lang.trim()) options.language = args.lang.trim().slice(0, 40);
    try {
      const { shown, meta } = await runSearch(queries, options, ctx.signal);
      const sources = shown.map(row => toSourceSummary(row));
      const merged = { ...meta, queries };
      remember(shown);
      push(deps, ctx, { type: 'search', id, queries, status: 'done', sources, meta });
      return textResult(formatEvidence(shown, merged));
    } catch (error) {
      const detail = failureText(error);
      push(deps, ctx, { type: 'search', id, queries, status: 'error', detail });
      return errorResult('search_failed', detail);
    }
  }

  async function webRead(rawArgs, rawCtx) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url || url.length > 2_000) return invalid('url 必填，且不超过 2000 字符');
    if (!/^https?:\/\//i.test(url)) return invalid('url 只支持 http/https 链接');
    if (args.question !== undefined && (typeof args.question !== 'string' || args.question.length > 400)) {
      return invalid('question 必须是 ≤400 字符的字符串');
    }
    if (args.maxChars !== undefined) {
      if (!Number.isInteger(args.maxChars) || args.maxChars < 500 || args.maxChars > READ_MAX_CHARS) {
        return invalid(`maxChars 必须是 500–${READ_MAX_CHARS} 的整数`);
      }
    }
    const maxChars = clampInt(args.maxChars, 500, READ_MAX_CHARS, READ_DEFAULT_CHARS);
    const id = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'web_read';
    push(deps, ctx, { type: 'read', id, url, status: 'running' });
    try {
      const evidence = await serviceRead({ url, question: args.question ?? '', signal: ctx.signal });
      const body = evidenceText(evidence);
      const shown = body.length > maxChars
        ? `${body.slice(0, maxChars)}\n…[已截断：原文 ${body.length} 字符，仅保留前 ${maxChars} 字符]`
        : body;
      const title = typeof evidence?.title === 'string' ? evidence.title.slice(0, 120) : '';
      remember([evidence]);
      push(deps, ctx, {
        type: 'read', id, url: typeof evidence?.url === 'string' && evidence.url ? evidence.url : url,
        status: 'done', title, chars: shown.length,
      });
      const head = [title || url, typeof evidence?.url === 'string' && evidence.url && evidence.url !== url ? evidence.url : '']
        .filter(Boolean).join('\n');
      return textResult(`${head}\n\n${shown || '（没有取到正文）'}`);
    } catch (error) {
      const detail = failureText(error);
      push(deps, ctx, { type: 'read', id, url, status: 'error', detail });
      return errorResult('read_failed', detail);
    }
  }

  async function webResearch(rawArgs, rawCtx) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    if (!serviceSearch) return errorResult('tool_unavailable', '当前会话没有多源检索服务，请改用 web_search。');
    const ctx = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
    const question = typeof args.question === 'string' ? args.question.trim().slice(0, MAX_QUERY_CHARS) : '';
    if (!question) return invalid('question 必填');
    if (args.readCount !== undefined) {
      if (!Number.isInteger(args.readCount) || args.readCount < 0 || args.readCount > 8) {
        return invalid('readCount 必须是 0–8 的整数');
      }
    }
    if (args.queries !== undefined && !Array.isArray(args.queries)) {
      return invalid('queries 必须是字符串数组');
    }
    const given = queriesOf({ queries: Array.isArray(args.queries) ? args.queries : [] }, maxQueries);
    const queries = given.length ? given : [question];
    const id = typeof ctx.callId === 'string' && ctx.callId ? ctx.callId : 'web_research';
    push(deps, ctx, { type: 'search', id, queries, status: 'running' });
    const options = { ...baseOptions(), readCount: clampInt(args.readCount, 0, 8, 6) };
    try {
      const { shown, meta } = await runSearch(queries, options, ctx.signal);
      const readDone = Number.isFinite(Number(meta?.read)) ? Math.max(0, Math.floor(Number(meta.read))) : 0;
      const sources = shown.map(row => toSourceSummary(row));
      const merged = { ...meta, queries, note: `已自动阅读 ${readDone} 页` };
      remember(shown);
      push(deps, ctx, { type: 'search', id, queries, status: 'done', sources, meta: merged });
      return textResult(formatEvidence(shown, merged));
    } catch (error) {
      const detail = failureText(error);
      push(deps, ctx, { type: 'search', id, queries, status: 'error', detail });
      return errorResult('search_failed', detail);
    }
  }

  async function verifyCitations(rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    if (typeof args.answer !== 'string' || !args.answer.trim()) return invalid('answer 必填');
    if (args.answer.length > 20_000) return invalid(`answer 超过 20000 字符上限（当前 ${args.answer.length}）`);
    if (!batches.length) {
      return errorResult('no_evidence', '引用校验：本轮还没有任何证据，请先 web_search / web_research / web_read，再标注 [n]。');
    }
    try {
      const result = validateCitations(args.answer, batches);
      if (!result.total) {
        return textResult('引用校验：答案里没有 [n] 形式的引用；使用外部来源时请补上编号。');
      }
      if (result.ok) return textResult(`引用校验：${result.total} 处引用，尽数可核验。`);
      return {
        ...textResult(describeIssues(result)),
        ...(result.missing.length ? { isError: true } : {}),
      };
    } catch (error) {
      return errorResult('tool_failed', `引用校验失败：${messageOf(error)}`);
    }
  }

  const handlers = {
    web_search: webSearch,
    verify_citations: verifyCitations,
  };
  if (serviceSearch) handlers.web_research = webResearch;
  // 没有正文读取能力（或根本没注入 service）时 web_read 不暴露：否则每条候选都会带「读取失败」。
  const canRead = () => {
    if (!serviceRead) return false;
    if (typeof service.hasExtract !== 'function') return true;
    try {
      return service.hasExtract() === true;
    } catch {
      return false;
    }
  };
  if (canRead()) handlers.web_read = webRead;
  return handlers;
}
