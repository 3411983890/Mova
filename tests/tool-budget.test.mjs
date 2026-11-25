/**
 * 负责：钉住「一轮内工具输出预算」的口径——按模型上下文窗口缩放、按 token 计、上下限夹住。
 * 不负责：afterToolCall 的执行细节（chat-agent.mjs）、上下文压缩阈值（budget.mjs 的 createBudget）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么值得钉：这条上限以前写死 200,000 **字符**，两个后果都很难查——
 *   1) 272k / 500k 窗口的模型只用到 5–10% 的窗口，长任务（设计循环、浏览器快照）动不动撞线，用户只看到
 *      「模型运行中断（tool_limit）」，不知道是谁吃掉的；
 *   2) 单位是字符，中文严重低估：20 万汉字约 30 万 token，能直接把窗口顶爆。
 * 所以这里同时钉「数值」和「单位」：只改常量不改单位，中文场景仍然是错的。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { estimateTokens, toolBudgetVerdict, toolRunBudget } from '../electron/context/budget.mjs';

const MIN = 55_000;
const MAX = 150_000;

test('按窗口的 1/4 给预算：128k/272k/500k/1M 各自落在预期值', () => {
  assert.equal(toolRunBudget(128_000), MIN, '32k < 下限 → 夹到 55k（不低于旧实现的实际容量）');
  assert.equal(toolRunBudget(272_000), 68_000);
  assert.equal(toolRunBudget(500_000), 125_000, '这正是用户抱怨的那一档：旧实现只给了相当于 5% 窗口');
  assert.equal(toolRunBudget(1_000_000), MAX, '250k > 上限 → 夹到 150k');
  assert.equal(toolRunBudget(10_000_000), MAX);
});

test('窗口缺失/非法时退回下限（绝不因为读不到窗口就把预算放大）', () => {
  for (const value of [undefined, null, 0, -1, NaN, 'abc', {}, []]) {
    assert.equal(toolRunBudget(value), MIN, `非法窗口 ${String(value)} 必须退回下限`);
  }
});

test('永远落在 [55k, 150k]，且随窗口单调不减', () => {
  let previous = 0;
  for (const window of [1_000, 32_000, 64_000, 128_000, 220_000, 272_000, 400_000, 500_000, 800_000, 1_000_000, 2_000_000]) {
    const budget = toolRunBudget(window);
    assert.ok(budget >= MIN, `${window} → ${budget} 低于下限`);
    assert.ok(budget <= MAX, `${window} → ${budget} 高于上限`);
    assert.ok(budget >= previous, `${window} → ${budget} 比更小的窗口还少`);
    previous = budget;
  }
});

test('单位是 token 不是字符：中文比英文更早撞线（同字符数下中文更贵）', () => {
  // 同一段 2,000 字符：中文 ≈ 3,000 token，英文 ≈ 560 token。
  const chinese = estimateTokens('文字'.repeat(1_000));
  const english = estimateTokens('ab'.repeat(1_000));
  assert.ok(chinese > english * 3, `中文 ${chinese} 应明显高于英文 ${english}`);
  // 旧实现按字符算，这种差别完全看不见：20 万汉字 ≈ 30 万 token，能顶爆 128k 窗口。
  assert.ok(estimateTokens('字'.repeat(200_000)) > 200_000, '20 万汉字必须超过 20 万 token，字符口径是错误的');
});

test('旧实现的 200k 字符在新口径下的换算（英文基本不变，中文显著收紧）', () => {
  // 只说清事实：英文 200k 字符 ≈ 55k token = 新的下限，所以英文会话不会因为这次改动变紧。
  const asciiTwoHundredThousand = estimateTokens('a'.repeat(200_000));
  assert.ok(asciiTwoHundredThousand >= MIN - 2_000 && asciiTwoHundredThousand <= MIN + 2_000,
    `英文 200k 字符 ≈ ${asciiTwoHundredThousand} token，应与下限 55k 同一量级`);
});

test('chat-agent 真的用了它，且硬编码的 200_000 字符上限没有回来', async () => {
  const source = await readFile(new URL('../electron/chat-agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /toolRunBudget\(model\.contextWindow\)/, '预算必须由模型窗口算出来');
  assert.match(source, /estimateTokens\(clipped\)/, '累加必须按 token 计，不能回到字符');
  assert.equal(/TOOL_RUN_LIMIT/.test(source), false, '旧的写死常量应当已删除');
  // 撞线时必须留下「谁吃掉的」：没有这条日志，这个错误事后无法复盘。
  assert.match(source, /tool-budget-exhausted/);
});

// ── 超预算之后怎么办：先收尾，再才硬停 ────────────────────────────────
test('toolBudgetVerdict：没超 → ok；第一次超 → wrap-up；收尾指令给过还超 → stop', () => {
  assert.equal(toolBudgetVerdict({ tokens: 10, budget: 100 }), 'ok');
  assert.equal(toolBudgetVerdict({ tokens: 100, budget: 100 }), 'ok', '正好等于上限不算超');
  assert.equal(toolBudgetVerdict({ tokens: 101, budget: 100 }), 'wrap-up', '第一次超预算要给模型收尾的机会');
  assert.equal(toolBudgetVerdict({ tokens: 101, budget: 100, wrapUpSent: true }), 'stop', '给过指令还在调工具才真停');
  assert.equal(toolBudgetVerdict({ tokens: 500, budget: 100, wrapUpSent: true }), 'stop');
});

test('toolBudgetVerdict：读不出数字时按「没超」处理（宁可不拦，也不因为一个 NaN 掐断整轮）', () => {
  for (const input of [undefined, {}, { tokens: NaN, budget: 100 }, { tokens: 100, budget: 0 },
    { tokens: 100, budget: -1 }, { tokens: 100, budget: NaN }, { tokens: 100 }]) {
    assert.equal(toolBudgetVerdict(input), 'ok', `${JSON.stringify(input)} 不该判成超预算`);
  }
});

test('chat-agent：超预算的第一反应是收尾，不是终止（terminate 只留给「说了还调工具」）', async () => {
  const source = await readFile(new URL('../electron/chat-agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /toolBudgetVerdict\(\{ tokens: toolTokens, budget: toolBudget, wrapUpSent: toolWrapUpSent \}\)/);
  assert.match(source, /if \(verdict === 'wrap-up'\)/, '必须区分收尾与终止两条路');
  assert.match(source, /toolWrapUpSent = true/, '收尾指令只能给一次');
  assert.match(source, /【工具输出预算已用尽】/, '给模型的收尾指令必须显式出现');
  assert.match(source, /不要再调用任何工具/, '收尾指令必须明确禁止继续调工具');
  assert.match(source, /已经完成了什么/, '收尾指令必须要求总结已完成部分');
  assert.match(source, /下一步建议/, '收尾指令必须要求给出下一步');
  // 硬停必须只剩一处（收尾之后仍在调工具的那条路）。
  const terminations = source.match(/terminate: true/g) || [];
  assert.equal(terminations.length, 1, `terminate: true 只该出现一次，实际 ${terminations.length} 次`);
});
