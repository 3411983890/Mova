import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGoalTurn, GOAL_AUTO_MAX_ROUNDS, GOAL_STOP_TEXT, goalAutoText, goalRoundDecision,
} from '../src/features/chat/goal-loop.mjs';

const accepted = { title: '整理面试资料', detail: '', status: 'active', accepted: true, summary: '' };
const aim = (overrides = {}) => ({
  goal: { ...accepted, ...(overrides.goal ?? {}) },
  plan: overrides.plan === undefined ? { steps: [{ label: '读笔记', status: 'active' }] } : overrides.plan,
  auto: overrides.auto ?? { rounds: 0, stall: 0 },
});

test('only an accepted, active goal with auto on continues', () => {
  assert.equal(goalRoundDecision({ aim: aim(), status: 'done', touched: true }).action, 'continue');
  assert.equal(goalRoundDecision({ aim: aim({ goal: { accepted: false } }), status: 'done' }).reason, 'not-accepted');
  assert.equal(goalRoundDecision({ aim: aim({ goal: { status: 'paused' } }), status: 'done' }).reason, 'goal-paused');
  assert.equal(goalRoundDecision({ aim: aim({ goal: { status: 'blocked' } }), status: 'done' }).reason, 'goal-blocked');
  assert.equal(goalRoundDecision({ aim: aim({ goal: { status: 'done' } }), status: 'done' }).reason, 'goal-done');
  assert.equal(goalRoundDecision({ aim: aim({ auto: { enabled: false } }), status: 'done' }).action, 'skip');
  assert.equal(goalRoundDecision({ aim: aim(), status: 'stopped' }).reason, 'reply-not-done', '用户点停止就不再自动开下一轮');
  assert.equal(goalRoundDecision({ aim: aim(), status: 'error' }).reason, 'reply-not-done');
  assert.equal(goalRoundDecision({ status: 'done' }).reason, 'no-goal');
});

test('two rounds without any goal/plan update stop the loop', () => {
  const first = goalRoundDecision({ aim: aim({ auto: { rounds: 1, stall: 0 } }), status: 'done', touched: false });
  assert.equal(first.action, 'continue');
  assert.equal(first.stall, 1);

  const second = goalRoundDecision({ aim: aim({ auto: { rounds: 2, stall: 1 } }), status: 'done', touched: false });
  assert.equal(second.action, 'stop');
  assert.equal(second.reason, 'no-progress');
  assert.equal(second.stall, 2);

  // 动过目标/计划就清空“没有进展”计数。
  const touched = goalRoundDecision({ aim: aim({ auto: { rounds: 2, stall: 1 } }), status: 'done', touched: true });
  assert.equal(touched.action, 'continue');
  assert.equal(touched.stall, 0);
});

test('the round budget is a hard stop', () => {
  const decision = goalRoundDecision({ aim: aim({ auto: { rounds: GOAL_AUTO_MAX_ROUNDS, stall: 0 } }), status: 'done', touched: true });
  assert.equal(decision.action, 'stop');
  assert.equal(decision.reason, 'limit');
  assert.match(GOAL_STOP_TEXT.limit, /轮上限/);
});

test('the continuation turn states the goal, the plan and how to end it', () => {
  const bundle = buildGoalTurn({
    goal: { ...accepted, summary: '上一轮读完了笔记' },
    steps: [
      { label: '读笔记', status: 'done' },
      { label: '写提纲', status: 'active' },
      { label: '自检', status: 'pending' },
    ],
    round: 2,
  });
  assert.match(bundle.note, /第 2\/6 轮/);
  assert.match(bundle.text, /整理面试资料/);
  assert.match(bundle.text, /读笔记（已完成）/);
  assert.match(bundle.text, /写提纲（进行中）/);
  assert.match(bundle.text, /上一轮记录：上一轮读完了笔记/);
  assert.match(bundle.text, /status="done"/);
  assert.match(bundle.text, /status="blocked"/);

  const noPlan = buildGoalTurn({ goal: accepted, steps: [], round: 1 });
  assert.match(noPlan.text, /set_plan/);
});

test('the panel line never promises more than the recorded state', () => {
  assert.match(goalAutoText(aim()), /自动推进 0\/6 轮/);
  assert.match(goalAutoText(aim({ goal: { accepted: false } })), /等模型接受目标/);
  assert.match(goalAutoText(aim({ goal: { status: 'blocked', summary: '缺权限' } })), /已受阻 · 缺权限/);
  assert.match(goalAutoText(aim({ goal: { status: 'done' } })), /已完成/);
  assert.match(goalAutoText(aim({ auto: { rounds: 3, enabled: false } })), /已关闭/);
  assert.match(goalAutoText(null), /set_goal/);
});
