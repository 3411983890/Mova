/**
 * 负责：钉住「工具动到的文件路径」这条链——skills 事件带 path、ACP 翻译层带 path、
 *   工具行纯函数把 path 交出去。渲染层据此把路径画成可点击的链接。
 * 不负责：点击行为本身（src/features/chat/open-target.mjs 的测试）、闸门与审批（skills-approval.test.mjs）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么单独一个文件：这条链跨了「主进程事件 → 渲染层行」两层，任何一环漏了 path，
 * 用户看到的现象都只是「路径点不动」，很难定位到底是哪一层丢的。这里一个文件把三环都钉住。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTranslateState, translateSessionUpdate } from '../electron/acp/translate.mjs';
import {
  skillDeniedEvent, skillDoneEvent, skillErrorEvent, skillRunningEvent,
} from '../electron/skills/events.mjs';
import { eventPathOf, firstPathOf } from '../electron/skills/tool-path.mjs';
import { toolStatusRow } from '../src/features/chat/trace-image.mjs';

const DEF = Object.freeze({ name: 'read_file', label: '读取文件' });

// ── 一、参数里怎么认出路径（一份口径）────────────────────────────────────
test('firstPathOf：按 path / file / filePath / cwd / dir 的顺序取第一个非空字符串', () => {
  assert.equal(firstPathOf({ path: 'docs/a.md' }), 'docs/a.md');
  assert.equal(firstPathOf({ file: ' b.txt ' }), 'b.txt', '两端空白要去掉');
  assert.equal(firstPathOf({ path: '  ', file: 'c.txt' }), 'c.txt', '空串跳过，继续看下一个');
  assert.equal(firstPathOf({ url: 'https://x', target: '@e5' }), '', 'url/target 不是路径（浏览器选择器会误判越界）');
  assert.equal(firstPathOf({ command: 'pnpm test' }), '', '命令不是路径');
  assert.equal(firstPathOf(null), '');
  assert.equal(firstPathOf('docs/a.md'), '', '参数必须是对象');
});

test('eventPathOf：压成一行、去掉控制字符、超过 300 字符截断', () => {
  assert.equal(eventPathOf('a\nb.md'), 'a b.md', '换行会破坏行内排版');
  assert.equal(eventPathOf('a\u0000b.md'), 'a b.md');
  assert.equal(eventPathOf(''), '');
  assert.equal(eventPathOf(42), '');
  const long = eventPathOf(`x/${'y'.repeat(400)}.md`);
  assert.equal(long.length, 300);
});

// ── 二、skills 事件把 path 带给前端 ──────────────────────────────────────
test('running / done / error / denied 都带 path（失败也要能点开去看一眼）', () => {
  const callId = 'mcp-1';
  for (const build of [
    () => skillRunningEvent({ callId, def: DEF, path: 'src/a.ts' }),
    () => skillDoneEvent({ callId, def: DEF, path: 'src/a.ts' }),
    () => skillErrorEvent({ callId, def: DEF, path: 'src/a.ts', detail: '失败' }),
    () => skillDeniedEvent({ callId, def: DEF, path: 'src/a.ts', detail: '拒绝' }),
  ]) {
    assert.equal(build().path, 'src/a.ts');
  }
});

test('没有路径时事件里不出现 path 键（旧形状逐字不变）', () => {
  const running = skillRunningEvent({ callId: 'mcp-2', def: DEF, detail: '执行中' });
  assert.equal('path' in running, false);
  assert.equal('path' in skillDoneEvent({ callId: 'mcp-2', def: DEF }), false);
});

test('done 事件以 diff.path 兜底：只有 diff 的工具也能点', () => {
  const done = skillDoneEvent({ callId: 'mcp-3', def: DEF, diff: { path: 'docs/b.md', before: '', after: 'x' } });
  assert.equal(done.path, 'docs/b.md');
  assert.equal(done.diff.path, 'docs/b.md', 'diff 本身不被改动');
});

test('path 里的换行与控制字符在事件层就被清掉（渲染层拿到的永远是一行）', () => {
  const running = skillRunningEvent({ callId: 'mcp-4', def: DEF, path: 'a\nb\u0001.md' });
  assert.equal(running.path, 'a b .md');
});

// ── 三、ACP 翻译层：CLI 自己工具的路径 ───────────────────────────────────
function toolEvent(update) {
  const state = createTranslateState();
  const result = translateSessionUpdate({ jsonrpc: '2.0', method: 'session/update', params: { update } }, state);
  return result.events.find(event => event.type === 'tool') ?? null;
}

test('ACP：CLI 工具的 file_path 进 tool.path（渲染层才有东西可点）', () => {
  const event = toolEvent({
    sessionUpdate: 'tool_call', toolCallId: 'call-1', title: '读取文件',
    kind: 'read', status: 'in_progress', rawInput: { file_path: 'src/features/a.js' },
  });
  assert.ok(event, '必须产出一条 tool 事件');
  assert.equal(event.path, 'src/features/a.js');
  assert.match(event.detail, /src\/features\/a\.js/, '一句话说明仍然带路径（那一行给眼睛看）');
});

test('ACP：diff 块的路径仍然进 path（改动行没被上一处改动带坏）', () => {
  const event = toolEvent({
    sessionUpdate: 'tool_call', toolCallId: 'call-2', title: '写入文件', status: 'completed',
    content: [{ type: 'diff', path: 'docs/c.md', oldText: 'a', newText: 'b' }],
  });
  assert.equal(event.path, 'docs/c.md');
  assert.equal(event.diff.path, 'docs/c.md');
});

test('ACP：没有路径参数时不出现 path 键', () => {
  const event = toolEvent({
    sessionUpdate: 'tool_call', toolCallId: 'call-3', title: '搜索', status: 'in_progress',
    rawInput: { query: 'keyword' },
  });
  assert.equal('path' in event, false);
});

// ── 四、渲染层：工具行把 path 交给路径芯片 ────────────────────────────────
test('toolStatusRow 带出 path；`.` 与空串不带（别把「项目根」画成可点路径）', () => {
  assert.equal(toolStatusRow({ name: 'read_file', label: '读取文件', status: 'done', path: 'src/a.ts', meta: '12 行' }).path, 'src/a.ts');
  assert.equal('path' in toolStatusRow({ name: 'git_status', label: 'git 状态', status: 'done', path: '.' }), false);
  assert.equal('path' in toolStatusRow({ name: 'read_file', label: '读取文件', status: 'done', path: '' }), false);
});
