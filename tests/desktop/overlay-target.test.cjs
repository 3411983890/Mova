'use strict';
/* global require */
// overlay.cjs 的目标控件矩形描边（§12.7）坐标换算单测。
//
// 只测纯函数 toLocalRect：测试环境没有 Electron app / screen，
// 绝不真的创建 BrowserWindow（也就不会在真实桌面上画出任何东西）。
const assert = require('node:assert/strict');
const { test } = require('node:test');

const overlay = require('../../electron/desktop/overlay/overlay.cjs');

const { createOverlay, toLocalRect, __test__ } = overlay;

/** 一块显示器：屏幕坐标（DIP）左上角 + 尺寸 + 缩放。 */
function display({ id = 1, x = 0, y = 0, width = 1920, height = 1080, scaleFactor = 1 } = {}) {
  return { id, scaleFactor, bounds: { x, y, width, height } };
}

/** UI 侧传进来的目标矩形（屏幕坐标，w/h 形式）。 */
function rect({ x = 0, y = 0, w = 100, h = 40 } = {}) {
  return { x, y, w, h };
}

test('模块导出：createOverlay 与纯函数 toLocalRect 都在', () => {
  assert.equal(typeof createOverlay, 'function');
  assert.equal(typeof toLocalRect, 'function');
  assert.equal(typeof __test__.toLocalRect, 'function');
  assert.equal(typeof __test__.normalizeRect, 'function');
  assert.equal(typeof __test__.normalizeBounds, 'function');
  // 不能因为导出纯函数就把 createOverlay 的用法改掉
  assert.deepEqual(Object.keys(overlay).sort(), ['__test__', 'createOverlay', 'toLocalRect'].sort());
});

test('同屏换算：屏幕坐标减去显示器原点', () => {
  const primary = display({ id: 1, x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(toLocalRect(rect({ x: 240, y: 160, w: 320, h: 44 }), primary), {
    x: 240,
    y: 160,
    w: 320,
    h: 44,
  });

  // 副屏在右边：显示器原点是 (1920, 0)，矩形要减掉这个偏移
  const right = display({ id: 2, x: 1920, y: 0, width: 1280, height: 1024 });
  assert.deepEqual(toLocalRect(rect({ x: 2020, y: 300, w: 200, h: 60 }), right), {
    x: 100,
    y: 300,
    w: 200,
    h: 60,
  });
});

test('负坐标副屏（左侧屏）：本地坐标不出现负数', () => {
  const left = display({ id: 3, x: -1280, y: -200, width: 1280, height: 1024 });
  assert.deepEqual(toLocalRect(rect({ x: -1200, y: -150, w: 300, h: 80 }), left), {
    x: 80,
    y: 50,
    w: 300,
    h: 80,
  });
});

test('跨屏：裁到该显示器上，只画落在里面的那部分', () => {
  const primary = display({ id: 1, x: 0, y: 0, width: 1920, height: 1080 });
  // 控件从 x=1800 延伸 300 → 只有 120px 落在主屏里
  assert.deepEqual(toLocalRect(rect({ x: 1800, y: 100, w: 300, h: 50 }), primary), {
    x: 1800,
    y: 100,
    w: 120,
    h: 50,
  });

  // 上下方向跨屏也一样
  const shortScreen = display({ id: 4, x: 0, y: 0, width: 1600, height: 900 });
  assert.deepEqual(toLocalRect(rect({ x: 100, y: 860, w: 50, h: 120 }), shortScreen), {
    x: 100,
    y: 860,
    w: 50,
    h: 40,
  });

  // 副屏（右侧）上被主屏切掉的那块，在副屏窗口里从 0 开始
  const right = display({ id: 2, x: 1920, y: 0, width: 1280, height: 1024 });
  assert.deepEqual(toLocalRect(rect({ x: 1800, y: 100, w: 300, h: 50 }), right), {
    x: 0,
    y: 100,
    w: 180,
    h: 50,
  });
});

test('目标完全在屏外：返回 null（调用方据此隐藏描边）', () => {
  const primary = display({ id: 1, x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(toLocalRect(rect({ x: 2600, y: 100, w: 200, h: 40 }), primary), null);
  assert.equal(toLocalRect(rect({ x: -300, y: 100, w: 200, h: 40 }), primary), null);
  assert.equal(toLocalRect(rect({ x: 100, y: -400, w: 200, h: 40 }), primary), null);
  assert.equal(toLocalRect(rect({ x: 100, y: 1200, w: 200, h: 40 }), primary), null);
  // 刚擦着边（右边界外一像素）也算屏外
  assert.equal(toLocalRect(rect({ x: 1920, y: 100, w: 50, h: 40 }), primary), null);
});

test('scaleFactor 2 不改变结果：屏幕坐标本来就是 DIP，不乘 2', () => {
  const at1 = display({ id: 1, x: 0, y: 0, width: 1440, height: 900, scaleFactor: 1 });
  const at2 = display({ id: 1, x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 });
  const target = rect({ x: 120, y: 90, w: 400, h: 60 });
  const a = toLocalRect(target, at1);
  const b = toLocalRect(target, at2);
  assert.deepEqual(b, a);
  assert.deepEqual(a, { x: 120, y: 90, w: 400, h: 60 });

  // 副屏 + 高 DPI 一起检查一次
  const retina = display({ id: 2, x: 1440, y: 0, width: 1280, height: 800, scaleFactor: 2 });
  assert.deepEqual(toLocalRect(rect({ x: 1540, y: 40, w: 100, h: 30 }), retina), {
    x: 100,
    y: 40,
    w: 100,
    h: 30,
  });
});

test('rect 缺字段不抛异常：缺的按 0、宽高非正视为没有目标', () => {
  const primary = display({ id: 1, x: 0, y: 0, width: 1920, height: 1080 });
  const cases = [
    null,
    undefined,
    {},
    { x: 10 },
    { y: 10 },
    { w: 100 },
    { x: 10, y: 10 },
    { x: 10, y: 10, w: 0, h: 40 },
    { x: 10, y: 10, w: 100, h: 0 },
    { x: 10, y: 10, w: -100, h: 40 },
    { x: 'abc', y: null, w: NaN, h: 40 },
    'not-a-rect',
    42,
  ];
  for (const bad of cases) {
    assert.doesNotThrow(() => toLocalRect(bad, primary), `不应抛异常：${JSON.stringify(bad)}`);
    assert.equal(toLocalRect(bad, primary), null, `应视为没有目标：${JSON.stringify(bad)}`);
  }

  // 缺 x/y 但宽高有效：按 0 处理，而不是整块丢掉
  assert.deepEqual(toLocalRect({ w: 120, h: 30 }, primary), { x: 0, y: 0, w: 120, h: 30 });
  // 字符串数字能救回来就用（UIA 走 JSON 时偶尔是字符串）
  assert.deepEqual(toLocalRect({ x: '20', y: '30', w: '40', h: '50' }, primary), {
    x: 20,
    y: 30,
    w: 40,
    h: 50,
  });
});

test('display 缺失或没有 bounds：返回 null 而不是崩', () => {
  assert.equal(toLocalRect(rect(), null), null);
  assert.equal(toLocalRect(rect(), undefined), null);
  assert.equal(toLocalRect(rect(), {}), null);
  assert.equal(toLocalRect(rect(), { bounds: null }), null);
  assert.equal(toLocalRect(rect(), { bounds: { x: 0, y: 0, width: 0, height: 0 } }), null);
});

test('兼容 {x,y,width,height} 写法，以及裸 bounds 对象', () => {
  const primary = display({ id: 1, x: 100, y: 50, width: 1920, height: 1080 });
  const expected = { x: 20, y: 30, w: 200, h: 40 };
  assert.deepEqual(toLocalRect({ x: 120, y: 80, width: 200, height: 40 }, primary), expected);
  // 直接把 bounds 当显示器传（老调用方的写法）
  assert.deepEqual(toLocalRect(rect({ x: 120, y: 80, w: 200, h: 40 }), primary.bounds), expected);
});

test('结果不越出窗口：四舍五入后仍落在显示器尺寸内', () => {
  const primary = display({ id: 1, x: 0, y: 0, width: 1440, height: 900 });
  const local = toLocalRect({ x: 1439.6, y: 899.7, w: 400, h: 300 }, primary);
  assert.ok(local, '贴着右下角的目标仍要画出来');
  assert.ok(local.x >= 0 && local.y >= 0);
  assert.ok(local.w > 0 && local.h > 0);
  assert.ok(local.x + local.w <= 1440, `x+w 越界：${local.x}+${local.w}`);
  assert.ok(local.y + local.h <= 900, `y+h 越界：${local.y}+${local.h}`);
});
