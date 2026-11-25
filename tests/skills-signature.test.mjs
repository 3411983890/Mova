// electron/skills/discover.mjs 的 `formatSignature` 单元测试（mova_skill_search 默认结果里的那行签名）。
// 纯内存：只用字面量 def，不建注册表、不跑 handler。
// 断言偏「模型照这行字能不能直接发起调用」：必填认得出、类型对不对、enum 折没折、超长有没有截。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatSignature } from '../electron/skills/discover.mjs';

/** 造一个最小 def：签名只读 name / mcpName / mcpSummary / inputSchema 四个字段。 */
function def({ name = 'demo_run', mcpSummary = '执行一次演示动作。', properties = {}, required = [] } = {}) {
  return {
    name,
    mcpName: `mova_${name}`,
    label: `${name} 展示名`,
    description: `Do ${name}.`,
    mcpSummary,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

test('必填在前并带 *，可选带 ?：一行就是一次调用的全部参数说明', () => {
  const signature = formatSignature(def({
    name: 'browser_navigate',
    mcpSummary: '在 Mova 侧边浏览器打开 http(s) 网址，并在同一次调用里返回页面观察结果。',
    properties: {
      url: { type: 'string' },
      timeout: { type: 'integer' },
      observe: { type: 'string', enum: ['auto', 'full', 'none'] },
      space: { type: 'string' },
    },
    required: ['url'],
  }));
  assert.equal(
    signature,
    'mova_browser_navigate(url: string*, timeout?: integer, observe?: "auto"|"full"|"none", space?: string)'
      + ' — 在 Mova 侧边浏览器打开 http(s) 网址，并在同一次调用里返回页面观察结果。',
    '必填带 *、可选带 ?、enum 折叠成 "a"|"b"、描述取 mcpSummary 首句',
  );
});

test('required 里的字段即使在 properties 里排在后面，也必须排在签名最前面', () => {
  const signature = formatSignature(def({
    properties: { note: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
  }));
  assert.equal(signature, 'mova_demo_run(path: string*, note?: string) — 执行一次演示动作。');
});

test('enum 超过 4 个值折成 enum(N)，不再铺开字面量', () => {
  const signature = formatSignature(def({
    properties: { action: { type: 'string', enum: ['click', 'type', 'key', 'scroll', 'drag', 'focus', 'switch', 'set'] } },
    required: ['action'],
  }));
  assert.match(signature, /action: enum\(8\)\*/, '8 个字面量不该全写进一行');
  assert.equal(signature.includes('"click"'), false, '折叠后不应残留字面量');
});

test('enum 恰好 4 个值仍然铺开（边界只折「超过 4 个」）', () => {
  const signature = formatSignature(def({
    properties: { mode: { type: 'string', enum: ['a', 'b', 'c', 'd'] } },
  }));
  assert.match(signature, /mode\?: "a"\|"b"\|"c"\|"d"/);
});

test('可选字段超过 6 个时只列前 6 个（签名不是 schema，不追求全）', () => {
  const properties = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field_${index}`, { type: 'string' }]));
  const signature = formatSignature(def({ properties }));
  assert.match(signature, /field_5\?: string/);
  assert.equal(signature.includes('field_6'), false, '第 7 个可选字段应被截断');
});

test('没有描述时只给签名，不留悬空的破折号', () => {
  assert.equal(formatSignature(def({ mcpSummary: '' })), 'mova_demo_run()', '空 properties + 空描述 = 空括号');
  assert.equal(
    formatSignature(def({ mcpSummary: '', properties: { text: { type: 'string' } }, required: ['text'] })),
    'mova_demo_run(text: string*)',
  );
});

test('嵌套 object 只写类型 object，不展开子字段；认不出的 schema 写法写 any', () => {
  const signature = formatSignature(def({
    properties: {
      expect: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      pixels: { type: 'boolean' },
      options: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
  }));
  assert.match(signature, /expect\?: object/);
  assert.equal(signature.includes('expect?: object.text'), false, '嵌套字段不能挤进签名');
  assert.match(signature, /pixels\?: boolean/);
  assert.match(signature, /options\?: any/, 'oneOf 这类写法显示 any，不能编一个类型出来');
});

test('mcpSummary 只取首句且不超过 60 字符（长句折省略号）', () => {
  const twoSentences = formatSignature(def({ mcpSummary: '第一句说完了。第二句是废话，不该出现在签名里。' }));
  assert.match(twoSentences, /— 第一句说完了。$/);
  assert.equal(twoSentences.includes('第二句'), false);

  const long = formatSignature(def({ mcpSummary: '很'.repeat(100) }));
  const sentence = long.slice(long.indexOf('— ') + 2);
  assert.equal(sentence.length, 60, `描述应截到 60 字符（含省略号），实际 ${sentence.length}`);
  assert.equal(sentence.endsWith('…'), true, '截断要有省略号，模型才知道描述被截了');
});

test('签名永远是一行：mcpSummary 带换行也只取第一行', () => {
  const signature = formatSignature(def({ mcpSummary: '第一行摘要。\n第二行不该进签名。' }));
  assert.equal(signature.includes('\n'), false);
  assert.equal(signature.includes('第二行'), false);
});

test('降级档位（丢可选 / 丢描述）由第二个参数控制，供预算收敛逐档调用', () => {
  const subject = def({
    properties: { url: { type: 'string' }, timeout: { type: 'integer' } },
    required: ['url'],
  });
  assert.equal(formatSignature(subject, { optional: 0 }), 'mova_demo_run(url: string*) — 执行一次演示动作。');
  assert.equal(
    formatSignature(subject, { optional: 0, description: false }),
    'mova_demo_run(url: string*)',
    '最后一档只剩「名字 + 必填」，仍然是可调用的一行',
  );
});
