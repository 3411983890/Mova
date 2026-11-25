import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeReset,
  normalizeChatgptUsage,
  normalizeGeminiSummary,
  probeChatgpt,
  probeGemini,
} from '../electron/subscription/usage.mjs';

const NOW = 1_700_000_000_000;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('ChatGPT: primary/secondary map to session/weekly by limit_window_seconds', () => {
  const snapshot = normalizeChatgptUsage({
    checkedAt: NOW,
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 42.4, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
    },
  });
  assert.equal(snapshot.checkedAt, NOW, 'checkedAt 由调用方给定');
  assert.equal(snapshot.plan, 'plus', '套餐要透传');
  assert.deepEqual(snapshot.windows.map(window => window.id), ['session', 'weekly'], '窗口按 session→weekly 排列');
  assert.equal(snapshot.windows[0].usedPercent, 42, 'usedPercent 取整');
  assert.equal(snapshot.windows[0].windowDurationMins, 300, '5 小时窗口 = 300 分钟');
  assert.equal(snapshot.windows[0].resetsAt, 1_800_000_000_000, '秒级 reset_at 要转成毫秒');
  assert.equal(snapshot.windows[1].usedPercent, 12, '次窗口用量单独记');
  assert.equal(snapshot.reason, undefined, '读到了就不该有 reason');
});

test('ChatGPT: free/go plans fall back to a monthly main window', () => {
  const snapshot = normalizeChatgptUsage({
    checkedAt: NOW,
    plan_type: 'free',
    rate_limit: {
      primary_window: { used_percent: 5 },
      secondary_window: { used_percent: 1 },
    },
  });
  assert.deepEqual(snapshot.windows.map(window => window.id), ['weekly', 'monthly'], '免费档主窗口按月、次窗口按周');
  const monthly = snapshot.windows.find(window => window.id === 'monthly');
  assert.equal(monthly.windowDurationMins, 43_200, '月窗口 = 43200 分钟');
  assert.equal(monthly.label, '每月窗口', '标签要写明月窗口');
  const paid = normalizeChatgptUsage({
    checkedAt: NOW,
    plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 1 }, secondary_window: { used_percent: 2 } },
  });
  assert.equal(paid.windows[0].windowDurationMins, 300, '付费档主窗口是 5 小时');
});

test('ChatGPT: model-level limits (limit_id other than codex) stay out of the main list', () => {
  const snapshot = normalizeChatgptUsage({
    checkedAt: NOW,
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 90, limit_window_seconds: 18_000, limit_id: 'gpt-5-codex-mini' },
      secondary_window: { used_percent: 30, limit_window_seconds: 18_000, limit_id: 'codex' },
    },
  });
  assert.deepEqual(snapshot.windows.map(window => window.usedPercent), [30], '只保留 codex 窗口');
  const empty = normalizeChatgptUsage({ checkedAt: NOW, plan_type: 'plus' });
  assert.deepEqual(empty, { checkedAt: NOW, plan: 'plus', windows: [], reason: 'unsupported' }, '没有窗口时给 unsupported');
});

test('probeChatgpt sends the documented headers and never throws on failure', async () => {
  const calls = [];
  const payload = {
    plan_type: 'plus',
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18_000 } },
  };
  const ok = await probeChatgpt({
    fetch: async (url, options) => { calls.push({ url, options }); return jsonResponse(payload); },
    accessToken: 'access-value',
    accountId: 'acct_a',
    now: () => NOW,
  });
  assert.equal(calls.length, 1, '一次探针只发一个请求');
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage', '端点必须与 §8.1 一致');
  assert.equal(calls[0].options.headers.authorization, 'Bearer access-value', '要带 bearer');
  assert.equal(calls[0].options.headers['openai-beta'], 'codex-1', '要带 openai-beta');
  assert.equal(calls[0].options.headers.originator, 'Mova', '要带 originator');
  assert.equal('chatgpt-account-id' in calls[0].options.headers, false, '本机 id 不是上游 account id，不能乱带');
  assert.equal(ok.windows[0].usedPercent, 7, '正常返回要归一化');
  assert.equal(ok.checkedAt, NOW, 'checkedAt 用注入的 now');

  const failed = await probeChatgpt({
    fetch: async () => { throw new Error('ECONNRESET'); },
    accessToken: 'access-value',
    accountId: 'acct_a',
    now: () => NOW,
  });
  // 失败快照必须带 detail（状态码/分类）：排查「额度读不到」时，401 与 404 的处置完全不同，
  // 全靠这一格区分。响应体永远不进这里。
  assert.deepEqual(failed, { checkedAt: NOW, windows: [], reason: 'probeFailed', detail: 'network' }, '网络失败不抛，返回 probeFailed');

  const unauthorised = await probeChatgpt({
    fetch: async () => jsonResponse({ error: 'invalid_token' }, 401),
    accessToken: 'access-value',
    now: () => NOW,
  });
  assert.equal(unauthorised.reason, 'probeFailed', '401 也只报 probeFailed，由上层标记 expired');
});

test('Gemini: gemini-*, argon, carbon and 3p buckets land in separate families', () => {
  const snapshot = normalizeGeminiSummary({
    buckets: [
      { bucketId: 'gemini-2.5-pro', window: '5h', usedPercent: 40 },
      { bucketId: 'gemini-2.5-pro', window: 'weekly', usedPercent: 70 },
      { bucketId: 'gemini-argon-2.5-flash', window: '5h', usedPercent: 10 },
      { bucketId: 'gemini-carbon-2.5-flash', window: 'weekly', usedPercent: 20 },
      { bucketId: '3p-claude-sonnet', window: '5h', usedPercent: 55 },
      { bucketId: 'someone-elses-bucket', window: '5h', usedPercent: 99 },
    ],
  }, NOW);
  const ids = snapshot.windows.map(window => window.id);
  assert.deepEqual(
    [...ids].sort(),
    ['3p-shared', 'gemini-5h', 'gemini-argon-5h', 'gemini-carbon-weekly', 'gemini-weekly'],
    '四类家族 + 未知 bucket 被丢弃',
  );
  assert.ok(ids.indexOf('gemini-5h') < ids.indexOf('gemini-weekly'), 'session 窗口排在 weekly 之前');
  const shared = snapshot.windows.find(window => window.id === '3p-shared');
  // 不能用「共享池」这种说法：Mova 里 ChatGPT 与 Gemini 的额度完全独立，
  // 这个 bucket 只代表「本账号下的第三方模型用量」。
  assert.equal(shared.label, '第三方模型额度', '3p-* 是本账号下的第三方模型用量');
  assert.equal(shared.usedPercent, 55, '3p 用量单独展示');
  const argon = snapshot.windows.find(window => window.id === 'gemini-argon-5h');
  assert.match(argon.label, /Argon/, 'argon 家族要有自己的标签');
  assert.equal(argon.windowDurationMins, 300, '5h 窗口 = 300 分钟');
  assert.equal(snapshot.windows.find(window => window.id === 'gemini-carbon-weekly').windowDurationMins, 10_080, 'weekly = 7 天');
});

test('Gemini: buckets from the two hosts are merged by bucketId, first data wins', () => {
  const snapshot = normalizeGeminiSummary({
    buckets: [
      { bucketId: 'gemini-2.5-pro', window: '5h' },
      { bucketId: 'gemini-2.5-pro', window: '5h', used_percent: 33, resets_at: 1_800_000_000 },
      { bucketId: 'gemini-2.5-pro', window: '5h', used_percent: 88 },
    ],
  }, NOW);
  assert.equal(snapshot.windows.length, 1, '同一个 bucketId 只能出一条');
  assert.equal(snapshot.windows[0].usedPercent, 33, '没有数据的桶不占位，先给数据的那条生效');
  assert.equal(snapshot.windows[0].resetsAt, 1_800_000_000_000, 'reset 时间也要带过来');
});

test('probeGemini returns noProject without touching the network when project is missing', async () => {
  let calls = 0;
  const snapshot = await probeGemini({
    fetch: async () => { calls += 1; return jsonResponse({}); },
    refreshToken: 'refresh-value',
    clientId: 'client',
    clientSecret: 'secret',
    projectId: undefined,
    now: () => NOW,
  });
  assert.deepEqual(snapshot, { checkedAt: NOW, windows: [], reason: 'noProject' }, '缺 project 直接 noProject');
  assert.equal(calls, 0, '缺 project 时不应发请求');
});

test('probeGemini asks both hosts and keeps the data when one of them fails', async () => {
  const urls = [];
  const snapshot = await probeGemini({
    fetch: async (url, options) => {
      urls.push(url);
      if (url === 'https://oauth2.googleapis.com/token') {
        assert.match(options.body, /grant_type=refresh_token/, '先换 access token');
        return jsonResponse({ access_token: 'google-access' });
      }
      if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
        return jsonResponse({ buckets: [{ bucketId: 'gemini-2.5-pro', window: '5h', usedPercent: 15 }] });
      }
      return jsonResponse({ error: 'boom' }, 500);
    },
    refreshToken: 'refresh-value',
    clientId: 'client',
    clientSecret: 'secret',
    projectId: 'proj-1',
    now: () => NOW,
  });
  assert.equal(urls.length, 3, '换 token + 两个 host 各问一次');
  assert.deepEqual(urls.slice(1), [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  ], '两个 host 都必须问（§8.2）');
  assert.deepEqual(snapshot.windows.map(window => window.id), ['gemini-5h'], '一个 host 失败不影响另一个 host 的数据');
});

test('probeGemini reports probeFailed when the refresh token is rejected or both hosts fail', async () => {
  const rejected = await probeGemini({
    fetch: async () => jsonResponse({ error: 'invalid_grant' }, 400),
    refreshToken: 'refresh-value',
    clientId: 'client',
    clientSecret: 'secret',
    projectId: 'proj-1',
    now: () => NOW,
  });
  assert.equal(rejected.reason, 'probeFailed', 'refresh 失败 → probeFailed');
  assert.deepEqual(rejected.windows, [], '失败快照不带窗口');

  const bothDown = await probeGemini({
    fetch: async url => (url === 'https://oauth2.googleapis.com/token'
      ? jsonResponse({ access_token: 'google-access' })
      : jsonResponse({}, 503)),
    refreshToken: 'refresh-value',
    clientId: 'client',
    clientSecret: 'secret',
    projectId: 'proj-1',
    now: () => NOW,
  });
  assert.equal(bothDown.reason, 'probeFailed', '两个 host 都失败 → probeFailed');
});

test('describeReset speaks human hours/minutes below one day', () => {
  assert.equal(describeReset(NOW + 2 * 3_600_000 + 10 * 60_000, NOW), '2 小时 10 分后重置', '2 小时 10 分');
  assert.equal(describeReset(NOW + 3 * 3_600_000, NOW), '3 小时后重置', '整小时不带分');
  assert.equal(describeReset(NOW + 90_000, NOW), '2 分后重置', '不足两分钟按一分钟以上显示');
});

test('describeReset falls back to weekday + local time beyond 24h, and stays empty when past', () => {
  const at = new Date(2026, 10, 15, 9, 0, 0);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][at.getDay()];
  assert.equal(
    describeReset(at.getTime(), at.getTime() - 3 * 86_400_000),
    `${weekday} 09:00 重置`,
    '超过 24h 要落到具体星期与时刻',
  );
  assert.equal(describeReset(at.getTime(), at.getTime()), '', '已到点不显示');
  assert.equal(describeReset(undefined, NOW), '', '没有时间就不显示');
  assert.equal(
    describeReset(NOW + 2 * 3_600_000 + 10 * 60_000, NOW, 'en-US'),
    'resets in 2h 10m',
    '英文语境也要能用',
  );
});
