'use strict';
// Action risk classification. Pure and easy to unit-test.
//
// 2026-11-13 放宽口径（用户要求）：只有「必须由本人完成」的动作才停下交给用户，
// 普通的「立即购买 / 加入购物车 / 结算 / 下单」属于正常购物流程，AI 可以直接做。
//
// 两类概念必须分开，混在一起会导致两种错误：
// 1) handoff（停手，交还用户）—— 银行卡信息、扫码支付、密码/验证码这类 AI 拿不到、
//    也不该代填的东西。继续做只会失败或泄露。
// 2) approval（继续做，但先确认）—— 删除、转账、授权签约这类不可逆或动钱的动作。
// 购买下单不是第 2 类：它可撤销、可退款，而且用户明确允许。

const READ_ACTIONS = new Set(['snapshot', 'read', 'wait', 'tabs', 'screenshot']);
const SAFE_ACTION = /^(click|fill|type|press|select|check|hover|scroll)$/i;

/** 银行卡/卡片资料的填写：必须本人。选择器里的 card-number / credit_card 也要认。 */
const CARD = /(卡号|银行卡号|信用卡号|持卡人|安全码|\bcvv\b|\bcvc\b|\bcard[\s_-]?number\b|\bcredit[\s_-]?card[\s_-]?(?:number|details|info)\b|\bdebit[\s_-]?card[\s_-]?number\b|添加银行卡|绑定银行卡|填写银行卡|输入银行卡|银行卡信息)/i;

/** 扫码支付 / 付款码：必须本人用手机完成。 */
const QR_PAY = /(扫码支付|扫码付款|二维码支付|付款码|收款码|扫一扫支付|出示付款码|\bscan (?:the )?qr(?: code)?\b|\bscan to pay\b|\bqr ?code payment\b)/i;

/** 密码/验证码/二次验证：必须本人输入（AI 代填等于替用户保管凭据）。 */
const CREDENTIAL = /(支付密码|动态码|短信验证码|验证码|密码|\bpassword\b|\bpasscode\b|\bcaptcha\b|\bone[- ]time code\b|\botp\b)/i;
/** 「忘记密码 / 修改密码」只是入口按钮，点它并不需要用户输入任何东西。 */
const CREDENTIAL_ENTRY_PAGE = /(忘记密码|找回密码|重置密码|修改密码|设置密码|密码登录|forgot password|reset password|change password)/i;

/** 不可逆或动钱的动作：允许做，但每次都要确认。 */
const DESTRUCTIVE = /(转账|汇款|打款|提现|付款给|删除|注销|清空|解绑|移除|停用账号|注销账号|\btransfer\b|\bwithdraw\b|\bdelete\b|remove account|\bunlink\b|\bwipe\b)/i;

/** 正常购物流程：按等级放行，不再每次单独确认。 */
const FINANCIAL = /(支付|付款|购买|下单|提交订单|结算|立即购买|确认支付|去支付|支付订单|加入购物车|\bbuy now\b|\bplace order\b|\bcheckout\b|\bpurchase\b|\bpay\b|\border now\b|confirm (?:and )?pay)/i;

const HANDOFF_LABELS = Object.freeze({
  'card-entry': '需要本人填写银行卡信息',
  'qr-payment': '扫码支付需要本人用手机完成',
  'credential': '需要本人输入密码或验证码',
});

function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/**
 * 这段文字是否必须交还给人操作；返回稳定的原因码或空串。
 * @param {string} text 目标名称/输入值等可读文字
 * @returns {''|'card-entry'|'qr-payment'|'credential'}
 */
function handoffReasonOf(text) {
  const haystack = String(text || '');
  if (!haystack) return '';
  if (CARD.test(haystack)) return 'card-entry';
  if (QR_PAY.test(haystack)) return 'qr-payment';
  if (CREDENTIAL.test(haystack) && !CREDENTIAL_ENTRY_PAGE.test(haystack)) return 'credential';
  return '';
}

function handoffLabelOf(reason) {
  return HANDOFF_LABELS[reason] || '需要本人完成这一步';
}

/**
 * @param {{action?:string, value?:string, submit?:boolean, target?:string, url?:string}} input
 * @returns {{level:0|1|2|3, reasons:string[], origin:string, handoff:boolean, handoffReason:string}}
 */
function classifyAction(input = {}) {
  const action = String(input.action || '').toLowerCase();
  const reasons = [];
  let level = 2;
  if (READ_ACTIONS.has(action)) level = 0;
  else if (action === 'navigate') level = 1;
  else if (!SAFE_ACTION.test(action)) {
    level = 3;
    reasons.push('unknown-action');
  }

  if (input.submit === true) {
    level = Math.max(level, 3);
    reasons.push('submit');
  }
  if (action === 'press' && /enter/i.test(String(input.value || ''))) {
    level = Math.max(level, 3);
    reasons.push('enter-may-submit');
  }

  const haystack = `${input.target || ''} ${input.value || ''}`;
  const handoffReason = handoffReasonOf(haystack);
  if (handoffReason) {
    // 停手：等级只用于审批卡文案，真正的行为是「交给用户」。
    level = 3;
    reasons.push(handoffLabelOf(handoffReason));
  } else if (DESTRUCTIVE.test(haystack)) {
    level = 3;
    reasons.push('不可逆操作');
  } else if (FINANCIAL.test(haystack)) {
    // 购买/下单/支付按钮：保持交互等级（不额外确认），只留一条原因说明。
    level = Math.max(level, 2);
    reasons.push('涉及付款，属于正常购物流程');
  }
  return { level, reasons, origin: originOf(input.url), handoff: Boolean(handoffReason), handoffReason };
}

function labelOf(risk) {
  if (risk.level === 0) return '读取';
  if (risk.level === 1) return '导航';
  if (risk.level === 2) return '交互';
  return '提交';
}

/** 兼容旧调用：只判断「这段文字是否必须交还用户」。 */
const DANGER = new RegExp(`${CARD.source}|${QR_PAY.source}|${CREDENTIAL.source}`, 'i');

module.exports = {
  classifyAction,
  handoffReasonOf,
  handoffLabelOf,
  labelOf,
  originOf,
  DANGER,
  HANDOFF: { CARD, QR_PAY, CREDENTIAL },
  CREDENTIAL_ENTRY_PAGE,
  DESTRUCTIVE,
  FINANCIAL,
};
