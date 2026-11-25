/**
 * 会话级「目标 / 计划」状态机（主进程侧）。
 *
 * 一次 runChatAgent 只活一轮，但目标要跨轮存在：渲染端把当前的 goal / plan 放进
 * 请求里，这里先把它恢复出来，工具再在它上面继续写。四个工具（set_goal /
 * accept_goal / update_goal / set_plan）都只通过这里改状态，别的代码不推断进度。
 *
 * 状态语义：
 *   active    进行中，且已被模型接受时，渲染端会在每轮结束后自动开始下一轮；
 *   paused    用户暂停，或自动推进自行停下（到达轮数上限 / 连续没有进展）；
 *   done      模型确认完成并已核验，自动推进停止；
 *   blocked   模型明确说明无法继续（缺权限、缺输入、外部阻塞），自动推进停止；
 *   idle      只存在于初始快照里，工具不会写回。
 */

const GOAL_STATUSES = ['idle', 'active', 'paused', 'done', 'blocked'];
const STEP_STATUSES = ['pending', 'active', 'done'];
const MAX_STEPS = 12;

const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

export function normalizeGoal(raw) {
  if (!raw || typeof raw !== 'object' || !text(raw.title, 120)) return null;
  return {
    title: text(raw.title, 120),
    detail: text(raw.detail, 400),
    status: GOAL_STATUSES.includes(raw.status) ? raw.status : 'active',
    accepted: raw.accepted === true,
    summary: text(raw.summary, 300),
  };
}

export function normalizeSteps(raw) {
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_STEPS).flatMap(step => {
    const label = text(step?.label, 120);
    if (!label) return [];
    const status = STEP_STATUSES.includes(step?.status) ? step.status : 'pending';
    const meta = text(step?.meta, 120);
    return [{ label, status, ...(meta ? { meta } : {}) }];
  });
  let activeSeen = false;
  for (const step of list) {
    if (step.status !== 'active') continue;
    if (activeSeen) step.status = 'pending';
    activeSeen = true;
  }
  return list;
}

/** 请求里带回来的快照 → 状态机；缺失或损坏时退回空目标。 */
export function createGoalState(aim) {
  let goal = normalizeGoal(aim?.goal);
  let steps = normalizeSteps(aim?.plan?.steps);

  const snapshot = () => ({
    goal: goal ? { ...goal } : null,
    plan: steps.length ? { steps: steps.map(step => ({ ...step })) } : null,
  });

  const goalView = () => (goal ? { ...goal } : null);

  return {
    snapshot,
    goal: goalView,
    steps: () => steps.map(step => ({ ...step })),

    /** 新建或替换目标：替换后必须重新接受，避免旧目标的「已接受」被继承。 */
    setGoal(input) {
      const title = text(input?.title, 120);
      if (!title) return { ok: false, error: 'title is required' };
      goal = { title, detail: text(input?.detail, 400), status: 'active', accepted: false, summary: '' };
      return { ok: true, goal: goalView() };
    },

    /** 模型接受目标：只有接受过的目标才会被自动推进。 */
    accept(input) {
      if (!goal) return { ok: false, error: 'No goal is set. Call set_goal first.' };
      if (goal.status === 'done') return { ok: false, error: 'This goal is already done; set a new goal instead.' };
      goal.accepted = true;
      if (goal.status === 'idle' || goal.status === 'active') goal.status = 'active';
      const note = text(input?.note, 200);
      if (note) goal.summary = note;
      return { ok: true, goal: goalView() };
    },

    /** 只允许模型自己改状态；done / blocked 会同时停掉自动推进。 */
    updateStatus(input) {
      if (!goal) return { ok: false, error: 'No goal is set. Call set_goal first.' };
      const status = GOAL_STATUSES.includes(input?.status) ? input.status : '';
      if (!status || status === 'idle') return { ok: false, error: 'status must be active, paused, done or blocked' };
      goal.status = status;
      const summary = text(input?.summary, 300);
      if (summary) goal.summary = summary;
      if (status === 'done' || status === 'blocked') goal.accepted = false;
      return { ok: true, goal: goalView() };
    },

    setPlan(input) {
      const list = normalizeSteps(input?.steps);
      if (!list.length) return { ok: false, error: 'steps is required' };
      steps = list;
      return { ok: true, steps: steps.map(step => ({ ...step })) };
    },
  };
}
