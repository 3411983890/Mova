import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';

// The trace rows are fed only by the timeline: a tool event that carries a
// command line (or a before/after snapshot) must render the expandable card,
// not the one-line summary row.
test('tool events with detail render the expandable command and change rows', async () => {
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
  const path = new URL(`./.trace-rows-${process.pid}.mjs`, import.meta.url);
  await writeFile(path, code);
  try {
    const { ChatTranscript } = await import(path.href);
    const timeline = [
      { type: 'thinking', id: 't1', round: 1, text: '先跑一下脚本' },
      {
        type: 'tool', id: 'c1', name: 'run_command', label: '运行命令', status: 'done',
        detail: '退出码 0 · 98 ms', command: 'node -e "console.log(4+4)"', cwd: 'Mova',
        output: ['8'], exitCode: 0,
      },
      {
        type: 'tool', id: 'w1', name: 'write_file', label: '写入文件', status: 'done',
        detail: 'mova/probe.js · 30 字节', path: 'mova/probe.js',
        diff: { kind: 'write', path: 'mova/probe.js', before: 'const a = 1;\n', after: 'const a = 2;\n', truncated: false },
      },
      { type: 'tool', id: 'l1', name: 'list_files', label: '列出文件', status: 'done', detail: '3 项' },
      { type: 'text', id: 'a1', text: '好了' },
    ];
    const turns = [{ id: 'turn-1', text: '跑一下', reply: { source: 'model', status: 'done', text: '', timeline } }];
    const html = renderToStaticMarkup(React.createElement(ChatTranscript, { turns, viewport: {} }));

    // run_command → terminal card with the command and its output
    assert.match(html, /class="cmd-card"/);
    assert.match(html, /node -e &quot;console\.log\(4\+4\)&quot;/);
    assert.match(html, /class="cmd-cwd">Mova</);
    assert.match(html, /class="cmd-output-line"[^>]*>8</);
    // write_file → change card with a real diff
    assert.match(html, /class="edit-card"/);
    assert.match(html, /data-kind="remove"/);
    assert.match(html, /data-kind="add"/);
    assert.match(html, /mova\/probe\.js · 30 字节/);
    // a tool without extra detail keeps the plain row
    assert.match(html, /列出文件/);
    assert.match(html, /3 项/);
    assert.equal((html.match(/class="cmd-card"/g) || []).length, 1);
    assert.equal((html.match(/class="edit-card"/g) || []).length, 1);
  } finally {
    await unlink(path);
  }
});
