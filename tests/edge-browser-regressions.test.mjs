import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { pageOperation } from '../edge-extension/page.js';
import * as pointer from '../edge-extension/pointer.js';
import receipts from '../electron/edge-receipts.cjs';

function formPage(entries) {
  const document = { body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] };
  const events = [];
  class Select {
    get selectedOptions() { return this.options.filter(option => option.selected); }
    set selectedIndex(index) { this.options.forEach((option, i) => { option.selected = i === index; }); }
  }
  document.defaultView = { HTMLSelectElement: Select, Event };
  const select = Object.assign(new Select(), {
    ownerDocument: document, id: 'plan', localName: 'select', isConnected: true,
    options: entries.map(([value, label], index) => ({ value, label, selected: index === 0, closest: () => null })),
    getAttribute: () => null, checkVisibility: () => true, getClientRects: () => [{}],
    matches: selector => selector === 'select' || selector.includes('textarea,select,summary,canvas'),
    closest: selector => selector.includes('button,input,select') ? select : null,
    contains: () => false, hasAttribute: () => false, children: [],
    getBoundingClientRect: () => ({ left: 1, top: 1, width: 50, height: 20 }),
    scrollIntoView() {}, dispatchEvent(event) { events.push(event.type); },
  });
  document.elementFromPoint = () => select;
  document.body.children = [select];
  const context = vm.createContext({
    document, location: new URL('https://example.org'), innerWidth: 800, innerHeight: 580, crypto,
    getComputedStyle: () => ({ display: 'block' }),
    __movaEdgePage: { refs: new Map([['@e1', select]]), ids: new WeakMap([[select, '@e1']]), tickets: new Map(), next: 1 },
  });
  const invoke = vm.runInContext(`(${pageOperation.toString()})`, context);
  const preview = (value, preflight = true) => invoke('preview', { action: 'select', target: '@e1', value, preflight });
  const selectOption = async value => {
    const { ticket } = await preview(value, false);
    return invoke('act', { action: 'select', target: '@e1', value, ticket });
  };
  return { preview, selectOption, events, invoke };
}

test('select accepts snapshot labels, exact values, normalized units and city labels', async () => {
  const page = formPage([['10', '10M'], ['20', '20M'], ['rate_3', '30 Mbps'], ['city_12', '美国-洛杉矶']]);
  assert.match((await page.invoke('snapshot', { mode: 'full' })).text, /option "20M" value="20"/);
  assert.equal((await page.selectOption('10M')).noOp, true);
  assert.equal(page.events.length, 0);
  assert.equal((await page.preview('20M')).resolvedValue, '20');
  assert.equal((await page.selectOption('20M')).selected.value, '20');
  assert.equal((await page.selectOption('20')).noOp, true);
  assert.equal((await page.preview('３０')).resolvedValue, 'rate_3');
  assert.equal((await page.preview(' 美国_洛杉矶 ')).resolvedValue, 'city_12');
  assert.equal((await page.preview('美国-洛')).resolvedValue, 'city_12');
  assert.deepEqual(page.events, ['input', 'change']);
});

test('select reports ambiguity and lists available label/value pairs', async () => {
  const page = formPage([['city_12', '美国-洛杉矶'], ['city_13', '美国-纽约']]);
  const ambiguous = (await page.preview('美国')).error;
  assert.equal(ambiguous.code, 'option-ambiguous');
  assert.deepEqual(JSON.parse(JSON.stringify(ambiguous.detail.matches)), [
    { label: '美国-洛杉矶', value: 'city_12' }, { label: '美国-纽约', value: 'city_13' },
  ]);
  const absent = (await page.preview('德国')).error;
  assert.equal(absent.code, 'option-unavailable');
  assert.equal(absent.detail.options.length, 2);
  assert.match(absent.suggestion, /label/);
  assert.equal((await page.invoke('pointer_preview', { points: [{ x: 1, y: 1 }] })).blockedCode, 'element-ref-available');
});

test('Edge pointer accepts 580 to 540 jitter and stops after two genuinely stale views', async () => {
  const source = readFileSync(new URL('../edge-extension/bridge.js', import.meta.url), 'utf8')
    .replace(/^import.*\r?\n/gm, '').replace(/await import\('\.\/app\.js'\);/, '');
  let height = 580;
  let clicks = 0;
  const context = vm.createContext({
    ...pointer, URL, crypto, AbortController, pageOperation,
    window: {}, localStorage: { getItem: () => 'paired' },
    document: { documentElement: { classList: { add() {} } }, querySelector: () => ({ addEventListener() {} }) },
    chrome: {
      tabs: { onRemoved: { addListener() {} } }, windows: {},
      scripting: { executeScript: async ({ args }) => [{
        documentId: 'doc', result: { origin: 'https://example.org', labels: ['canvas'], blocked: false, operation: args[0] },
      }] },
      debugger: {
        attach: async () => {}, detach: async () => {},
        async sendCommand(_target, method) {
          if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: height, pageX: 0, pageY: 0, scale: 1 } };
          if (method === 'Page.captureScreenshot') return { data: 'YQ==' };
          if (method === 'Input.dispatchMouseEvent') clicks++;
        },
      },
    },
  });
  const execute = vm.runInContext(source + '\nexecuteVisual', context);
  const authorization = { tabId: 3, documentId: 'doc', origin: 'https://example.org' };
  const session = {};
  const verify = async () => authorization;
  const signal = new AbortController().signal;
  const perform = (operation, input = {}) => execute(operation, input, session, verify, signal);
  const args = { action: 'click', x: 0.5, y: 0.5, labels: ['canvas'] };
  const first = await perform('visual_screenshot');
  height = 540;
  await perform('visual_pointer', { ...args, viewId: first.viewId });
  assert.equal(clicks, 3);
  const stale = await perform('visual_screenshot');
  height = 400;
  await assert.rejects(perform('visual_preview', { ...args, viewId: stale.viewId }), { code: 'viewport-stale' });
  const refreshed = await perform('visual_screenshot');
  height = 580;
  await assert.rejects(perform('visual_preview', { ...args, viewId: refreshed.viewId }), { code: 'pointer-unavailable' });
});

test('fixture preview predicts quantity and price, while commit diff uses observed state', () => {
  const before = {
    phase: 'before', fields: [
      { key: 'id:plan', label: '方案', value: '20M' },
      { key: 'id:quantity', label: '数量', value: '1' },
    ], prices: ['总价 ￥20'], statuses: ['总价 ￥20', '等待操作'],
  };
  const steps = [
    { action: 'fill', fieldKey: 'id:quantity', label: '数量', value: '3' },
    { action: 'click', elementId: 'save' },
  ];
  const projected = receipts.projectPlan(before, steps, true);
  assert.deepEqual(projected.changes.prices, { before: ['总价 ￥20'], after: ['总价 ￥60'] });
  assert.equal(projected.fields[1].value, '3');
  assert.equal(projected.requiresHandoff, false);
  assert.equal(receipts.projectPlan(before, steps, false).priceStatus, 'unknown-until-page-updates');
  const after = {
    phase: 'after', fields: [before.fields[0], { ...before.fields[1], value: '3' }],
    prices: ['总价 ￥60'], statuses: ['总价 ￥60', '已记录测试'],
  };
  const diff = receipts.diffObserved({ summary: before }, { summary: after });
  assert.match(diff.snapshot.text, /数量：1 → 3/);
  assert.match(diff.snapshot.text, /总价 ￥20 → 总价 ￥60/);
  assert.match(diff.snapshot.text, /已记录测试/);
  assert.equal(receipts.diffObserved({ summary: before }, { summary: before }).snapshot.changed, false);
});
