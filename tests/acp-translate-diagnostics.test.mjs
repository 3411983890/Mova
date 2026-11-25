/**
 * 负责：`electron/acp/translate.mjs` 里「CLI 诊断行不进正文」这条规则的回归锁。
 * 不负责：思考/文本合并的一般行为（那在 tests/acp-translate.test.mjs）、渲染层怎么折叠（thinking-block.jsx）。
 * 被谁调用：`node --test`。
 *
 * 背景：`agy` 会把上游 API 失败当作 `agent_message` 流吐出来，例如
 *   ⚠ API error (attempt 1): request failed: Post "https://…:streamGenerateContent?alt=sse": EOF
 * 直接渲染就是「回答开头糊一条报错」。用户要求：不进正文，收进可展开的折叠块（与「思考」同一种交互）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTranslateState, splitCliDiagnostics, translateSessionUpdate } from '../electron/acp/translate.mjs';

const chunk = text => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});

const UPSTREAM_ERROR = '⚠ API error (attempt 1): request failed: Post '
  + '"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF';

test('splitCliDiagnostics 抠出上游报错行，正文保持为空', () => {
  const { body, diagnostics } = splitCliDiagnostics(`${UPSTREAM_ERROR}\n`);
  assert.equal(body, '', '整块都是诊断时正文必须为空');
  assert.match(diagnostics, /API error \(attempt 1\)/);
});

test('splitCliDiagnostics 不误吞正常正文：带 Error: 的回答原样留在正文', () => {
  const text = '普通回答：Error: 你的配置里少了一个字段，补上就好。\n';
  const { body, diagnostics } = splitCliDiagnostics(text);
  assert.equal(diagnostics, '', '没有网络失败词时不得判定为诊断');
  assert.equal(body, text);
});

test('整块诊断只产出一条 thinking，不产出任何 text', () => {
  const result = translateSessionUpdate(chunk(`${UPSTREAM_ERROR}\n`), createTranslateState());
  assert.deepEqual(result.events.map(event => event.type), ['thinking']);
  const [event] = result.events;
  assert.equal(event.id, 'cli-diagnostics', '固定 id：同一轮多次重试累加到同一行');
  assert.match(event.text, /^模型服务重试记录/, '首行是中性标题，收起时不该显示原始错误');
  assert.match(event.text, /API error \(attempt 1\)/, '展开后要能看到原始错误');
});

test('诊断之后的正文照常进正文（顺序与 id 都不受影响）', () => {
  let state = createTranslateState();
  state = translateSessionUpdate(chunk(`${UPSTREAM_ERROR}\n`), state).state;
  const answer = translateSessionUpdate(chunk('我无法直接控制 IDE 打开右侧的浏览器视图。\n'), state);
  assert.deepEqual(answer.events.map(event => event.type), ['text']);
  assert.equal(answer.events[0].id, 'text-1');
});

test('被拆成两个 chunk 的诊断行不会漏进正文（「…request failed: 」+「EOF」）', () => {
  let state = createTranslateState();
  const first = translateSessionUpdate(chunk('⚠ API error (attempt 2): request failed: '), state);
  state = first.state;
  const second = translateSessionUpdate(chunk('EOF\n'), state);
  assert.deepEqual(first.events.map(event => event.type), ['thinking']);
  assert.deepEqual(second.events.map(event => event.type), ['thinking'], '续行不能再吐一条 text');
  assert.match(second.state.diagnostics, /EOF/, '续行要补进同一个折叠块');
});

test('两次重试累加到同一个 thinking id（前端只会有一行）', () => {
  let state = createTranslateState();
  const one = translateSessionUpdate(chunk('⚠ API error (attempt 1): fetch failed\n'), state);
  state = one.state;
  const two = translateSessionUpdate(chunk('⚠ API error (attempt 2): fetch failed\n'), state);
  assert.equal(two.events[0].id, one.events[0].id);
  assert.match(two.events[0].text, /attempt 1[\s\S]*attempt 2/, '两次都要留证，不能只留最后一条');
});
