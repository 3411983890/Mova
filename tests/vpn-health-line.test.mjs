/**
 * 负责：设置页「线路健康状态」那一行的纯逻辑（`src/features/vpn/vpn-health-line.jsx` 的导出函数）。
 * 不负责：React 渲染、真实测速（`electron/vpn/health.mjs` 有自己的测试）。
 * 被谁调用：`node --test`。
 *
 * 为什么钉子在这里：这一行是用户判断「现在这条线路行不行」的唯一入口。
 * 最容易出的错是「没测过却显示得像很好」——比如把 `null` 延迟格式化成 `0 ms`、
 * 或者把跨地区切换和普通切换长得一样（后者是账号风控的雷）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { delayText, delayTone, healthLineModel, sinceText } from '../src/features/vpn/vpn-health-view.mjs';

const NOW = Date.UTC(2026, 10, 14, 5, 0, 0);

test('sinceText：刚刚 / 分钟 / 小时 / 日期四档，0 返回空串', () => {
  assert.equal(sinceText(0, NOW), '', '没有时间就说没有，不要伪造「刚刚」');
  assert.equal(sinceText(NOW - 5_000, NOW), '刚刚');
  assert.equal(sinceText(NOW - 3 * 60_000, NOW), '3 分钟前');
  assert.equal(sinceText(NOW - 2 * 3_600_000, NOW), '2 小时前');
  assert.match(sinceText(NOW - 3 * 86_400_000, NOW), /月.*日/, '超过一天给日期');
  // 未来时间（时钟漂移）不能算出负数。
  assert.equal(sinceText(NOW + 60_000, NOW), '刚刚');
});

test('delayTone / delayText：没测到一律「未测速」，绝不显示 0 ms', () => {
  assert.equal(delayTone(null), 'untested');
  assert.equal(delayTone(undefined), 'untested');
  assert.equal(delayTone(0), 'untested');
  assert.equal(delayTone(-5), 'untested');
  assert.equal(delayText(null), '未测速');
  assert.equal(delayText(0), '未测速');
  assert.equal(delayText(Number.NaN), '未测速');

  assert.equal(delayTone(120), 'ok');
  assert.equal(delayTone(300), 'ok');
  assert.equal(delayTone(301), 'warn');
  assert.equal(delayTone(800), 'warn');
  assert.equal(delayTone(801), 'bad');
  assert.equal(delayText(210.6), '211 ms', '延迟取整，不显示小数');
});

test('healthLineModel：没数据时显示「还没有可用节点 / 还没有检查过」', () => {
  const model = healthLineModel(null, NOW);
  assert.equal(model.title, '还没有可用节点');
  assert.equal(model.checked, '还没有检查过');
  assert.equal(model.delay, '未测速');
  assert.equal(model.tone, 'untested');
  assert.equal(model.switchNote, '');
  assert.equal(model.crossRegion, false);
});

test('healthLineModel：健康时给出节点、地区、延迟与检查时间', () => {
  const model = healthLineModel({
    activeNode: '🇹🇼[家宽][Gemini]台湾hy5',
    region: { code: 'TW', label: '台湾' },
    checkedAt: NOW - 2 * 60_000,
    delayMs: 268,
    members: [{ failures: 0 }, { failures: 0 }],
  }, NOW);
  assert.equal(model.title, '🇹🇼[家宽][Gemini]台湾hy5');
  assert.equal(model.regionLabel, '台湾');
  assert.equal(model.delay, '268 ms');
  assert.equal(model.tone, 'ok');
  assert.equal(model.checked, '2 分钟前检查');
  assert.equal(model.unhealthy, 0);
});

test('healthLineModel：未知地区不显示成某个国家', () => {
  const model = healthLineModel({ activeNode: 'Node-7', region: { code: 'ZZ' }, delayMs: 100 }, NOW);
  assert.equal(model.regionLabel, '未知地区');
});

test('healthLineModel：同地区切换与跨地区切换必须可区分', () => {
  const sameRegion = healthLineModel({
    activeNode: '日本-B',
    switched: { from: '日本-A', to: '日本-B', crossRegion: false, at: NOW },
  }, NOW);
  assert.match(sameRegion.switchNote, /已切到同地区节点/);
  assert.equal(sameRegion.crossRegion, false);

  const crossRegion = healthLineModel({
    activeNode: '美国-2',
    switched: { from: '日本-唯一', to: '美国-2', crossRegion: true, at: NOW },
  }, NOW);
  assert.match(crossRegion.switchNote, /已跨地区切换/);
  assert.match(crossRegion.switchNote, /风控/, '跨地区必须提示账号风控风险');
  assert.equal(crossRegion.crossRegion, true);
});

test('healthLineModel：统计连续失败节点数（用于「已降低优先级」提示）', () => {
  const model = healthLineModel({
    activeNode: 'A',
    members: [{ failures: 0 }, { failures: 3 }, { failures: 5 }, { failures: 0 }],
  }, NOW);
  assert.equal(model.unhealthy, 2);
});
