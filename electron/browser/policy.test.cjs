const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyAction, handoffReasonOf, handoffLabelOf, labelOf, originOf } = require('./policy.cjs');

test('classifies reads, navigation and ordinary interaction', () => {
  assert.equal(classifyAction({ action: 'snapshot' }).level, 0);
  assert.equal(classifyAction({ action: 'read' }).level, 0);
  assert.equal(classifyAction({ action: 'navigate' }).level, 1);
  assert.equal(classifyAction({ action: 'click', target: 'css=#go' }).level, 2);
  assert.equal(classifyAction({ action: 'fill', target: 'css=#q' }).level, 2);
});

test('ordinary shopping is allowed: buy now, checkout and pay buttons stay interactive', () => {
  for (const label of ['立即购买', '确认支付', '去支付', '提交订单', '结算', '加入购物车', 'Buy now', 'Place order']) {
    const risk = classifyAction({ action: 'click', target: label });
    assert.equal(risk.level, 2, `${label} 应保持交互等级`);
    assert.equal(risk.handoff, false, `${label} 不应停下交还用户`);
    assert.ok(risk.reasons.includes('涉及付款，属于正常购物流程'));
  }
});

test('only bank-card, QR payment and credential entry require a human handoff', () => {
  const cases = [
    ['填写银行卡号', 'card-entry'],
    ['持卡人姓名', 'card-entry'],
    ['CVV', 'card-entry'],
    ['添加银行卡', 'card-entry'],
    ['扫码支付', 'qr-payment'],
    ['出示付款码', 'qr-payment'],
    ['Scan the QR code to pay', 'qr-payment'],
    ['输入短信验证码', 'credential'],
    ['支付密码', 'credential'],
    ['密码', 'credential'],
  ];
  for (const [label, reason] of cases) {
    const risk = classifyAction({ action: 'click', target: label });
    assert.equal(risk.handoff, true, `${label} 必须交还用户`);
    assert.equal(risk.handoffReason, reason);
    assert.equal(risk.level, 3);
    assert.match(risk.reasons.join('、'), /本人/);
  }
  assert.equal(handoffReasonOf('立即支付'), '', '单纯支付按钮不是停手理由');
  assert.equal(handoffReasonOf('忘记密码'), '', '忘记密码只是入口按钮');
  assert.equal(handoffReasonOf('修改密码'), '');
  assert.equal(handoffReasonOf('显示密码'), 'credential', '查看/输入密码仍要停手');
  assert.match(handoffLabelOf('card-entry'), /银行卡/);
  assert.equal(handoffLabelOf('other'), '需要本人完成这一步');
});

test('destructive and money-moving actions stay at level 3 but are not handoffs', () => {
  for (const label of ['删除账号', '注销', '转账', '汇款给张三', 'delete account', 'Transfer money']) {
    const risk = classifyAction({ action: 'click', target: label });
    assert.equal(risk.level, 3, `${label} 需要确认`);
    assert.equal(risk.handoff, false, `${label} 仍然由 AI 确认后执行`);
    assert.ok(risk.reasons.includes('不可逆操作'));
  }
});

test('submits, Enter and unknown actions still fail closed', () => {
  const submit = classifyAction({ action: 'click', submit: true, target: '立即购买' });
  assert.equal(submit.level, 3);
  assert.equal(submit.handoff, false, '提交需要确认，但不必交还用户');
  assert.ok(submit.reasons.includes('submit'));

  assert.equal(classifyAction({ action: 'press', value: 'Enter' }).level, 3);
  assert.equal(classifyAction({ action: 'upload' }).level, 3);
  assert.ok(classifyAction({ action: 'upload' }).reasons.includes('unknown-action'));
});

test('origins and labels are unchanged for the approval card', () => {
  assert.equal(originOf('https://shop.example.com/orders?x=1'), 'https://shop.example.com');
  assert.equal(originOf('not a url'), '');
  assert.equal(labelOf({ level: 0 }), '读取');
  assert.equal(labelOf({ level: 3 }), '提交');
});
