import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHANNEL_OPTIONS, EFFORT_OPTIONS, REFRESH_OPTIONS, RUNNER_OPTIONS,
  accountBadge, accountDot, accountState,
  formatLastUsed, formatRecoverIn, formatResetIn,
  loginHeadline, loginStatusText,
  preferredAccountLabel, providerLabel,
  quotaPercent, quotaTone, quotaValueText, quotaWidth,
  refreshIntervalLabel, sortAccounts, sortUsageWindows, usageReasonText,
} from '../src/features/cli-models/cli-models-view.js';

// 固定「现在」：2026-11-13 12:00 本地时间（周五），避免测试依赖真实时钟。
const NOW = new Date(2026, 10, 13, 12, 0, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const account = (overrides = {}) => ({
  id: 'chatgpt-alice',
  provider: 'chatgpt',
  email: 'alice@example.com',
  plan: 'Plus',
  state: 'ready',
  active: false,
  usage: {
    checkedAt: NOW,
    windows: [
      { id: 'session', label: '5 小时窗口', usedPercent: 62, resetsAt: NOW + 130 * MINUTE },
      { id: 'weekly', label: '每周窗口', usedPercent: 34, resetsAt: NOW + 5 * 24 * HOUR },
    ],
  },
  ...overrides,
});

test('ready account with usage shows the ok badge', () => {
  const badge = accountBadge(account({ active: true }), NOW);
  assert.deepEqual(badge, { text: '可用', tone: 'ok' }, '有额度的可用账号应显示可用徽章');
});

test('account without usage is unknown, never ok', () => {
  const badge = accountBadge(account({ usage: undefined }), NOW);
  assert.equal(badge.tone, 'unknown', '没读过额度的账号必须显示为未检测');
  assert.equal(badge.text, '未检测', '未检测文案不能被写成已连接');
});

test('usage with a failure reason is unknown and keeps the reason text', () => {
  const badge = accountBadge(account({ usage: { checkedAt: NOW, reason: 'probeFailed', windows: [] } }), NOW);
  assert.equal(badge.tone, 'unknown', '额度读不到时徽章必须是 unknown 虚线');
  assert.equal(usageReasonText('probeFailed').includes('读取额度失败'), true, '原因文案要说明读取失败');
  assert.equal(/已连接|正常/.test(badge.text), false, '读不到额度时不许显示成已连接或正常');
});

test('usageReasonText prefers the probe detail over the generic reason', () => {
  // 同样是 probeFailed：401 是「上游拒绝」，network 是「连不上」，处理方式完全不同。
  assert.match(usageReasonText('probeFailed', 'http_401'), /上游拒绝了额度查询/);
  assert.match(usageReasonText('probeFailed', 'http_403'), /上游拒绝了额度查询/);
  assert.match(usageReasonText('probeFailed', 'network'), /连不上/);
  assert.match(usageReasonText('probeFailed', 'timeout'), /超时/);
  assert.match(usageReasonText('probeFailed', 'no_token'), /重新登录/);
  assert.match(usageReasonText('probeFailed', 'cli_managed'), /CLI 托管/);
  // 没有 detail 时回落到通用文案，不能变成空白。
  assert.equal(usageReasonText('probeFailed', '').includes('读取额度失败'), true);
});

test('expired credentials win over usage information', () => {
  assert.equal(accountState(account({ state: 'expired' }), NOW), 'expired', '过期账号状态应为 expired');
  assert.deepEqual(accountBadge(account({ state: 'expired' }), NOW), { text: '需要重新登录', tone: 'error' }, '过期账号提示重新登录');
});

test('limited account falls back to ready once limitedUntil has passed', () => {
  const future = account({ state: 'limited', limitedUntil: NOW + 3 * HOUR });
  const past = account({ state: 'limited', limitedUntil: NOW - HOUR });
  assert.deepEqual(accountBadge(future, NOW), { text: '额度用尽', tone: 'warn' }, '未到期的 limited 显示额度用尽');
  assert.equal(accountBadge(past, NOW).tone, 'ok', '过期后自动回到可用，不需要等主进程推送');
});

test('quota tone follows the remaining share (≤30% yellow, ≤10% red)', () => {
  // 入参是**已用量**，条子画的是**剩余**：占用低 = 剩余多 = 强调色。
  assert.equal(quotaTone(12), 'ok', '已用 12%（剩 88%）用强调色');
  assert.equal(quotaTone(69), 'ok', '已用 69%（剩 31%）仍是强调色');
  assert.equal(quotaTone(70), 'warn', '剩 30% 起转黄');
  assert.equal(quotaTone(89.4), 'warn', '剩 11% 仍是黄色');
  assert.equal(quotaTone(90), 'danger', '剩 10% 起转红');
  assert.equal(quotaTone(100), 'danger', '用满一定是红色');
  assert.equal(quotaTone(20, { limited: true }), 'danger', '账号被标记用尽时整组额度条转红');
});

test('quota width is the remaining share, and unknown data draws an empty bar', () => {
  assert.equal(quotaWidth(0), 100, '一点没用 = 满格');
  assert.equal(quotaWidth(-5), 100, '负的已用量夹到 0，剩满格');
  assert.equal(quotaWidth(62.4), 38, '已用 62% → 条宽是剩余 38%');
  assert.equal(quotaWidth(120), 2, '已用超 100 夹到 100，剩余保留最小 2% 让「几乎没有」看得见');
  assert.equal(quotaWidth(undefined), 0, '读不到额度时画空条，不能假装满格');
  assert.equal(quotaWidth(null), 0, 'null 同样画空条');
  assert.equal(quotaPercent('41'), 41, '字符串数字也要能解析');
  assert.equal(quotaValueText(62), '剩余 38%', '文案与进度条同口径，说剩余');
  assert.equal(quotaValueText(undefined), '额度未知', '读不到就直说未知');
});

test('reset countdown formats hours, minutes and long windows', () => {
  assert.equal(formatResetIn(NOW + 130 * MINUTE, NOW), '2 小时 10 分后重置', '两小时十分钟的窗口');
  assert.equal(formatResetIn(NOW + 2 * HOUR, NOW), '2 小时后重置', '整点小时不带 0 分');
  assert.equal(formatResetIn(NOW + 20 * MINUTE, NOW), '20 分后重置', '不足一小时只显示分钟');
  assert.equal(formatResetIn(NOW + 30_000, NOW), '即将重置', '不到一分钟直接说即将重置');
  assert.equal(formatResetIn(undefined, NOW), '重置时间未知', '没有重置时间不能编一个');

  const sunday = new Date(2026, 10, 15, 9, 0, 0, 0);
  assert.equal(sunday.getDay(), 0, '2026-11-15 是周日');
  assert.equal(formatResetIn(sunday.getTime(), NOW), '周日 09:00 重置', '超过 24 小时按本地时区给星期与时刻');
});

test('limited recovery text reuses the countdown wording', () => {
  const limited = account({ state: 'limited', limitedUntil: NOW + 192 * MINUTE });
  assert.equal(formatRecoverIn(limited, NOW), '3 小时 12 分后恢复', '恢复时间用「恢复」而不是「重置」');
  assert.equal(formatRecoverIn(account(), NOW), '等待额度恢复', '没有 limitedUntil 时不编造时间');
});

test('windows sort session → weekly → third-party', () => {
  const windows = [
    { id: '3p-shared', label: '第三方模型额度' },
    { id: 'weekly', label: 'Gemini 每周窗口' },
    { id: 'gemini-5h', label: 'Gemini 5 小时窗口' },
  ];
  assert.deepEqual(
    sortUsageWindows(windows).map(window => window.id),
    ['gemini-5h', 'weekly', '3p-shared'],
    '第三方模型用量排在每周窗口之后',
  );
  assert.equal(windows[0].id, '3p-shared', '排序不能就地修改入参');
});

test('accounts sort current first, then by pressure, expired last', () => {
  const busy = account({ id: 'b', email: 'b@example.com', usage: { windows: [{ id: 'session', usedPercent: 88 }] } });
  const fresh = account({ id: 'c', email: 'c@example.com', usage: { windows: [{ id: 'session', usedPercent: 10 }] } });
  const current = account({ id: 'a', email: 'z@example.com', active: true });
  const expired = account({ id: 'd', email: 'a@example.com', state: 'expired' });
  const sorted = sortAccounts([expired, busy, fresh, current], NOW);
  assert.deepEqual(sorted.map(item => item.id), ['a', 'c', 'b', 'd'], '当前账号置顶、压力小的在前、过期垫底');
});

test('dots map state to colour, unknown gets the dashed variant', () => {
  assert.equal(accountDot(account(), NOW), 'is-on', '可用账号是蓝色实心点');
  assert.equal(accountDot(account({ state: 'limited', limitedUntil: NOW + HOUR }), NOW), 'is-warn', '额度用尽是黄点');
  assert.equal(accountDot(account({ state: 'expired' }), NOW), 'is-danger', '凭据过期是红点');
  assert.equal(accountDot(account({ usage: undefined }), NOW), 'is-unknown', '未检测是虚线灰点');
});

test('login panel copy covers every contract state', () => {
  assert.equal(loginHeadline('waiting'), '等待浏览器授权', '等待授权是面板主标题');
  assert.equal(loginHeadline('failed'), '授权失败', '失败有独立标题');
  assert.equal(loginHeadline('nonsense'), '准备登录', '未知状态退回安全文案');
  assert.equal(loginStatusText('waiting'), '正在等待授权…', '状态行靠左显示等待中');
  assert.equal(loginStatusText('authorized').includes('额度'), true, '授权成功后说明正在读取额度');
});

test('select labels come from the design copy, not raw values', () => {
  assert.deepEqual(REFRESH_OPTIONS.map(option => option.label), ['1 分钟', '5 分钟', '15 分钟', '仅发送前'], '刷新间隔选项与原型一致');
  assert.equal(refreshIntervalLabel(-1), '仅发送前', '-1 表示仅发送前');
  assert.equal(refreshIntervalLabel(5), '5 分钟', '5 分钟是默认值');
  assert.equal(refreshIntervalLabel(99), '5 分钟', '未知值回退到默认项');
  assert.deepEqual(EFFORT_OPTIONS.map(option => option.label), ['低', '中', '高', '极高'], '思考强度四档');
  assert.deepEqual(CHANNEL_OPTIONS.map(option => option.value), ['chatgpt-plan', 'codex'], '通道取值来自契约');
  assert.equal(RUNNER_OPTIONS[0].label, '后台 CLI（ACP）', 'Gemini 执行器默认 ACP');
});

test('last-used, preferred label and provider name stay human readable', () => {
  assert.equal(formatLastUsed(new Date(2026, 10, 13, 12, 40).getTime()), '上次调用 12:40', '时间补零到两位');
  assert.equal(formatLastUsed(undefined), '还没有调用', '没有记录时明说没有调用');
  assert.equal(preferredAccountLabel([account()], 'chatgpt-alice'), 'alice@example.com', '优先账号显示邮箱');
  assert.equal(preferredAccountLabel([], undefined), '按剩余额度自动', '未设置时显示自动');
  assert.equal(providerLabel('gemini'), 'Gemini', 'provider 显示名');
});

test('第三方窗口不能被 "5h" 骗到最前面（3p-5h 排在 gemini-weekly 之后）', () => {
  const windows = [
    { id: '3p-5h', label: '第三方 5 小时额度' },
    { id: 'gemini-weekly', label: 'Gemini 每周窗口' },
    { id: 'gemini-5h', label: 'Gemini 5 小时窗口' },
    { id: '3p-weekly', label: '第三方每周额度' },
  ];
  assert.deepEqual(
    sortUsageWindows(windows).map(window => window.id),
    ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'],
    '第三方额度一律排在自有窗口之后（3p-5h 的 5h 只是后缀，不是「5 小时窗口」）',
  );
});

test('Gemini 额度探针的错误码都有中文文案，且不会退化成通用兜底', () => {
  const generic = '暂时读不到额度，稍后会自动重试。';
  const cases = {
    usage_cli_missing: '没有找到 antigravity CLI',
    usage_probe_timeout: '读取额度超时',
    usage_probe_spawn_failed: '没能启动额度探针进程',
    usage_probe_unavailable: '没有可用的伪终端',
    usage_parse_failed: '没解析出额度',
    usage_blocked: '不会替你确认',
  };
  for (const [code, expected] of Object.entries(cases)) {
    const text = usageReasonText('probeFailed', code);
    assert.ok(text.includes(expected), `${code} 应映射成「${expected}」，实际：${text}`);
    assert.notEqual(text, generic, `${code} 不该落到通用兜底文案`);
  }
  // 未知 detail 仍然回退到 reason 级文案（不要把未知识别成某个具体错误）。
  assert.equal(usageReasonText('probeFailed', 'something_new'), '读取额度失败，稍后会自动重试；这期间不会把账号当成可用。');
});
