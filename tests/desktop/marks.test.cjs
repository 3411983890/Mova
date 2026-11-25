'use strict';
// #N 视觉编号点击的路由：desktop_act {target:"#12"} → actions.click({x,y})
// 这条路径是自绘界面（微信 4.x）唯一的落点方式，锁住它避免以后回退。
const test = require('node:test');
const assert = require('node:assert');

const { createEngineOperations } = require('../../electron/desktop/tools.cjs');

function makeEngine(marks = { 1: { id: 1, x: 111, y: 222, name: '文件传输助手' } }) {
  const calls = { clicks: [] };
  const engine = {
    windows: { list: async () => [] },
    session: { status: () => ({ state: 'running' }), act: async () => ({ ok: true }) },
    actions: {
      click: async (point) => {
        calls.clicks.push(point);
        return { ok: true };
      },
    },
    status: () => ({ available: true, reason: '', session: { state: 'running' } }),
    resolveMark: (id) => marks[id] || null,
  };
  return { engine, calls };
}

test('target "#1" 会解析成坐标并点击', async () => {
  const { engine, calls } = makeEngine();
  const ops = createEngineOperations(engine);
  const result = await ops.act({ action: 'click', target: '#1' });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'mark');
  assert.equal(result.mark, 1);
  assert.deepEqual(calls.clicks[0], { x: 111, y: 222 });
});

test('编号不存在时返回 stale-mark，不会乱点', async () => {
  const { engine, calls } = makeEngine({});
  const ops = createEngineOperations(engine);
  await assert.rejects(
    () => ops.act({ action: 'click', target: '#9' }),
    (error) => error.code === 'stale-mark',
  );
  assert.equal(calls.clicks.length, 0);
});

test('编号只能用于 click', async () => {
  const { engine } = makeEngine();
  const ops = createEngineOperations(engine);
  await assert.rejects(
    () => ops.act({ action: 'type', target: '#1', value: 'x' }),
    (error) => error.code === 'invalid-argument',
  );
});

test('引擎没有 resolveMark 时明确报 not-implemented', async () => {
  const { engine } = makeEngine();
  delete engine.resolveMark;
  const ops = createEngineOperations(engine);
  await assert.rejects(
    () => ops.act({ action: 'click', target: '#1' }),
    (error) => error.code === 'not-implemented',
  );
});
