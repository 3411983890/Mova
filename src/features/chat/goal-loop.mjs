/**
 * 目标自动推进：每轮回复结束后判断「要不要自己再开一轮」。
 *
 * 规则只有一条是真的：模型必须**接受**目标（accept_goal），并且目标仍是 active，
 * 才会自动继续；目标 done / blocked / paused、或用户关掉自动推进，立刻停。
 * 另外两道闸防止一直轮询：
 *   - 连续 GOAL_STALL_LIMIT 轮没有任何 goal / plan 更新 → 判定没进展，停下；
 *   - 单次目标最多 GOAL_AUTO_MAX_ROUNDS 轮（用户手动发消息会重置）。
 *
 * 这里是纯函数，渲染端只负责把它的结论落实成动作，便于单测。
 */

export const GOAL_AUTO_MAX_ROUNDS = 6;
export const GOAL_STALL_LIMIT = 2;

export const GOAL_STOP_TEXT = {
  'no-progress': '连续两轮没有更新目标或计划，自动推进已停止',
  limit: `已到 ${GOAL_AUTO_MAX_ROUNDS} 轮上限，自动推进已停止`,
};

/**
 * @param {{ aim?: object|null, status?: string, touched?: boolean }} input
 *   aim：会话的目标/计划记录（goal / plan / auto）
 *   status：这一轮回复的收尾状态（done / stopped / error / interrupted）
 *   touched：这一轮是否调用过 goal / plan 工具
 * @returns {{ action: 'skip'|'continue'|'stop', reason: string, rounds: number, stall: number }}
 */
export function goalRoundDecision({ aim, status, touched } = {}) {
  const goal = aim?.goal ?? null;
  const auto = aim?.auto ?? {};
  const rounds = Number(auto.rounds) || 0;
  const stall = touched ? 0 : (Number(auto.stall) || 0) + 1;
  const base = { rounds, stall };

  if (status !== 'done') return { ...base, action: 'skip', reason: 'reply-not-done' };
  if (!goal || !goal.title) return { ...base, action: 'skip', reason: 'no-goal' };
  if (goal.status !== 'active') return { ...base, action: 'skip', reason: `goal-${goal.status}` };
  if (goal.accepted !== true) return { ...base, action: 'skip', reason: 'not-accepted' };
  if (auto.enabled === false) return { ...base, action: 'skip', reason: 'auto-off' };
  if (stall >= GOAL_STALL_LIMIT) return { ...base, action: 'stop', reason: 'no-progress' };
  if (rounds >= GOAL_AUTO_MAX_ROUNDS) return { ...base, action: 'stop', reason: 'limit' };
  return { ...base, action: 'continue', reason: 'goal-active' };
}

const STEP_TEXT = { done: '已完成', active: '进行中', pending: '未开始' };

/**
 * 自动继续时写进对话的那一轮用户消息：既让模型看清进度，也让恢复上下文时有据可依。
 * 中间状态全部来自工具写入的计划，不做推测。
 */
export function buildGoalTurn({ goal, steps = [], round = 1, max = GOAL_AUTO_MAX_ROUNDS } = {}) {
  const title = String(goal?.title ?? '').trim();
  const list = steps.slice(0, 12);
  const plan = list.length
    ? list.map((step, index) => `${index + 1}. ${step.label}（${STEP_TEXT[step.status] ?? '未开始'}）`).join('；')
    : '还没有计划，请先用 set_plan 写出步骤再继续';
  const lines = [
    `[自动继续 ${round}/${max}] 请继续推进目标「${title}」。`,
    `当前计划：${plan}。`,
    goal?.summary ? `上一轮记录：${goal.summary}。` : '',
    '直接从当前的下一步接着做，不要重做已完成的部分，也不要重复询问是否继续。',
    '完成并核验结果后用 update_goal（status="done"）结束，会自动停止推进；'
      + '遇到无法自行解决的阻塞用 status="blocked" 并写清原因；需要我补充信息时用 status="paused"。',
  ];
  return {
    text: lines.filter(Boolean).join('\n'),
    note: `自动继续 · 第 ${round}/${max} 轮`,
  };
}

/** 面板上那一行状态文字：只说当前真实状态，不承诺没有的能力。 */
export function goalAutoText(aim) {
  const goal = aim?.goal ?? null;
  const auto = aim?.auto ?? {};
  if (!goal) return '由模型通过 set_goal / set_plan 维护';
  if (goal.status === 'done') return '目标已完成，自动推进已停止';
  if (goal.status === 'blocked') return goal.summary ? `已受阻 · ${goal.summary}` : '已受阻，自动推进已停止';
  if (goal.status === 'paused') return goal.summary ? `已暂停 · ${goal.summary}` : '已暂停';
  if (goal.accepted !== true) return '等模型接受目标后，才会自动继续';
  if (auto.enabled === false) return '自动推进已关闭';
  const rounds = Number(auto.rounds) || 0;
  return `自动推进 ${rounds}/${GOAL_AUTO_MAX_ROUNDS} 轮 · 目标未完成时自动继续`;
}
