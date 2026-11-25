/**
 * 负责：给「静默计时 / 人工等待」这类与时间有关的测试提供一个可手动推进的假时钟，不真等时间。
 * 不负责：业务断言，也不 mock 真实的 setTimeout —— ask 的 2 分钟上限、桌面 handoff 的 250ms 轮询
 *          仍然走真实计时器（故意如此：那两条才是被测代码里的真实上限）。
 * 被谁调用：tests/human-wait-idle.test.mjs、tests/human-wait-paths.test.mjs。
 */

/** 让 Promise 的回调先跑完，再看计时器效果。 */
export function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * 可手动推进的假时钟：advance() 只触发真的到期的计时器，不依赖真实时间。
 * @param {number} [start] 起始毫秒时间戳
 */
export function createClock(start = 1_000_000) {
  let time = start;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = seq;
      seq += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 还挂着的计时器数量：用来断言「没有残留」。 */
    count: () => timers.size,
    async advance(ms) {
      time += ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= time)
          .sort((left, right) => left[1].at - right[1].at);
        if (!due.length) return;
        for (const [id, timer] of due) {
          if (timers.get(id) !== timer) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}
