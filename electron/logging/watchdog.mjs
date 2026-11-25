/**
 * 卡顿看门狗：回答「软件为什么像死了一样」。
 *
 * 两个互补的探针：
 * 1. drift —— setInterval 每次实际触发时间和「应该触发的时间」的偏差。定时器排进宏任务队列后，
 *    如果事件循环被某个同步操作堵住，回调就会被推迟，偏差直接反映「主进程被卡了多久」。
 *    它便宜（一次减法）、能定位到「卡在哪个 phase」，缺点是只报单次阻塞。
 * 2. monitorEventLoopDelay —— 内核级直方图，15 秒采一次 p99。它能看到漂移探针漏掉的
 *    「持续轻微变慢」（平均每次延迟 200ms 但从不触发单次阈值）。
 *
 * 硬约束：回调里只能做 O(1) 的算术和一次日志入队。
 * 看门狗自己造成卡顿，就完全毁掉了它的可信度——所以这里没有 JSON 序列化、没有 IO、
 * 没有遍历任何集合；连 memoryUsage 也只在真要记一条告警时才调用。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

const DEFAULT_TIMERS = Object.freeze({
  setInterval(fn, ms) {
    return setInterval(fn, ms);
  },
  clearInterval(handle) {
    clearInterval(handle);
  },
});

const DEFAULT_MEMORY = () => {
  try {
    return process.memoryUsage?.().heapUsed ?? 0;
  } catch {
    return 0;
  }
};

const DEFAULT_UPTIME = () => {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
};

/** 纳秒 → 毫秒，保留一位小数（直方图给的是纳秒）。 */
function toMs(nanoseconds) {
  const value = Number(nanoseconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value / 1e6) * 10) / 10;
}

/**
 * 启动看门狗。
 *
 * now / timers / perfHooks / uptime 全部可注入：测试里不需要真的等 5 秒，
 * 只要让 now() 在两次 tick 之间跳 5000ms 就能复现一次卡顿。
 *
 * @returns {{ stop: () => void, lastPhase: string | null, intervalMs: number, thresholdMs: number }}
 */
export function startHangWatchdog({
  logger,
  intervalMs = 1000,
  thresholdMs = 1500,
  now = () => Date.now(),
  perfHooks = { monitorEventLoopDelay },
  timers = DEFAULT_TIMERS,
  lagIntervalMs = 15_000,
  lagThresholdMs = 500,
  memoryBytes = DEFAULT_MEMORY,
  uptime = DEFAULT_UPTIME,
} = {}) {
  const startedAt = safeUptime();
  let lastTick = now();
  let stopped = false;

  function safeUptime() {
    try {
      return Number(uptime()) || 0;
    } catch {
      return 0;
    }
  }

  /** 只在真的要写一条告警时才读内存：这是唯一允许碰 process 的时机。 */
  function safeMemoryMB() {
    try {
      return Math.round((Number(memoryBytes()) || 0) / (1024 * 1024));
    } catch {
      return 0;
    }
  }

  function readPhase() {
    try {
      const value = typeof logger?.getPhase === 'function' ? logger.getPhase() : null;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** logger 坏了也不能让看门狗抛：定时器回调里的异常会变成未捕获异常，反而更吵。 */
  function safeLog(level, msg, data) {
    try {
      logger?.[level]?.(msg, data);
    } catch {
      /* ignore */
    }
  }

  function tick() {
    if (stopped) return;
    // —— O(1) 区域：一次减法、一次比较。别在这里加任何「顺手一起记」的东西。
    const at = now();
    const drift = at - lastTick - intervalMs;
    lastTick = at;
    if (!(drift > thresholdMs)) return;

    const memoryMB = safeMemoryMB();
    safeLog('warn', 'event-loop-hang', {
      driftMs: Math.round(drift),
      phase: readPhase(),
      uptimeMs: Math.round(safeUptime() - startedAt),
      memoryMB,
    });
  }

  let mainTimer = null;
  try {
    mainTimer = timers.setInterval(tick, intervalMs);
    mainTimer?.unref?.(); // 看门狗绝不能成为「进程退不掉」的原因
  } catch {
    mainTimer = null;
  }

  let histogram = null;
  if (perfHooks && typeof perfHooks.monitorEventLoopDelay === 'function') {
    try {
      histogram = perfHooks.monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    } catch {
      histogram = null;
    }
  }

  function sampleLag() {
    if (stopped || !histogram) return;
    try {
      const stats = {
        meanMs: toMs(histogram.mean),
        p50Ms: toMs(histogram.percentile(50)),
        p99Ms: toMs(histogram.percentile(99)),
        maxMs: toMs(histogram.max),
      };
      // 先读再 reset：reset 之后同一个窗口的样本就没了，读的顺序不能反。
      histogram.reset();
      if (stats.p99Ms > lagThresholdMs) safeLog('warn', 'event-loop-lag', stats);
    } catch {
      /* 直方图读失败不影响 drift 探针 */
    }
  }

  let lagTimer = null;
  if (histogram) {
    try {
      lagTimer = timers.setInterval(sampleLag, lagIntervalMs);
      lagTimer?.unref?.();
    } catch {
      lagTimer = null;
    }
  }

  return {
    /** 停掉两个探针；可重复调用。 */
    stop() {
      if (stopped) return;
      stopped = true;
      if (mainTimer) {
        try {
          timers.clearInterval(mainTimer);
        } catch {
          /* ignore */
        }
      }
      if (lagTimer) {
        try {
          timers.clearInterval(lagTimer);
        } catch {
          /* ignore */
        }
      }
      try {
        histogram?.disable();
      } catch {
        /* ignore */
      }
    },
    /** 最近一次卡顿时的 phase（也就是用户看到的「卡在哪一步」）。 */
    get lastPhase() {
      return readPhase();
    },
    intervalMs,
    thresholdMs,
    /** 测试/手工采样用：不必等定时器也能取一次 lag。 */
    sampleLag,
    tick,
  };
}
