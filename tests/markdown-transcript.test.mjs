import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';

// Bundle JSX for Node without adding a second test runner or DOM dependency.
test('transcript paginates recent turns, keeps stable IDs, renders Markdown and gates retry', async () => {
  const result = await build({
    configFile: false,
    resolve: { preserveSymlinks: true },
    logLevel: 'error',
    build: {
      write: false,
      lib: { entry: fileURLToPath(new URL('../src/features/chat/chat-transcript.tsx', import.meta.url)), formats: ['es'] },
      rollupOptions: { external: ['react', 'react/jsx-runtime', 'react-markdown', 'remark-gfm', '@keyline-icons/react'] },
    },
  });
  const code = result[0].output.find(item => item.type === 'chunk' && item.isEntry).code;
  const path = new URL(`./.markdown-transcript-${process.pid}.mjs`, import.meta.url);
  await writeFile(path, code);
  try {
    const { ChatTranscript } = await import(path.href);
    const turns = Array.from({ length: 100 }, (_, index) => ({
      id: `stable-${index}`, text: `Question ${index}`,
      reply: { source: 'model', text: '**answer**', status: 'done' },
    }));
    const render = props => renderToStaticMarkup(React.createElement(ChatTranscript, { turns, viewport: {}, ...props }));
    const html = render({});
    assert.match(html, /加载更早消息/);
    assert.equal((html.match(/class="user-message transcript-message"/g) || []).length, 60);
    assert.ok(!html.includes('id="stable-39"'));
    assert.match(html, /id="stable-40"/);
    assert.match(html, /id="stable-99-assistant"/);
    assert.match(html, /<strong>answer<\/strong>/);
    assert.ok(!html.includes('重新生成'));
    for (const status of ['error', 'stopped', 'interrupted']) {
      const terminal = [{ id: 'failed', text: 'q', reply: { source: 'model', status, text: '' } }];
      assert.match(render({ turns: terminal, onRetry() {} }), /重新生成/);
      assert.match(render({ turns: terminal, onRetry() {}, busy: true }), /disabled=""/);
      assert.ok(!render({ turns: terminal }).includes('重新生成'));
    }
    const timeline = [{ text: 'q', reply: { source: 'model', status: 'done', text: '', timeline: [{ type: 'text', id: 'a', text: '*timeline*' }] } }];
    assert.match(render({ turns: timeline }), /<em>timeline<\/em>/);
    const memoryTimeline = [{ text: 'q', reply: { source: 'model', status: 'done', text: 'ok', timeline: [
      { type: 'memory', id: 'm1', query: '偏好', status: 'done', count: 2 },
      { type: 'memory', id: 'm2', query: '项目', status: 'done', count: 0 },
      { type: 'memory', id: 'm3', query: '历史', status: 'error', detail: '搜索失败' },
      { type: 'memory-used', id: 'old', memories: [{ id: 'old-1', text: '旧记忆', source: null, conversationId: null }] },
      { type: 'text', id: 'answer', text: 'ok' },
    ] } }];
    const memoryHtml = render({ turns: memoryTimeline });
    for (const text of ['长期记忆 · 偏好', '2 条记忆', '长期记忆 · 项目', '没有结果', '长期记忆 · 历史', '搜索失败', '旧记忆', '来源未记录']) assert.ok(memoryHtml.includes(text), text);
    assert.ok(!memoryHtml.includes('手动添加'));
    assert.ok(render({ turns: [{ text: 'q', reply: { source: 'model', status: 'streaming', text: '', timeline: [{ type: 'memory', id: 'running', query: '测试', status: 'running' }] } }] }).includes('正在查找'));
    assert.ok(!render({ turns: turns.slice(0, 60) }).includes('加载更早消息'));
  } finally {
    await unlink(path);
  }
});
