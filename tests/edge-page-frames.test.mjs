// Edge 内容脚本的按需采集（P2）：frames 索引 / 单 frame / ref 子树 / 页面版本号。
// 用一个手写的极简 DOM 在 vm 里直接跑 pageOperation，避免依赖真实浏览器。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { pageOperation } from '../edge-extension/page.js';

const TAG_SETS = {
  controls: ['a', 'button', 'input', 'textarea', 'select', 'summary', 'canvas'],
  semantic: ['main', 'nav', 'header', 'footer', 'aside', 'section', 'article', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'th', 'td', 'p', 'img', 'iframe'],
};

function matchesToken(node, token) {
  const parts = token.trim().match(/^([a-z0-9*]*)((?:\[[^\]]*\]|:[a-z-]+)*)$/i);
  if (!parts) return false;
  const [, tag, rest] = parts;
  if (tag && tag !== '*' && node.localName !== tag) return false;
  for (const [, attr, operator, value] of rest.matchAll(/\[([^\]=]+)(?:=("?)([^"\]]*)\2)?\]/g)) {
    const actual = node.attrs[attr] ?? (attr === 'type' ? node.type : undefined);
    if (actual === undefined) return false;
    if (operator && String(actual) !== value) return false;
  }
  if (/:disabled/.test(rest) && !node.attrs.disabled) return false;
  if (/:not\(/ .test(rest)) {
    // page.js 只用 :not([type=hidden]) 这类否定；被否定的属性存在就不匹配。
    for (const [, attr] of rest.matchAll(/:not\(\[([^\]=]+)=([^\]]+)\]\)/g)) {
      if (node.attrs[attr] !== undefined) return false;
    }
  }
  return true;
}

function makeElement(localName, options = {}) {
  const node = {
    localName,
    id: options.id || '',
    name: options.name || '',
    type: options.type || '',
    innerText: options.text || '',
    textContent: options.text || '',
    hidden: false,
    isConnected: true,
    ownerDocument: null,
    children: [],
    options: [],
    labels: [],
    parent: null,
    checked: false,
    value: options.value || '',
    attrs: { ...(options.attrs || {}) },
    contentDocument: options.contentDocument ?? null,
    getAttribute(name) { return name in node.attrs ? node.attrs[name] : null; },
    hasAttribute(name) { return name in node.attrs; },
    matches(selector) { return String(selector).split(',').some(token => matchesToken(node, token)); },
    closest(selector) { for (let cur = node; cur; cur = cur.parent) if (cur.matches(selector)) return cur; return null; },
    contains(other) { for (let cur = other; cur; cur = cur.parent) if (cur === node) return true; return false; },
    checkVisibility() { return options.visible !== false; },
    getClientRects() { return options.visible === false ? [] : [{}]; },
    getBoundingClientRect() { return { left: 1, top: 1, width: 40, height: 20, right: 41, bottom: 21 }; },
    scrollIntoView() {},
    focus() {},
    click() { node.clicked = (node.clicked || 0) + 1; },
    dispatchEvent() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  if (TAG_SETS.controls.includes(localName) && !node.attrs.role) node.attrs.role = '';
  return node;
}

function append(parent, child) {
  child.parent = parent;
  child.ownerDocument = parent.ownerDocument;
  parent.children.push(child);
  return child;
}

function buildPage() {
  const document = {
    title: '测试页',
    readyState: 'complete',
    fonts: { status: 'loaded' },
    images: [],
    documentElement: null,
    body: null,
    getElementById: () => null,
    getAnimations: () => [],
    querySelectorAll(selector) {
      const frames = [];
      const visit = node => {
        if (node.localName === 'iframe' || node.localName === 'frame') frames.push(node);
        for (const child of node.children) visit(child);
        if (node.contentDocument?.body) visit(node.contentDocument.body);
      };
      if (selector === 'iframe,frame') { visit(document.body); return frames; }
      return [];
    },
    querySelector(selector) {
      if (selector === 'main,[role=main]') return null;
      return null;
    },
    elementFromPoint: () => hit,
  };
  const body = makeElement('body');
  body.ownerDocument = document;
  document.body = body;
  document.documentElement = body;

  const heading = append(body, makeElement('h1', { text: '结算页' }));
  heading.ownerDocument = document;
  const save = append(body, makeElement('button', { attrs: { id: 'save' }, text: '保存订单' }));

  // 同源 iframe：内容可读
  const innerBody = makeElement('body');
  const frameButton = append(innerBody, makeElement('button', { text: '框架按钮' }));
  const sameFrameDoc = { body: innerBody, readyState: 'complete', location: { href: 'https://shop.example.com/embed' } };
  innerBody.ownerDocument = sameFrameDoc;
  frameButton.ownerDocument = sameFrameDoc;
  const frame = append(body, makeElement('iframe', { attrs: { src: '/embed' }, contentDocument: sameFrameDoc }));
  frame.ownerDocument = document;

  // 跨域 iframe：contentDocument 为空
  const cross = append(body, makeElement('iframe', { attrs: { src: 'https://other.example.org/widget' }, contentDocument: null }));
  cross.ownerDocument = document;

  let hit = save;
  document.elementFromPoint = () => hit;
  const context = vm.createContext({
    document,
    location: new URL('https://shop.example.com/cart'),
    innerWidth: 900,
    innerHeight: 700,
    crypto,
    getComputedStyle: () => ({ display: 'block' }),
    performance: { now: () => 1000 },
    MutationObserver: class { observe() {} },
    __movaEdgePage: {},
  });
  const invoke = vm.runInContext(`(${pageOperation.toString()})`, context);
  return { invoke, document, save, frame, cross, setHit: value => { hit = value; } };
}

test('snapshot indexes iframes instead of inlining them by default', async () => {
  const page = buildPage();
  const snapshot = await page.invoke('snapshot', { mode: 'full' });
  assert.match(snapshot.text, /button @e\d+ "保存订单"/);
  assert.match(snapshot.text, /iframe f1 "\/embed"/, '默认只列编号与地址');
  assert.match(snapshot.text, /iframe f2 "https:\/\/other\.example\.org\/widget" \[cross-origin\]/);
  assert.doesNotMatch(snapshot.text, /框架按钮/);
  assert.equal(snapshot.frames.length, 2);
  assert.equal(snapshot.frames[0].crossOrigin, false);
  assert.equal(snapshot.frames[1].crossOrigin, true);
  assert.equal(typeof snapshot.version, 'number');
});

test('frames:"all" inlines same-origin content and reports cross-origin frames', async () => {
  const page = buildPage();
  const snapshot = await page.invoke('snapshot', { mode: 'full', frames: 'all' });
  assert.match(snapshot.text, /框架按钮/);
  assert.match(snapshot.text, /frame requires separate access/);
});

test('frames:"none" keeps the snapshot to the main document only', async () => {
  const page = buildPage();
  const snapshot = await page.invoke('snapshot', { mode: 'full', frames: 'none' });
  assert.doesNotMatch(snapshot.text, /iframe f1/);
  assert.match(snapshot.text, /保存订单/);
});

test('frame:"f1" reads one frame on demand, cross-origin says why', async () => {
  const page = buildPage();
  await page.invoke('snapshot', { mode: 'full' });
  const one = await page.invoke('snapshot', { mode: 'full', frame: 'f1' });
  assert.match(one.text, /scope frame:f1/);
  assert.match(one.text, /框架按钮/);
  assert.doesNotMatch(one.text, /保存订单/);

  const cross = await page.invoke('snapshot', { mode: 'full', frame: 'f2' });
  assert.equal(cross.crossOrigin, true);
  assert.match(cross.text, /跨域 iframe/);

  const missing = await page.invoke('snapshot', { mode: 'full', frame: 'f9' });
  assert.equal(missing.error.code, 'frame-not-found');
});

test('ref expands only that subtree, stale refs fail loudly, version advances after an act', async () => {
  const page = buildPage();
  const first = await page.invoke('snapshot', { mode: 'full', frames: 'none' });
  const ref = first.text.match(/button (@e\d+) "保存订单"/)[1];
  const subtree = await page.invoke('snapshot', { mode: 'full', ref, frames: 'none' });
  assert.match(subtree.text, new RegExp(ref));
  assert.doesNotMatch(subtree.text, /heading|结算页/);
  assert.equal(subtree.scope, `ref:${ref}`);

  const stale = await page.invoke('snapshot', { mode: 'full', ref: '@e9999', frames: 'none' });
  assert.equal(stale.error.code, 'stale-element');

  const before = (await page.invoke('snapshot', { mode: 'full', frames: 'none' })).version;
  const preview = await page.invoke('preview', { action: 'click', target: ref });
  assert.ok(preview.ticket);
  const acted = await page.invoke('act', { action: 'click', target: ref, ticket: preview.ticket });
  assert.equal(acted.ok, true);
  const after = (await page.invoke('snapshot', { mode: 'full', frames: 'none' })).version;
  assert.equal(after, before + 1, '动作后版本号 +1，桥接层据此判断观察是否过期');
  assert.equal(page.save.clicked, 1);
});
