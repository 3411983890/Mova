/**
 * 日志落盘：单次运行一个文件、异步串行 append、超限换分段、启动时清理旧文件。
 *
 * 为什么不用 appendFileSync：
 * 主进程的每一次同步写盘都会阻塞事件循环——而事件循环卡顿正是这套日志要排查的问题，
 * 用一个「自带卡顿」的实现去测卡顿是自相矛盾的。所以写盘全部排队 + 串行 append。
 *
 * 为什么分批写：
 * 逐条 append 在聊天/流式输出时会产生大量 syscall。队列里攒到下一个 setImmediate 再合并成
 * 一个 chunk（多行一次写），既保持顺序又减少系统调用。
 *
 * 决策部分（要不要换文件、留几个）抽成纯函数：
 * 真写 8MB 来测轮转太慢也没必要，判定逻辑正确就够了。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** 单文件上限 8MB：足够装下一次长时间使用的日志，又不会让用户发不出来。 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** 只留最近 20 个日志文件。 */
export const DEFAULT_MAX_FILES = 20;
/** 14 天前的日志直接删。 */
export const DEFAULT_MAX_AGE_DAYS = 14;

export const LOG_PREFIX = 'mova-';
export const LOG_SUFFIX = '.log';
export const LATEST_FILE_NAME = 'latest.txt';

/** 队列上限：磁盘卡死时宁可丢老日志，也不能把主进程内存吃光。 */
const MAX_QUEUED_LINES = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value, width = 2) {
  return String(Math.abs(value)).padStart(width, '0');
}

/** `YYYYMMDD-HHMMSS`（本地时间，和日志行里的 t 用同一个时区，人肉对照时不会错开）。 */
export function stampFor(date = new Date()) {
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    '-',
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('');
}

/** `mova-YYYYMMDD-HHMMSS-<pid>.log`。 */
export function logFileName({ date = new Date(), pid = process.pid } = {}) {
  return `${LOG_PREFIX}${stampFor(date)}-${pid}${LOG_SUFFIX}`;
}

/** 第 2 段起加 `-2`、`-3` 后缀，保持在同一个目录、同一个文件名族里。 */
export function partFileName(baseName, part = 1) {
  const index = Number(part);
  if (!Number.isFinite(index) || index <= 1) return baseName;
  return baseName.endsWith(LOG_SUFFIX)
    ? `${baseName.slice(0, -LOG_SUFFIX.length)}-${Math.floor(index)}${LOG_SUFFIX}`
    : `${baseName}-${Math.floor(index)}`;
}

/** 只认本系统写的日志文件；`latest.txt` 和别人的文件都不算。 */
export function isLogFileName(name) {
  return typeof name === 'string' && /^mova-\d{8}-\d{6}-\d+(?:-\d+)?\.log$/.test(name);
}

/** 该不该换分段。用 >= 而不是 >：到点就换，不会因为一次大 chunk 把文件撑成两倍。 */
export function shouldRotate(sizeBytes, maxBytes = DEFAULT_MAX_BYTES) {
  const size = Number(sizeBytes);
  const limit = Number(maxBytes);
  if (!Number.isFinite(size) || !Number.isFinite(limit) || limit <= 0) return false;
  return size >= limit;
}

/**
 * 清理决策（纯函数）：返回要留和要删的文件名。
 *
 * 两条规则同时生效：
 * 1. 按修改时间倒序，第 20 个之后的全删（数量兜底）。
 * 2. 超过 14 天的全删（时间兜底）——即使总数不到 20，陈年日志也没有排查价值。
 */
export function pickRetention(files, { maxFiles = DEFAULT_MAX_FILES, maxAgeDays = DEFAULT_MAX_AGE_DAYS, nowMs = Date.now() } = {}) {
  const limit = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0 ? Math.floor(Number(maxFiles)) : DEFAULT_MAX_FILES;
  const days = Number.isFinite(Number(maxAgeDays)) && Number(maxAgeDays) > 0 ? Number(maxAgeDays) : DEFAULT_MAX_AGE_DAYS;
  const cutoff = Number(nowMs) - days * DAY_MS;
  const sorted = (Array.isArray(files) ? files : [])
    .filter(file => file && typeof file.name === 'string')
    .slice()
    .sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));

  const keep = [];
  const remove = [];
  sorted.forEach((file, index) => {
    const tooMany = index >= limit;
    const tooOld = (Number(file.mtimeMs) || 0) < cutoff;
    if (tooMany || tooOld) remove.push(file.name);
    else keep.push(file.name);
  });
  return { keep, remove };
}

/**
 * 扫描目录并按 pickRetention 删文件。
 * 任何单文件失败（正好被别的进程删掉、权限不足）都只记进 report，不抛。
 */
export async function pruneLogs({
  dir,
  maxFiles = DEFAULT_MAX_FILES,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  now = () => new Date(),
  protect = [],
} = {}) {
  const report = { removed: [], kept: 0, errors: [] };
  if (typeof dir !== 'string' || dir.length === 0) return report;
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    report.errors.push(`readdir: ${error?.message ?? error}`);
    return report;
  }
  const files = [];
  for (const name of names) {
    if (!isLogFileName(name)) continue;
    try {
      const info = await stat(join(dir, name));
      if (!info.isFile()) continue;
      files.push({ name, mtimeMs: info.mtimeMs, size: info.size });
    } catch (error) {
      report.errors.push(`stat ${name}: ${error?.message ?? error}`);
    }
  }
  const nowMs = typeof now === 'function' ? now().getTime() : new Date(now).getTime();
  const decision = pickRetention(files, { maxFiles, maxAgeDays, nowMs });
  const protectedNames = new Set(Array.isArray(protect) ? protect : []);
  // 正在写的文件即使被判「过旧」也不能删（机器时间被改过时真会发生）。
  report.kept = new Set([...decision.keep, ...protectedNames]).size;
  for (const name of decision.remove) {
    if (protectedNames.has(name)) continue;
    try {
      await unlink(join(dir, name));
      report.removed.push(name);
    } catch (error) {
      report.errors.push(`unlink ${name}: ${error?.message ?? error}`);
    }
  }
  return report;
}

/**
 * 文件 sink：异步排队 + 串行 append。
 *
 * 返回的对象就是 logger 眼里的 sink（`write(record)` / `flush(ms)`），
 * 另外挂了一些排查用的只读信息（当前文件、字节数、丢了多少条）。
 */
export function createFileSink({
  dir,
  pid = process.pid,
  now = () => new Date(),
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
} = {}) {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    throw new Error('createFileSink 需要日志目录 dir（不能是空字符串）');
  }
  // 建目录是启动时一次性的小事，允许同步，失败就直接抛给安装层去决定降级方式。
  mkdirSync(dir, { recursive: true });

  const baseName = logFileName({ date: now(), pid });
  let part = 1;
  let current = join(dir, baseName);
  /** latest.txt 里当前写的名字；换分段后才更新，避免空分段抢先出现在 latest.txt。 */
  let announced = '';
  let bytes = 0;
  let queue = [];
  let scheduled = null;
  let draining = false;
  let closed = false;
  let writes = 0;
  let errors = 0;
  let dropped = 0;
  let lastError = '';
  let idleWaiters = [];

  function announce() {
    const name = basename(current);
    if (name === announced) return;
    try {
      writeFileSync(join(dir, LATEST_FILE_NAME), `${name}\n`, 'utf8');
      announced = name;
    } catch (error) {
      lastError = `latest.txt: ${error?.message ?? error}`;
    }
  }
  announce();

  function schedule() {
    if (scheduled || closed) return;
    // setImmediate + unref：攒一批再写，且这个句柄不会拖住进程退出。
    scheduled = setImmediate(() => {
      scheduled = null;
      void drain();
    });
    scheduled.unref?.();
  }

  function resolveIdle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * 换分段。这里刻意不立刻建新文件：
   * 空分段出现在目录里没有意义（用户会看到一个 0 字节的最新日志），
   * 等下一次真正写入时再创建，latest.txt 也等那时才改。
   */
  function rotate() {
    part += 1;
    current = join(dir, partFileName(baseName, part));
    bytes = 0;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const chunk = queue.join('');
        queue = [];
        if (closed) break;
        try {
          await appendFile(current, chunk, 'utf8');
          bytes += Buffer.byteLength(chunk, 'utf8');
          writes += 1;
          announce();
        } catch (error) {
          errors += 1;
          lastError = `append: ${error?.message ?? error}`;
          continue;
        }
        if (shouldRotate(bytes, maxBytes)) rotate();
      }
    } finally {
      draining = false;
      resolveIdle();
    }
  }

  const sink = {
    dir,
    /** 建目录/写 latest.txt 已完成；prune 是后台跑的，测试可以 await 它。 */
    ready: null,
    /** 写一行（记录对象或已序列化字符串都行）。永不抛。 */
    write(record) {
      if (closed) return false;
      let line;
      try {
        line = typeof record === 'string' ? record : JSON.stringify(record);
      } catch (error) {
        // 记录已经过 redact，理论上一定可序列化；真出问题也要留个痕迹再说。
        errors += 1;
        lastError = `stringify: ${error?.message ?? error}`;
        line = JSON.stringify({
          t: now().toISOString?.() ?? new Date().toISOString(),
          level: 'error',
          scope: 'logging',
          msg: 'record-unserializable',
        });
      }
      if (typeof line !== 'string' || line.length === 0) return false;
      if (queue.length > MAX_QUEUED_LINES) {
        // 磁盘写不进时丢最老的：新的日志更接近用户报的这次问题。
        queue.shift();
        dropped += 1;
      }
      queue.push(`${line}\n`);
      schedule();
      return true;
    },
    /** 尽力写完；超时返回 false，调用方（退出流程）不该因此阻塞。 */
    async flush(timeoutMs = 1500) {
      if (queue.length === 0 && !draining) return true;
      if (queue.length > 0) schedule();
      const idle = new Promise(resolve => idleWaiters.push(resolve));
      const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 1500;
      let timer = null;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), limit);
        timer.unref?.();
      });
      try {
        return await Promise.race([idle.then(() => true), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close() {
      const ok = await sink.flush(1500);
      closed = true;
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = null;
      }
      return ok;
    },
    currentFile() {
      return current;
    },
    /** 真正写过的最后一个分段（latest.txt 里的名字）；还没写过就是当前要写的分段。 */
    latestFile() {
      return join(dir, announced || basename(current));
    },
    latestFileName() {
      return announced || basename(current);
    },
    stats() {
      return { writes, bytes, part, errors, dropped, queued: queue.length, lastError, file: current };
    },
    /** 直接覆盖队列深度上限，仅供测试观察。 */
    depth() {
      return queue.length;
    },
  };

  // 启动清理放在后台：扫描目录可能几百毫秒，不能挡第一次 paint。
  sink.ready = pruneLogs({ dir, maxFiles, maxAgeDays, now, protect: [basename(current)] }).catch(error => ({
    removed: [],
    kept: 0,
    errors: [String(error?.message ?? error)],
  }));

  return sink;
}
