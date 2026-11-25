/**
 * 结构化 logger：级别过滤 → 造记录 → 脱敏 → 交给 sink。
 *
 * 这个模块不认识文件、不认识 Electron，只认「一条记录最终会被谁接走」。
 * 这样测试可以塞一个数组当 sink，把全部行为断言死在纯内存里。
 *
 * 关键约定：
 * - 记录形状固定为 `{ t, level, scope, msg, ...data }`，t 是带本地时区偏移的 ISO8601
 *   （用户看日志时不需要再换算时区，排查耗时也不用猜 DST）。
 * - warn 及以上永远写：调低 MOVA_LOG_LEVEL 是为了少噪音，不是为了把事故现场藏起来。
 * - 脱敏在 emit 里做，且 logger 自身永不抛异常：日志写不进去是小事，把调用方带崩是大事。
 */
import { redact } from './redact.mjs';

/** 级别从轻到重；数字越大越严重。 */
export const LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const LEVEL_INDEX = new Map(LEVELS.map((name, index) => [name, index]));
const WARN_INDEX = LEVEL_INDEX.get('warn');
const DEFAULT_LEVEL = 'info';

/** 默认 flush 上限：退出流程最多等这么久，写不完就认了，绝不能卡住关窗。 */
export const DEFAULT_FLUSH_TIMEOUT_MS = 1500;

/** 核心字段：data 里同名字段一律忽略，防止 payload 伪造 level/scope。 */
const CORE_FIELDS = Object.freeze(['t', 'level', 'scope', 'msg']);

/** 级别名归一化：不认识的一律按 info，避免拼错一个字母就静默丢日志。 */
export function normalizeLevel(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return LEVEL_INDEX.has(key) ? key : DEFAULT_LEVEL;
}

/** 环境变量覆盖（MOVA_LOG_LEVEL）；空白值当没写。 */
export function resolveLevel(env = {}) {
  const raw = env?.MOVA_LOG_LEVEL;
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_LEVEL;
  return normalizeLevel(raw);
}

/**
 * 这条记录该不该写。
 *
 * 为什么把 warn 阈值单独拎出来：默认 info 时 trace/debug 被滤掉是降噪，
 * 但如果用户某天把级别设成 fatal，卡顿/慢 IPC 这些 warn 也会消失——那正是最需要的东西。
 */
export function shouldWrite(level, threshold = DEFAULT_LEVEL) {
  const index = LEVEL_INDEX.get(normalizeLevel(level));
  if (index === undefined) return false;
  return index >= LEVEL_INDEX.get(normalizeLevel(threshold)) || index >= WARN_INDEX;
}

/** 本地时间 + 显式偏移：`2026-01-02T03:04:05.678+08:00`。 */
export function formatLocalIso(date = new Date()) {
  const pad = (value, width = 2) => String(Math.abs(value)).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    'T',
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
  ].join('');
}

/** 毫秒保留一位小数：span 里 0.30000000000000004 这种浮点尾数只会干扰阅读。 */
function roundMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10) / 10;
}

/**
 * 把 data 归一成 plain object。
 * 允许 `logger.info('msg')`、`logger.info('msg', 'text')`、`logger.info('msg', { k: 1 })`，
 * 也允许直接传 Error（`logger.error(err)` 这种写法在调用点很常见）。
 */
function normalizeData(data) {
  if (data === undefined || data === null) return null;
  if (data instanceof Error) return { error: data };
  if (typeof data === 'string') return { detail: data };
  if (Array.isArray(data)) return { detail: data };
  if (typeof data === 'object') return data;
  return { detail: data };
}

/** sink 可能是函数，也可能是 `{ write(record), flush() }`（文件 sink 就是后者）。 */
function makeWriter(sink) {
  if (typeof sink === 'function') return sink;
  if (sink && typeof sink.write === 'function') return record => sink.write(record);
  return null;
}

/**
 * 由 state + scope 造 logger。
 *
 * 为什么用「state 对象 + 闭包」而不是 class：child/withScope 只是换一个 scope 字符串，
 * 共享同一份 state 才能保证 level、phase、sink 全树一致（否则 markPhase 的结论会分裂）。
 */
function buildLogger(state, scope) {
  function emit(levelName, rawMsg, rawData) {
    try {
      const name = normalizeLevel(levelName);
      if (!shouldWrite(name, state.level)) return false;

      const record = {
        t: formatLocalIso(new Date(state.now())),
        level: name,
        scope,
        msg: rawMsg instanceof Error ? rawMsg.message : String(rawMsg ?? ''),
      };
      const data = normalizeData(rawData);
      if (data) {
        const safe = redact(data);
        if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
          for (const key of Object.keys(safe)) {
            if (CORE_FIELDS.includes(key)) continue;
            record[key] = safe[key];
          }
        } else if (safe !== undefined) {
          record.detail = safe;
        }
      }

      if (!state.write) return true; // 没有 sink（未安装）时什么也不做，但语义上「这条被接受了」。
      try {
        state.write(record);
      } catch {
        state.dropped += 1;
      }
      return true;
    } catch {
      // 记录构造失败（含脱敏里的意外）也只能吞掉：日志系统不能反向打断业务。
      return false;
    }
  }

  return {
    scope,
    get level() {
      return state.level;
    },
    set level(value) {
      state.level = normalizeLevel(value);
    },
    log(levelName, msg, data) {
      return emit(levelName, msg, data);
    },
    trace(msg, data) {
      return emit('trace', msg, data);
    },
    debug(msg, data) {
      return emit('debug', msg, data);
    },
    info(msg, data) {
      return emit('info', msg, data);
    },
    warn(msg, data) {
      return emit('warn', msg, data);
    },
    error(msg, data) {
      return emit('error', msg, data);
    },
    fatal(msg, data) {
      return emit('fatal', msg, data);
    },
    /** `subscription` + `login` → `subscription:login`。 */
    child(suffix) {
      const tail = String(suffix ?? '').trim();
      return buildLogger(state, tail ? `${scope}:${tail}` : scope);
    },
    /** 换掉整段 scope：`getLogger('subscription')` 要的是干净 scope，不是 `app:subscription`。 */
    withScope(nextScope) {
      const name = String(nextScope ?? '').trim();
      return buildLogger(state, name || scope);
    },
    /**
     * 记录「现在正在做什么」；看门狗抓到 drift 时会把最近一次 phase 一起写进日志。
     * 同时按 debug 打一条，方便回放「卡在哪一步」的时间线。
     */
    markPhase(phase) {
      const value = typeof phase === 'string' && phase.trim().length > 0 ? phase.trim() : null;
      state.phase = value;
      emit('debug', 'phase', { phase: value });
      return value;
    },
    getPhase() {
      return state.phase;
    },
    /**
     * 计时一段异步逻辑：成功记 info，失败记 error 后原样抛出。
     * 失败必须抛同一个 error 实例：调用方可能还在 catch 里读 error.code 做分支。
     */
    async span(name, fn) {
      const started = state.now();
      try {
        const result = await fn();
        emit('info', name, { durationMs: roundMs(state.now() - started), ok: true });
        return result;
      } catch (error) {
        emit('error', name, { durationMs: roundMs(state.now() - started), ok: false, error });
        throw error;
      }
    },
    /** 退出前尽力写完；有超时上限，写不完也返回，不阻塞关窗。 */
    async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
      const target = state.sink;
      if (!target || typeof target.flush !== 'function') return true;
      try {
        return (await target.flush(timeoutMs)) !== false;
      } catch {
        return false;
      }
    },
    /** 安装层/测试用的内部视图。 */
    state() {
      return state;
    },
  };
}

/**
 * 建一个 logger。
 *
 * @param {{
 *   scope?: string,
 *   sink?: ((record: object) => void) | { write: (record: object) => void, flush?: (ms?: number) => Promise<unknown> } | null,
 *   level?: string,
 *   now?: () => number,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 */
export function createLogger({ scope = 'app', sink = null, level, now = () => Date.now(), env } = {}) {
  const state = {
    sink,
    write: makeWriter(sink),
    level: level ? normalizeLevel(level) : resolveLevel(env ?? (typeof process !== 'undefined' ? process.env : {})),
    phase: null,
    now,
    dropped: 0,
  };
  return buildLogger(state, scope);
}

/**
 * 未安装时的空实现：子模块可以先 `import { getLogger }` 拿到 logger 再等安装。
 * 注意 span 仍然会执行 fn —— 空实现只吞日志，不吞业务。
 */
export function createNoopLogger(scope = 'app') {
  return {
    scope,
    level: 'silent',
    log() {
      return false;
    },
    trace() {
      return false;
    },
    debug() {
      return false;
    },
    info() {
      return false;
    },
    warn() {
      return false;
    },
    error() {
      return false;
    },
    fatal() {
      return false;
    },
    child(suffix) {
      const tail = String(suffix ?? '').trim();
      return createNoopLogger(tail ? `${scope}:${tail}` : scope);
    },
    withScope(next) {
      return createNoopLogger(String(next ?? '').trim() || scope);
    },
    markPhase() {
      return null;
    },
    getPhase() {
      return null;
    },
    async span(name, fn) {
      return fn();
    },
    async flush() {
      return true;
    },
    state() {
      return { sink: null, write: null, level: 'silent', phase: null, now: Date.now, dropped: 0 };
    },
  };
}
