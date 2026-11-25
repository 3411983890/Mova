'use strict';
// 只读档必须真的拦住写操作：R2 以上一律升到 R3（requiresApproval），
// 否则"设置里选只读"只是装饰。回归护栏。
const test = require('node:test');
const assert = require('node:assert');

const { classifyDesktopAction } = require('../../electron/desktop/policy.cjs');

test('read-only 档：R2 点击会被升到 R3 并要求审批', () => {
  const risk = classifyDesktopAction({ action: 'click', app: 'notepad.exe' }, { profile: 'read-only' });
  assert.equal(risk.level, 'R3');
  assert.equal(risk.requiresApproval, true);
  assert.ok(risk.reasons.includes('profile:read-only'));
});

test('standard 档：同样的点击仍是 R2，不需要审批', () => {
  const risk = classifyDesktopAction({ action: 'click', app: 'notepad.exe' }, { profile: 'standard' });
  assert.equal(risk.level, 'R2');
  assert.equal(risk.requiresApproval, false);
});

test('read-only 档：只读动作（R0/R1）不受影响', () => {
  const read = classifyDesktopAction({ action: 'snapshot' }, { profile: 'read-only' });
  assert.ok(read.risk <= 1, `只读动作不应该被升档，实际 ${read.level}`);
  assert.equal(read.requiresApproval, false);
});
