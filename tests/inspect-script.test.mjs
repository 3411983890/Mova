// 网页内注入脚本的纯函数与语法检查（不启动 Electron）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INJECT_SOURCE, sanitizeInspectPayload, createInspectSession, BINDING_NAME } = require('../electron/browser/inspect.cjs');

test('selection payloads are truncated and rects normalized', () => {
  const long = 'x'.repeat(5000);
  const value = sanitizeInspectPayload({
    type: 'selection',
    nonce: 'nonce-1',
    text: `  ${long}  `,
    rect: { x: 1.4, y: 2.6, w: 99.5, h: -8 },
    url: 'https://example.com/a',
    title: 't',
  });
  assert.equal(value.type, 'selection');
  assert.equal(value.text.length, 1000);
  assert.deepEqual(value.rect, { x: 1, y: 3, w: 100, h: 0 });
  assert.equal(value.nonce, 'nonce-1');

  // 少于 2 个字符的选区没有引用价值，直接丢弃。
  assert.equal(sanitizeInspectPayload({ type: 'selection', nonce: 'n', text: 'a' }), null);
  assert.equal(sanitizeInspectPayload({ type: 'selection', nonce: 'n', text: '   ' }), null);
});

test('element payloads are truncated to the documented limits', () => {
  const value = sanitizeInspectPayload({
    type: 'element',
    nonce: 'nonce-1',
    element: {
      tag: 'DIV',
      id: 'buy',
      className: '  btn   primary ',
      role: 'button',
      ariaLabel: 'y'.repeat(500),
      text: 'z '.repeat(600),
      selector: 'div > span '.repeat(40),
      value: 'never-forwarded',
      type: 'text',
    },
    rect: { x: 0, y: 0, w: 10, h: 10 },
    url: 'https://example.com/checkout',
    title: '结算',
  });
  assert.equal(value.element.tag, 'div');
  assert.equal(value.element.id, 'buy');
  assert.equal(value.element.className, 'btn primary');
  assert.equal(value.element.role, 'button');
  assert.equal(value.element.ariaLabel.length, 280);
  assert.equal(value.element.text.length, 280);
  assert.equal(value.element.selector.length, 200);
  assert.equal('value' in value.element, false, 'value 永不透传');
});

test('password inputs keep the selector but lose every text field', () => {
  const value = sanitizeInspectPayload({
    type: 'element',
    nonce: 'nonce-1',
    element: { tag: 'input', type: 'password', text: 'hunter2', value: 'hunter2', selector: '#pw' },
    rect: { x: 1, y: 2, w: 3, h: 4 },
    url: 'https://example.com/login',
  });
  assert.ok(value, '密码框仍要能画浮层');
  assert.equal(value.element.tag, 'input');
  assert.equal(value.element.selector, '#pw');
  assert.equal('text' in value.element, false);
  assert.equal('value' in value.element, false);
});

test('urls are capped and non-http(s) urls are dropped', () => {
  const huge = sanitizeInspectPayload({
    type: 'selection',
    nonce: 'n',
    text: 'hello world',
    url: `https://example.com/${'a'.repeat(3000)}`,
  });
  assert.equal(huge.url.length, 2048);
  const file = sanitizeInspectPayload({ type: 'selection', nonce: 'n', text: 'hello world', url: 'file:///etc/passwd' });
  assert.equal(file.url, undefined);
});

test('malformed payloads are rejected instead of repaired', () => {
  const bad = [
    null,
    undefined,
    0,
    'nope',
    [],
    {},
    { type: 'selection' },
    { type: 'bogus', nonce: 'n' },
    { type: 'selection', nonce: '', text: 'hello' },
    { type: 'selection', nonce: 42, text: 'hello' },
    { type: 'element', nonce: 'n' },
    { type: 'element', nonce: 'n', element: { tag: '1bad' } },
    { type: 'element', nonce: 'n', element: 'button' },
  ];
  for (const value of bad) assert.equal(sanitizeInspectPayload(value), null, JSON.stringify(value));
});

test('exit payloads carry nothing but the type and nonce', () => {
  const value = sanitizeInspectPayload({ type: 'exit', nonce: 'nonce-1', text: 'ignored', rect: { x: 9 } });
  assert.deepEqual(value, { type: 'exit', nonce: 'nonce-1' });
});

test('INJECT_SOURCE parses and keeps the required page hooks', () => {
  assert.doesNotThrow(() => new Function(INJECT_SOURCE));
  const source = INJECT_SOURCE.trim();
  assert.ok(source.startsWith('(function'), '必须是一段自执行 IIFE');
  assert.ok(source.endsWith('})();'));
  for (const hook of [
    '__movaInspect',
    '__movaInspectSend',
    'movaVersion',
    'startPicker',
    'stopPicker',
    'Escape',
    'nth-of-type',
    'attachShadow',
    'selectionchange',
    'crosshair',
    'preventDefault',
  ]) {
    assert.ok(INJECT_SOURCE.includes(hook), `注入脚本缺少 ${hook}`);
  }
  assert.ok(INJECT_SOURCE.includes("mode: 'closed'"), '高亮层用 closed shadow DOM');
  // 页内脚本只摘属性白名单，上报体里没有 value 字段。
  assert.ok(!/element\[[^\]]*\]\s*=\s*[^;]*\.value/.test(INJECT_SOURCE));
});

function fakeCdp() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    send: async (method, params) => {
      sent.push([method, params]);
      return { identifier: 'script-1', result: { value: 'nonce-1' } };
    },
    on: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: (method, params) => { for (const listener of [...listeners]) listener(method, params); },
    get listening() { return listeners.size; },
  };
}

test('inspect session filters binding name, nonce and payload type', async () => {
  const cdp = fakeCdp();
  const events = [];
  const session = createInspectSession({ cdp, nonce: 'nonce-1', emit: payload => events.push(payload) });
  await session.start();

  assert.ok(cdp.sent.some(([method]) => method === 'Runtime.addBinding'), '必须注册回传 binding');
  const binding = cdp.sent.find(([method]) => method === 'Runtime.addBinding');
  assert.equal(binding[1].name, BINDING_NAME);
  const injected = cdp.sent.find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(injected[1].source, INJECT_SOURCE);
  assert.equal(injected[1].runImmediately, true);

  const say = (name, body) => cdp.fire('Runtime.bindingCalled', { name, payload: JSON.stringify(body) });
  say('__movaInspect', { type: 'selection', nonce: 'nonce-1', text: '选中的一段话' });
  say('__movaInspect', { type: 'selection', nonce: 'wrong-nonce', text: '伪造的上报' });
  say('otherBinding', { type: 'selection', nonce: 'nonce-1', text: '错误 binding' });
  say('__movaInspect', { type: 'bogus', nonce: 'nonce-1', text: '未知类型' });
  cdp.fire('Runtime.bindingCalled', { name: '__movaInspect', payload: 'not-json' });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'selection');
  assert.equal(events[0].text, '选中的一段话');

  await session.dispose();
  assert.equal(session.disposed, true);
  assert.equal(cdp.listening, 0, 'dispose 之后不再监听');
  say('__movaInspect', { type: 'selection', nonce: 'nonce-1', text: '已经关掉了' });
  assert.equal(events.length, 1);
});

test('restarting an inspect session only re-syncs the nonce', async () => {
  const cdp = fakeCdp();
  const session = createInspectSession({ cdp, nonce: 'nonce-2', emit: () => {} });
  await session.start();
  const injections = () => cdp.sent.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument').length;
  assert.equal(injections(), 1);
  await session.start();
  assert.equal(injections(), 1, '重复 start 不能重复注入');
  const syncs = cdp.sent.filter(([method, params]) => method === 'Runtime.evaluate' && String(params?.expression).includes('setNonce'));
  assert.ok(syncs.length >= 2, '每次 start 都重新下发 nonce');
  assert.ok(syncs.every(([, params]) => String(params.expression).includes('nonce-2')));
  await session.stop();
});
