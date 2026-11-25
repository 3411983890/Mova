'use strict';
// 小球命中判定的回归护栏。
// 真实事故（2026-11-12 用户报）：点小球不恢复操作。两个原因叠加：
//  1) BALL 命中区算错了 —— bottom:92/size:96 在 DIP 下完全落不到 CSS 里那颗 bottom:22/size:44 的球上；
//  2) 钩子回调给的是**物理像素**，这里却直接和 DIP 矩形比较，scaleFactor=2 的机器上必然点不中。
const test = require('node:test');
const assert = require('node:assert');

const { createInterlock, BALL } = require('../../electron/desktop/interlock.cjs');

const fakeSession = (state = 'paused') => ({
  status: () => ({ state }),
  pause: () => ({ ok: true }),
  resume: () => ({ ok: true }),
});

const fakeScreen = (scaleFactor = 2, bounds = { x: 0, y: 0, width: 1440, height: 900 }) => {
  const display = { id: 1, primary: true, scaleFactor, bounds, workArea: bounds };
  return { getAllDisplays: () => [display], getPrimaryDisplay: () => display };
};

test('小球命中区与 overlay.css 对齐（DIP：left 24/bottom 22/size 44 外扩 12）', () => {
  const interlock = createInterlock({ session: fakeSession(), screen: fakeScreen(1) });
  const rect = interlock.ballRect();
  assert.equal(rect.x, 12);
  assert.equal(rect.w, 68);
  // 900-78 = 822 起，到 890 结束：把 y∈[834,878] 的那颗球包住了
  assert.equal(rect.y, 900 - BALL.bottom);
  assert.ok(rect.y <= 900 - 22 - 44, '命中区上沿要盖住球顶');
  assert.ok(rect.y + rect.h >= 900 - 22, '命中区下沿要盖住球底');
  interlock.dispose();
});

test('scaleFactor=2：物理坐标点在小球上要判为命中', () => {
  const interlock = createInterlock({ session: fakeSession(), screen: fakeScreen(2) });
  // 球心 DIP ≈ (46, 856) → 物理 (92, 1712)
  assert.equal(interlock.insideBall({ x: 92, y: 1712 }), true);
  // 换算回 DIP 也要对得上
  const dip = interlock.toDip({ x: 92, y: 1712 });
  assert.equal(Math.round(dip.x), 46);
  assert.equal(Math.round(dip.y), 856);
  interlock.dispose();
});

test('scaleFactor=2：直接把 DIP 当物理传进来（旧 bug）要判为不命中', () => {
  const interlock = createInterlock({ session: fakeSession(), screen: fakeScreen(2) });
  // 旧实现会把这个点当成命中（因为没换算），修好之后它只是屏幕中部
  assert.equal(interlock.insideBall({ x: 46, y: 856 }), false);
  interlock.dispose();
});

test('球外的点击不命中（不会误恢复）', () => {
  const interlock = createInterlock({ session: fakeSession(), screen: fakeScreen(2) });
  assert.equal(interlock.insideBall({ x: 1200, y: 300 }), false);
  assert.equal(interlock.insideBall({ x: 0, y: 0 }), false);
  interlock.dispose();
});

test('副屏（负坐标）上的小球按该屏 bounds 计算', () => {
  const main = { id: 1, primary: true, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
  const left = { id: 2, primary: false, scaleFactor: 1, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } };
  const screen = { getAllDisplays: () => [main, left], getPrimaryDisplay: () => main };
  const interlock = createInterlock({ session: fakeSession(), screen });
  const rect = interlock.ballRectOn(left);
  assert.equal(rect.x, -1280 + 12);
  assert.equal(rect.y, 1024 - BALL.bottom);
  assert.equal(interlock.insideBall({ x: -1260, y: 1024 - 40 }), true);
  interlock.dispose();
});

test('屏幕 API 不可用时不抛，退回 DIP 假设', () => {
  const interlock = createInterlock({ session: fakeSession(), screen: null });
  const rect = interlock.ballRect();
  assert.equal(rect.w, BALL.size);
  assert.doesNotThrow(() => interlock.insideBall({ x: 40, y: 850 }));
  interlock.dispose();
});
