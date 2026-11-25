'use strict';
// 视觉接地（grounder）单测：全部用假 callModel，不碰真实桌面、不发网络请求。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGrounder } = require('../../electron/desktop/vision/grounder.cjs');

const SHOT = Buffer.from('fake-png-bytes');
const SIZE = [1280, 800];

/** policy 形状的最小设置。 */
function settingsOf(patch = {}) {
  return {
    advanced: { vision: true, ...(patch.advanced || {}) },
    budget: { maxVisionFrames: 20, ...(patch.budget || {}) },
  };
}

test('正常返回坐标：point 直接可用', async () => {
  const calls = [];
  const grounder = createGrounder({
    callModel: async (input) => {
      calls.push(input);
      return '{"action":"click","point":[100,200],"confidence":0.9}';
    },
  });
  const hit = await grounder.locate({ buffer: SHOT, size: SIZE, goal: '点击“确定”' });
  assert.equal(hit.ok, true, hit.code);
  assert.equal(hit.action, 'click');
  assert.deepEqual(hit.point, [100, 200]);
  assert.equal(hit.cached, false);
  assert.equal(calls.length, 1);
  // 注入契约：PNG base64 + sys/user 文本
  assert.equal(calls[0].image, SHOT.toString('base64'));
  assert.equal(typeof calls[0].system, 'string');
  assert.match(calls[0].prompt, /图像尺寸：1280x800/);
  assert.match(calls[0].prompt, /目标：点击“确定”/);
  assert.equal(grounder.stats().calls, 1);
});

test('mark 优先：带 ```json 围栏和解释文字也能解析', async () => {
  const grounder = createGrounder({
    callModel: async () => '目标在保存按钮上：\n```json\n{"action":"click","mark":2,"confidence":0.8}\n```\n（编号 #2）',
  });
  const hit = await grounder.locate({
    buffer: SHOT,
    size: SIZE,
    goal: '点击保存',
    marks: [{ id: 2, role: 'button', name: '保存', box: [10, 20, 100, 40] }],
  });
  assert.equal(hit.ok, true, hit.code);
  assert.equal(hit.mark, 2);
  assert.deepEqual(hit.point, [60, 40]);
});

test('越界坐标被拒：point-out-of-bounds', async () => {
  const grounder = createGrounder({
    callModel: async () => '{"action":"click","point":[9999,9999],"confidence":0.9}',
  });
  const hit = await grounder.locate({ buffer: SHOT, size: SIZE, goal: '点击“确定”' });
  assert.equal(hit.ok, false);
  assert.equal(hit.code, 'point-out-of-bounds');
});

test('视觉关闭时不发请求：vision-disabled', async () => {
  let calls = 0;
  const grounder = createGrounder({
    callModel: async () => { calls += 1; return '{"action":"click","point":[1,1]}'; },
    settings: () => settingsOf({ advanced: { vision: false } }),
  });
  const hit = await grounder.locate({ buffer: SHOT, size: SIZE, goal: '点击“确定”' });
  assert.equal(hit.ok, false);
  assert.equal(hit.code, 'vision-disabled');
  assert.equal(calls, 0, 'vision=false 时绝不能发请求');
});

test('帧预算耗尽后不再发请求：vision-budget-exhausted', async () => {
  let calls = 0;
  const grounder = createGrounder({
    callModel: async () => { calls += 1; return '{"action":"click","point":[10,10]}'; },
    settings: () => settingsOf({ budget: { maxVisionFrames: 1 } }),
  });
  const first = await grounder.locate({ buffer: SHOT, size: SIZE, goal: '先点 A' });
  assert.equal(first.ok, true, first.code);
  const second = await grounder.locate({ buffer: SHOT, size: SIZE, goal: '再点 B' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'vision-budget-exhausted');
  assert.equal(calls, 1, '每调用一次模型算一帧，超预算不得再发请求');
});

test('模型调用失败降级成 ground-model-failed，不抛异常', async () => {
  const grounder = createGrounder({
    callModel: async () => { throw Object.assign(new Error('接地模型 20s 超时'), { code: 'ground-model-failed' }); },
  });
  const hit = await grounder.locate({ buffer: SHOT, size: SIZE, goal: '点击“确定”' });
  assert.equal(hit.ok, false);
  assert.equal(hit.code, 'ground-model-failed');
  assert.match(hit.message, /超时/);
});

test('非法 JSON / 未知编号返回 bad-grounding，不抛异常', async () => {
  const noJson = createGrounder({ callModel: async () => '我觉得在右上角' });
  const first = await noJson.locate({ buffer: SHOT, size: SIZE, goal: '点击“确定”' });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'bad-grounding');

  const badMark = createGrounder({ callModel: async () => '{"action":"click","mark":7}' });
  const second = await badMark.locate({ buffer: SHOT, size: SIZE, goal: '点击“确定”', marks: [{ id: 1, box: [0, 0, 10, 10] }] });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'bad-grounding');
});
