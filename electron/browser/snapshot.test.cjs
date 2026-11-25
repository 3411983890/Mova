const assert = require('node:assert/strict');
const { test } = require('node:test');
const { capture, frameModeOf } = require('./snapshot.cjs');

let sequence = 0;

/** 把嵌套描述展开成 CDP 的 AXNode 数组（nodeId/parentId/childIds）。 */
function axTree(spec) {
  const nodes = [];
  const walk = (row, parentId) => {
    const id = `n${++sequence}`;
    const out = {
      nodeId: id,
      role: { value: row.role },
      name: { value: row.name || '' },
      ...(parentId ? { parentId } : {}),
      ...(row.backendDOMNodeId ? { backendDOMNodeId: row.backendDOMNodeId } : {}),
      childIds: (row.children || []).map(child => walk(child, id)),
    };
    nodes.push(out);
    return id;
  };
  walk(spec, null);
  return nodes;
}

function fakeCdp({ main, frames = [], frameTrees = {} }) {
  return {
    guest: { getURL: () => 'https://shop.example.com/cart', getTitle: () => '购物车' },
    async send(method, params = {}) {
      if (method === 'Accessibility.getFullAXTree') {
        if (params.frameId) {
          const nodes = frameTrees[params.frameId];
          if (!nodes) throw Object.assign(new Error('frame is gone'), { code: 'frame-gone' });
          return { nodes };
        }
        return { nodes: main };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root' }, childFrames: frames.map(frame => ({ frame })) } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

// e12（36 进制）= backendDOMNodeId 38，和快照里的 [ref=e12] 一一对应。
const PAY_BACKEND_ID = Number.parseInt('12', 36);

function pageFixture() {
  sequence = 0;
  const main = axTree({
    role: 'RootWebArea',
    children: [
      { role: 'heading', name: '购物车' },
      { role: 'button', name: '立即支付', backendDOMNodeId: PAY_BACKEND_ID },
    ],
  });
  const frameNodes = axTree({ role: 'RootWebArea', children: [{ role: 'button', name: '框架里的按钮' }] });
  return { nodes: main, frameNodes };
}

const FRAME = { id: 'frame-1', url: 'https://embed.example.com/widget' };

test('frames default to an index instead of inlining every iframe', async () => {
  const { nodes, frameNodes } = pageFixture();
  const result = await capture(fakeCdp({ main: nodes, frames: [FRAME], frameTrees: { 'frame-1': frameNodes } }), {});
  assert.match(result.text, /button "立即支付"/);
  assert.match(result.text, /iframe f1 "https:\/\/embed\.example\.com\/widget"/, '默认只列 iframe 编号，不抓内容');
  assert.doesNotMatch(result.text, /框架里的按钮/);
  assert.deepEqual(result.frames.map(frame => frame.id), ['f1']);
});

test('frames:"all" keeps the old inline behaviour, frames:"none" skips frames', async () => {
  const { nodes, frameNodes } = pageFixture();
  const all = await capture(fakeCdp({ main: nodes, frames: [FRAME], frameTrees: { 'frame-1': frameNodes } }), { frames: 'all' });
  assert.match(all.text, /框架里的按钮/);
  assert.equal(all.frames[0].readable, true);

  const { nodes: nodes2, frameNodes: frameNodes2 } = pageFixture();
  const none = await capture(fakeCdp({ main: nodes2, frames: [FRAME], frameTrees: { 'frame-1': frameNodes2 } }), { frames: 'none' });
  assert.doesNotMatch(none.text, /iframe f1/);
  assert.deepEqual(none.frames, []);
  assert.equal(frameModeOf({ scope: 'main' }), 'none', '旧参数 scope:main 仍然不取 iframe');
});

test('reading one frame on demand returns its subtree only', async () => {
  const { nodes, frameNodes } = pageFixture();
  const result = await capture(fakeCdp({ main: nodes, frames: [FRAME], frameTrees: { 'frame-1': frameNodes } }), { frame: 'f1' });
  assert.match(result.text, /scope frame:f1/);
  assert.match(result.text, /框架里的按钮/);
  assert.doesNotMatch(result.text, /立即支付/, '按需读 iframe 时不再重复主文档');
  assert.equal(result.scope, 'frame:f1');
});

test('a cross-origin or vanished frame is reported, not silently empty', async () => {
  const { nodes } = pageFixture();
  const cdp = fakeCdp({ main: nodes, frames: [FRAME], frameTrees: {} });
  const result = await capture(cdp, { frame: 'f1' });
  assert.match(result.text, /cross-origin frame/);
  assert.equal(result.crossOrigin, true);
  assert.deepEqual(result.entries, []);

  const missing = await capture(cdp, { frame: 'f9' });
  assert.match(missing.text, /no such frame/);
});

test('ref returns only that subtree for large pages', async () => {
  const { nodes } = pageFixture();
  const result = await capture(fakeCdp({ main: nodes, frames: [] }), { ref: '@e12', frames: 'none' });
  assert.match(result.text, /立即支付/);
  assert.doesNotMatch(result.text, /heading "购物车"/, '只保留目标子树，不含同页其他内容');
  assert.equal(result.rooted, true);
});
