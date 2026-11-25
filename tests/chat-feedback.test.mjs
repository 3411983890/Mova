import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createChatFeedback } from '../src/features/chat/chat-feedback.mjs';

test('background retries never overwrite another chat notice', () => {
  const state = createChatFeedback();
  state.set('A', '连接中断，重试中', 'retry');
  assert.equal(state.get('B'), '');
  state.set('B', '请配置模型');
  state.set('A', '第二次重试', 'retry');
  assert.equal(state.get('B'), '请配置模型');
  assert.equal(state.get('A'), '第二次重试');
});

test('recovery clears only the recovered chat retry, not unrelated warnings', () => {
  const state = createChatFeedback();
  state.set('A', '重试', 'retry');
  state.set('B', '重试', 'retry');
  state.recover('A');
  assert.equal(state.get('A'), '');
  assert.equal(state.get('B'), '重试');
  state.set('A', '保存失败');
  state.recover('A');
  assert.equal(state.get('A'), '保存失败');
});

test('actual composer renderer hides background notices and clears recovered retries', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function renderChatFeedback() {');
  const end = app.indexOf('// Keep originals only in memory', start);
  assert.ok(start >= 0 && end > start);
  const note = { hidden: true, textContent: '' };
  const context = {
    feedbackState: createChatFeedback(),
    $: () => note,
    draftKey: () => context.selected,
    selected: 'A',
    activeArea: 'home',
  };
  runInNewContext(app.slice(start, end), context);
  context.chatFeedback('重试 A', 'A', 'retry');
  assert.equal(note.textContent, '重试 A');
  context.selected = 'B';
  context.renderChatFeedback();
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  context.chatFeedback('请配置 B', 'B');
  context.chatFeedback('第二次重试 A', 'A', 'retry');
  assert.equal(note.textContent, '请配置 B');
  context.recoverChatFeedback('A');
  assert.equal(note.textContent, '请配置 B');
  context.selected = 'A';
  context.renderChatFeedback();
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  context.selected = 'B';
  context.activeArea = 'messages';
  context.renderChatFeedback();
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
});

test('stream recovery, terminal cleanup and scoped rendering are wired', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /reply.text \+= delta;\s*recoverChatFeedback\(key\)/);
  assert.match(app, /reply.status = status;\s*recoverChatFeedback\(key\)/);
  assert.match(app, /event.attempt\}\/5 次自动重试…`, key, 'retry'/);
  assert.match(app, /function renderConversation\(\) \{\s*renderChatFeedback\(\)/);
  assert.match(app, /feedbackState.entries, chatPermissionPresets/);
});
