/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyDesktopAction, appRule, labelOf, normalizeKeys, isDangerousKeys,
  settingsDefaults, normalizeSettings, normalizeBudget,
} = require('../../electron/desktop/policy.cjs');

test('读取类动作是 R0，不需要审批', () => {
  const risk = classifyDesktopAction({ action: 'snapshot', app: 'EXCEL.EXE|16.0' });
  assert.equal(risk.level, 'R0');
  assert.equal(risk.requiresApproval, false);
  assert.equal(risk.requiresHandoff, false);
});

test('点击是 R2：有副作用但不需要每次审批', () => {
  const risk = classifyDesktopAction({ action: 'click', target: 'w1.b7', app: 'notepad.exe' });
  assert.equal(risk.level, 'R2');
  assert.equal(risk.requiresApproval, false);
});

test('危险词把动作提升到 R3', () => {
  for (const target of ['保存', '另存为', '发送', '提交', '覆盖']) {
    const risk = classifyDesktopAction({ action: 'invoke', target, app: 'excel.exe' });
    assert.equal(risk.level, 'R3', `${target} 应该是 R3`);
    assert.equal(risk.requiresApproval, true);
    assert.ok(risk.reasons.some(reason => reason.startsWith('dangerous-word')), JSON.stringify(risk.reasons));
  }
});

test('危险词里不可逆的那些直接 R4 并要求交接', () => {
  for (const target of ['卸载', '格式化', '转账', '支付']) {
    const risk = classifyDesktopAction({ action: 'invoke', target, app: 'control.exe' });
    assert.equal(risk.level, 'R4', `${target} 应该是 R4`);
    assert.equal(risk.requiresHandoff, true);
    assert.equal(risk.requiresApproval, false);
  }
});

test('危险键一律 R4', () => {
  for (const keys of ['Ctrl+Alt+Del', 'CTRL+ALT+DELETE', 'Win+L', 'win+r', 'Meta+R']) {
    const risk = classifyDesktopAction({ action: 'key', keys, app: 'explorer.exe' });
    assert.equal(risk.level, 'R4', `${keys} 应该是 R4`);
    assert.equal(risk.requiresHandoff, true);
  }
  assert.equal(isDangerousKeys('Ctrl+Alt+Delete'), 'CTRL+ALT+DEL');
  assert.equal(isDangerousKeys('Ctrl+S'), null);
});

test('Ctrl+S 是保存快捷键 → R3', () => {
  const risk = classifyDesktopAction({ action: 'key', keys: 'Ctrl+S', app: 'excel.exe' });
  assert.equal(risk.level, 'R3');
  assert.ok(risk.reasons.includes('save-shortcut'));
});

test('密码框 / 登录窗口 / UAC → R4', () => {
  assert.equal(classifyDesktopAction({ action: 'click', target: '密码', app: 'weixin.exe' }).level, 'R4');
  assert.equal(classifyDesktopAction({ action: 'type', password: true, app: 'weixin.exe' }).level, 'R4');
  assert.equal(classifyDesktopAction({ action: 'click', target: 'w1.b2', title: '微信 登录', app: 'weixin.exe' }).level, 'R4');
  assert.equal(classifyDesktopAction({ action: 'click', target: '是', title: '用户帐户控制', app: 'consent.exe' }).level, 'R4');
  assert.equal(classifyDesktopAction({ action: 'click', target: '继续', title: '安全桌面' }).level, 'R4');
});

test('未知动作按交互处理，并留下原因', () => {
  const risk = classifyDesktopAction({ action: 'teleport', app: 'notepad.exe' });
  assert.equal(risk.level, 'R2');
  assert.ok(risk.reasons.some(reason => reason.startsWith('unknown-action')));
});

test('应用规则：精确 > 通配，deny 优先', () => {
  const settings = normalizeSettings({
    apps: {
      'excel.exe': 'allow',
      '*.bank*': 'deny',
      'chrome.exe': 'route-to-browser',
      '1password.exe': { allow: 'deny', reason: '密码管理器' },
    },
  });
  assert.equal(appRule('EXCEL.EXE|16.0', settings).allow, 'allow');
  assert.equal(appRule('icbc.bank.client.exe', settings).allow, 'deny');
  assert.equal(appRule('chrome.exe', settings).allow, 'route-to-browser');
  assert.equal(appRule('1password.exe', settings).allow, 'deny');

  const denied = classifyDesktopAction({ action: 'click', target: 'w1.b2', app: '1password.exe' }, settings);
  assert.equal(denied.level, 'R4');
  assert.ok(denied.reasons.some(reason => reason.startsWith('app-denied')));
});

test('内置黑名单与“不操作 Mova 自己”', () => {
  const settings = settingsDefaults();
  assert.equal(appRule('keepass.exe', settings).allow, 'deny');
  assert.equal(appRule('logonui.exe', settings).allow, 'deny');
  assert.equal(appRule('mova.exe', settings).allow, 'deny');
  assert.equal(appRule('notepad.exe', settings).allow, 'allow');
});

test('read-only 档把交互动作拉高到需要审批', () => {
  const settings = normalizeSettings({ profile: 'read-only' });
  const risk = classifyDesktopAction({ action: 'click', target: 'w1.b2', app: 'notepad.exe' }, settings);
  assert.ok(risk.reasons.some(reason => reason.includes('read-only')), JSON.stringify(risk.reasons));
  assert.equal(risk.requiresApproval, true);
});

test('设置默认值与类型收敛', () => {
  const defaults = settingsDefaults();
  assert.deepEqual(defaults.budget, { maxMinutes: 10, maxActions: 60, maxVisionFrames: 20 });
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.profile, 'standard');
  assert.deepEqual(defaults.advanced.excludeProcesses, []);

  const normalized = normalizeSettings({
    enabled: 'yes',
    profile: 'yolo',
    unknown: 1,
    apps: { 'notepad.exe': 'allow', 'bad.exe': 'explode', 'weird': 5 },
    budget: { maxMinutes: 999, maxActions: -3, maxVisionFrames: 'x' },
    overlay: { glow: false },
    advanced: { maxDepth: 99, treeTimeoutMs: 10, excludeProcesses: ['Code.exe', 'code.exe', 7], vision: 'yes', auditPath: 42 },
  });
  assert.equal(normalized.enabled, false, '类型不对回默认值');
  assert.equal(normalized.profile, 'standard');
  assert.equal('unknown' in normalized, false, '未知字段被忽略');
  assert.deepEqual(Object.keys(normalized.apps), ['notepad.exe']);
  assert.equal(normalized.budget.maxMinutes, 60, '预算被夹到上限');
  assert.equal(normalized.budget.maxActions, 5, '预算被夹到下限');
  assert.equal(normalized.budget.maxVisionFrames, 20);
  assert.equal(normalized.overlay.glow, false);
  assert.equal(normalized.overlay.bubbles, true);
  assert.equal(normalized.advanced.maxDepth, 12);
  assert.equal(normalized.advanced.treeTimeoutMs, 200);
  assert.deepEqual(normalized.advanced.excludeProcesses, ['code.exe']);
  assert.equal(normalized.advanced.vision, true);
  assert.equal(normalized.advanced.auditPath, '');
});

test('normalizeKeys / labelOf / 预算', () => {
  assert.deepEqual(normalizeKeys('Ctrl + s'), ['CTRL+S']);
  assert.deepEqual(normalizeKeys(['Win', 'R']), ['WIN+R']);
  assert.equal(labelOf(0), '读取');
  assert.equal(labelOf({ level: 'R3', risk: 3 }), '提交');
  assert.deepEqual(normalizeBudget({ maxMinutes: 30, maxActions: 100 }), { maxMinutes: 30, maxActions: 100, maxVisionFrames: 20 });
});
