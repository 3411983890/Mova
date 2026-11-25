import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoalState, normalizeGoal, normalizeSteps } from '../electron/goal-state.mjs';

test('a new goal must be accepted before it can drive automatic continuation', () => {
  const state = createGoalState(null);
  assert.deepEqual(state.snapshot(), { goal: null, plan: null });
  assert.equal(state.updateStatus({ status: 'done' }).ok, false, '没有目标时不能改状态');

  const created = state.setGoal({ title: '整理发布清单', detail: '列出发布前检查项' });
  assert.equal(created.ok, true);
  assert.deepEqual(state.goal(), {
    title: '整理发布清单', detail: '列出发布前检查项', status: 'active', accepted: false, summary: '',
  });
  assert.equal(state.accept({ note: '先看现有清单' }).ok, true);
  assert.equal(state.goal().accepted, true);
  assert.equal(state.goal().summary, '先看现有清单');
});

test('done and blocked stop the goal and drop acceptance; paused can be resumed', () => {
  const state = createGoalState({ goal: { title: '任务', status: 'active', accepted: true }, plan: null });
  assert.equal(state.updateStatus({ status: 'paused' }).ok, true);
  assert.equal(state.goal().status, 'paused');
  assert.equal(state.accept().ok, true, '接受过之后仍可接受，不会报错');
  assert.equal(state.goal().accepted, true);

  assert.equal(state.updateStatus({ status: 'done', summary: '已核验' }).ok, true);
  assert.equal(state.goal().status, 'done');
  assert.equal(state.goal().accepted, false);
  assert.equal(state.accept().ok, false, '完成的目标不能靠 accept 复活');

  const blocked = createGoalState({ goal: { title: '任务', status: 'active', accepted: true } });
  blocked.updateStatus({ status: 'blocked', summary: '缺权限' });
  assert.equal(blocked.goal().status, 'blocked');
  assert.equal(blocked.goal().summary, '缺权限');
  assert.equal(blocked.accept().ok, true, '受阻后可以重新接受再试');
});

test('replacing a goal clears the previous acceptance', () => {
  const state = createGoalState({ goal: { title: '旧目标', status: 'done', accepted: false } });
  state.setGoal({ title: '新目标' });
  assert.equal(state.goal().title, '新目标');
  assert.equal(state.goal().accepted, false, '换了目标就要重新接受，别继承旧目标的授权');
});

test('plan keeps one active step and drops blank rows', () => {
  const state = createGoalState(null);
  const result = state.setPlan({ steps: [
    { label: '第一步', status: 'done' },
    { label: '第二步', status: 'active' },
    { label: '第三步', status: 'active' },
    { label: '   ', status: 'pending' },
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(state.steps().map(step => `${step.label}:${step.status}`), ['第一步:done', '第二步:active', '第三步:pending']);
  assert.equal(state.setPlan({ steps: [] }).ok, false);
  assert.equal(state.setPlan({ steps: [{ label: '' }] }).ok, false);
});

test('malformed snapshots degrade instead of throwing', () => {
  assert.equal(normalizeGoal(null), null);
  assert.equal(normalizeGoal({ title: '   ' }), null);
  assert.equal(normalizeGoal({ title: 'x', status: 'nope' }).status, 'active');
  assert.deepEqual(normalizeSteps('nope'), []);
  assert.deepEqual(normalizeSteps([{ label: 'a', status: 'weird' }]), [{ label: 'a', status: 'pending' }]);
  const state = createGoalState({ goal: { title: 'ok' }, plan: 'broken' });
  assert.equal(state.snapshot().plan, null);
});
