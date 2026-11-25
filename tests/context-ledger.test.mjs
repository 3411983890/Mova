import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

/**
 * 台账测试：ledger.mjs 依赖的 budget.mjs / digest.mjs 由并行的另一个智能体交付，
 * 落在同一目录里但可能晚于本文件出现。这里用 node:module 的同步加载钩子把这两个模块
 * 换成固定 stub，测试才不依赖它们的实现细节与交付时间——被测对象仍是真实的 ledger.mjs。
 */
const STUB_BUDGET = {
  url: 'dsh-stub:context/budget.mjs',
  source: `
export function estimateMessageTokens(message) {
  const text = message && typeof message.content === 'string' ? message.content : '';
  return Math.ceil([...text].length / 2);
}
export function estimateRequestTokens(request) {
  const messages = request && Array.isArray(request.messages) ? request.messages : [];
  const tools = request && Array.isArray(request.tools) ? request.tools : [];
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total + tools.length * 50;
}
`,
};

const STUB_DIGEST = {
  url: 'dsh-stub:context/digest.mjs',
  source: `
export function deterministicDigest(messages) {
  if (globalThis.__CTX_LEDGER_DIGEST_FAIL__ === true) throw new Error('digest-stub-failure');
  const list = Array.isArray(messages) ? messages : [];
  const joined = list.map((message) => (message && typeof message.text === 'string' ? message.text : '')).join(' ');
  const constraints = (joined.match(/[^。！？；\\n]*不要[^。！？；\\n]*/g) || [])
    .map((part) => part.trim())
    .filter(Boolean);
  return { goal: 'stub-goal', covered: list.length, constraints };
}
export function buildSummaryBlock(digest) {
  const value = digest && typeof digest === 'object' ? digest : {};
  const lines = ['[stub-digest]'];
  if (value.goal) lines.push('goal=' + value.goal);
  if (Array.isArray(value.constraints)) for (const constraint of value.constraints) lines.push('constraint=' + constraint);
  return lines.join('\\n');
}
`,
};

const STUB_BY_URL = new Map([STUB_BUDGET, STUB_DIGEST].map((stub) => [stub.url, stub]));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './budget.mjs') return { url: STUB_BUDGET.url, shortCircuit: true, format: 'module' };
    if (specifier === './digest.mjs') return { url: STUB_DIGEST.url, shortCircuit: true, format: 'module' };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const stub = STUB_BY_URL.get(url);
    if (stub) return { format: 'module', source: stub.source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { createLedger, pinnedConstraints, selectCompressible } = await import('../electron/context/ledger.mjs');

const NOW = 1763000000000;

function message(id, role, text) {
  return { id, role, text };
}

/** 交替 user/assistant 的编号历史，便于用下标断言「保留了哪几条」；正文带填充，压缩才真的省 token。 */
function history(count) {
  return Array.from({ length: count }, (_, index) =>
    message(
      `m${index + 1}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `第 ${index + 1} 条：普通内容 ${index + 1} ` + 'x'.repeat(180),
    ),
  );
}

function ledgerOf(messages, extra = {}) {
  return createLedger({
    layers: { L1: '你是 Mova，用中文回答。', L2: '项目规则：2 空格缩进。', L3: '目标：拆设置页。' },
    messages,
    tools: [{ name: 'context_status' }],
    ...extra,
  });
}

test('compaction keeps the newest N messages and the first user message verbatim', () => {
  const ledger = ledgerOf(history(20));
  const result = ledger.compact({
    keepRecent: 6,
    keepFirstUser: 1,
    summarize: () => ({ text: '模型摘要正文', source: 'llm' }),
    now: NOW,
  });

  assert.equal(result.compacted, true, '有足够历史时必须真的压缩');
  assert.deepEqual(
    ledger.messages.map((item) => item.id),
    ['m1', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20'],
    '压缩后窗口应为首条用户消息 + 最近 6 条',
  );
  assert.deepEqual(
    result.coveredMessages,
    ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13', 'm14'],
    '被压缩区间应是首条用户消息之后、最近 6 条之前的那一段',
  );
  assert.equal(result.source, 'llm', '摘要器返回合法文本时应标记为 llm');
  assert.match(result.summaryBlock, /m2\.\.m14/, '摘要块必须带可回查的 span');
  assert.equal(result.record.tokens.before > result.record.tokens.after, true, '压缩后 token 应下降');
});

test('pinned constraints survive compaction and stay in the ledger layers', () => {
  const messages = [
    message('u1', 'user', '先改设置页'),
    message('u2', 'assistant', '好的'),
    message('u3', 'user', '不要改数据库结构，保持 4000 字符上限'),
    ...history(13).map((item) => message(`x${item.id}`, item.role, item.text)),
  ];
  const detected = pinnedConstraints(messages);
  assert.equal(detected.length >= 1, true, 'pinnedConstraints 应识别出「不要改数据库结构」');
  assert.equal(detected[0].text.includes('不要改数据库结构'), true, '约束要逐字保留原文');

  const ledger = ledgerOf(messages);
  const result = ledger.compact({
    keepRecent: 6,
    keepFirstUser: 1,
    // 摘要器故意不抄约束：约束的保留不能依赖模型配合
    summarize: () => ({ text: '模型摘要，没有复述约束', source: 'llm' }),
    now: NOW,
  });

  assert.equal(result.compacted, true, '这一段历史必须被压缩');
  assert.equal(result.summaryBlock.includes('不要改数据库结构'), true, '摘要块必须逐字保留用户约束');
  const l1 = ledger.layers.find((layer) => layer.id === 'L1');
  assert.equal(l1.text.includes('不要改数据库结构'), true, 'L1 常驻约束里必须仍有这句话');
  assert.equal(ledger.status().pinned >= 1, true, 'status 要报告 pinned 条数');
});

test('summarize throwing falls back to the deterministic digest without interrupting', () => {
  const ledger = ledgerOf(history(16));
  const result = ledger.compact({
    keepRecent: 4,
    summarize: () => {
      throw new Error('summarizer exploded');
    },
    now: NOW,
  });

  assert.equal(result.compacted, true, '摘要器抛错也必须完成压缩');
  assert.equal(result.source, 'deterministic', '回退路径的 source 必须是 deterministic');
  assert.match(result.summaryBlock, /stub-digest/, '回退必须走 deterministicDigest 的产物');
  assert.equal(ledger.messages.length, 5, '窗口仍应为最近 4 条 + 首条用户消息');
});

test('invalid summarize results also fall back to deterministic', () => {
  const invalidResults = [
    () => ({}),
    () => ({ text: 42, source: 'llm' }),
    () => ({ text: '   ', source: 'llm' }),
    () => '纯字符串不是约定形状',
    () => null,
  ];
  for (const summarize of invalidResults) {
    const ledger = ledgerOf(history(12));
    const result = ledger.compact({ keepRecent: 3, summarize, now: NOW });
    assert.equal(result.compacted, true, '非法摘要结果不能让压缩失败');
    assert.equal(result.source, 'deterministic', '非法结果一律回退 deterministic');
    assert.match(result.summaryBlock, /stub-digest/, '回退内容必须来自确定性摘要');
  }
});

test('a rejected summarize promise still commits a deterministic summary', async () => {
  const ledger = ledgerOf(history(12));
  const result = await ledger.compact({
    keepRecent: 3,
    summarize: () => Promise.reject(new Error('llm timeout')),
    now: NOW,
  });
  assert.equal(result.compacted, true, '异步摘要器 reject 也要落账');
  assert.equal(result.source, 'deterministic', '异步失败同样标记 deterministic');
  assert.equal(ledger.messages.length, 4, '窗口应已收缩');
});

test('compact returns compacted:false when no compressible range exists', () => {
  const ledger = ledgerOf(history(4));
  const before = ledger.messages.map((item) => item.id);
  let called = 0;
  const result = ledger.compact({
    keepRecent: 8,
    summarize: () => {
      called += 1;
      return { text: '不该被调用', source: 'llm' };
    },
    now: NOW,
  });

  assert.equal(result.compacted, false, '消息太少时必须返回 compacted:false');
  assert.equal(result.reason, 'too-few-messages', '未压缩要给出明确原因');
  assert.deepEqual(result.coveredMessages, [], '未压缩时 coveredMessages 必须为空');
  assert.deepEqual(result.archive, [], '未压缩时不得产生归档');
  assert.equal(result.summaryBlock, '', '未压缩时不得产生摘要块');
  assert.equal(called, 0, '没有可压缩区间时不允许调用摘要器');
  assert.deepEqual(ledger.messages.map((item) => item.id), before, '未压缩时窗口不能变');
});

test('read pages the original text verbatim', () => {
  const messages = history(9);
  const ledger = ledgerOf(messages);
  const expected = messages.map((item) => item.text).join('\n');

  let offset = 0;
  let rebuilt = '';
  let pages = 0;
  for (;;) {
    const page = ledger.read({ offset, limit: 37 });
    assert.equal(page.error, undefined, '合法分页不应返回错误');
    rebuilt += page.text;
    pages += 1;
    if (page.nextOffset === null) {
      assert.equal(page.done, true, '最后一页应标记 done');
      assert.equal(page.offset + page.text.length, page.total, '最后一页必须正好读到末尾');
      break;
    }
    assert.equal(page.nextOffset, offset + page.text.length, 'nextOffset 必须等于本页末尾');
    offset = page.nextOffset;
    assert.ok(pages < 100, '分页不应死循环');
  }
  assert.equal(rebuilt, expected, '所有分页拼起来必须与原文逐字一致');
  assert.equal(ledger.read({ offset: 0, limit: 37 }).text, expected.slice(0, 37), '首行分页内容必须逐字一致');
});

test('read rejects out-of-range requests with invalid-range', () => {
  const messages = history(3);
  const ledger = ledgerOf(messages);
  const total = messages.map((item) => item.text).join('\n').length;

  const cases = [
    { offset: -1, limit: 10 },
    { offset: total, limit: 10 },
    { offset: total + 25, limit: 10 },
    { offset: 0, limit: 0 },
    { offset: 0, limit: -5 },
    { offset: 1.5, limit: 10 },
    { offset: 0, limit: '10' },
  ];
  for (const range of cases) {
    assert.deepEqual(ledger.read(range), { error: 'invalid-range' }, `越界参数 ${JSON.stringify(range)} 必须返回 invalid-range`);
  }
  assert.deepEqual(ledgerOf([]).read({ offset: 0, limit: 10 }), { error: 'invalid-range' }, '空台账没有可读原文');
});

test('stats layers always sum to the reported total', () => {
  const ledger = ledgerOf(history(18));
  const fresh = ledger.stats();
  assert.equal(fresh.layers.length, 6, '台账必须有六层');
  assert.deepEqual(fresh.layers.map((layer) => layer.id), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'], '层顺序必须固定');
  assert.equal(
    fresh.layers.reduce((sum, layer) => sum + layer.tokens, 0),
    fresh.total.tokens,
    '未压缩时六层之和必须等于总量',
  );
  assert.equal(fresh.total.tokens > 0, true, '有内容时总量不应为 0');

  const result = ledger.compact({ keepRecent: 4, summarize: () => ({ text: '摘要', source: 'llm' }), now: NOW });
  assert.equal(result.compacted, true, '压缩应成功');
  const after = ledger.stats();
  assert.equal(
    after.layers.reduce((sum, layer) => sum + layer.tokens, 0),
    after.total.tokens,
    '压缩后六层之和仍必须等于总量',
  );
  assert.equal(after.layers.find((layer) => layer.id === 'L4').tokens > 0, true, '压缩后 L4 摘要层必须有内容');
  assert.equal(after.compactions, 1, '压缩次数应记一笔');

  const status = ledger.status();
  const ratioSum = status.layers.reduce((sum, layer) => sum + layer.ratio, 0);
  assert.ok(Math.abs(ratioSum - 1) < 0.01, `六层占比之和应约等于 1，实际 ${ratioSum}`);
  assert.equal(typeof status.request.tokens, 'number', '整请求口径必须是数字');
  assert.equal(status.canCompact, false, '已经压到只剩窗口下限时不应再可压缩');
});

test('pinnedConstraints caps the count and the length of each constraint', () => {
  const long = `不要${'很长的约束说明'.repeat(40)}`;
  const messages = [
    message('a', 'user', long),
    ...Array.from({ length: 11 }, (_, index) => message(`b${index}`, 'user', `必须保证第 ${index} 项验收通过`)),
    message('c', 'user', '这是一个普通陈述句，没有任何约束词'),
  ];

  const pins = pinnedConstraints(messages);
  assert.equal(pins.length, 8, '约束条数上限是 8');
  for (const pin of pins) {
    assert.equal(typeof pin.id, 'string', '每条约束都要有可引用 id');
    assert.ok([...pin.text].length <= 120, `单条约束不得超过 120 字，实际 ${[...pin.text].length}`);
  }
  assert.equal(pins.every((pin) => /不要|禁止|必须|不能|请勿/.test(pin.text)), true, '每条约束都必须含约束词');
  assert.equal(
    pins.some((pin) => pin.text.includes('普通陈述句')),
    false,
    '没有约束词的句子不得被误钉',
  );
  assert.equal(new Set(pins.map((pin) => pin.text)).size, pins.length, '约束不得重复');
});

test('selectCompressible separates the recent window and the first user message', () => {
  const messages = history(12);
  const { compressible, keep } = selectCompressible(messages, { keepRecent: 4, keepFirstUser: 1 });
  assert.deepEqual(
    keep.map((item) => item.id),
    ['m1', 'm9', 'm10', 'm11', 'm12'],
    '保留集合应是首条用户消息 + 最近 4 条',
  );
  assert.deepEqual(
    compressible.map((item) => item.id),
    ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
    '压缩集合应保持原顺序且连续',
  );

  const tight = selectCompressible(history(3), { keepRecent: 8, keepFirstUser: 1 });
  assert.deepEqual(tight.compressible, [], '消息数不足时压缩集合为空');
  assert.deepEqual(tight.keep.map((item) => item.id), ['m1', 'm2', 'm3'], '消息数不足时全部保留');
});

test('a failing digest module still yields a compacted result', () => {
  const ledger = ledgerOf(history(12));
  globalThis.__CTX_LEDGER_DIGEST_FAIL__ = true;
  try {
    const result = ledger.compact({
      keepRecent: 3,
      summarize: () => ({ text: '', source: 'llm' }),
      now: NOW,
    });
    assert.equal(result.compacted, true, '摘要器和确定性摘要同时失效也必须落账');
    assert.equal(result.source, 'deterministic', '两条回退都失败时仍是 deterministic');
    assert.ok(result.summaryBlock.length > 0, '最后一道兜底必须给出可读文本');
    assert.equal(result.summaryBlock.includes('[user]'), true, '最后兜底是带角色的原文缩略');
  } finally {
    globalThis.__CTX_LEDGER_DIGEST_FAIL__ = false;
  }
});
