import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemorySettings } from '../../src/features/memory/memory-settings.jsx';

// 组件夹具：用假桥接给记忆页喂真实形状的数据，用来验证排版，不写任何文件。
const now = Date.now();
const memories = [
  { id: 'm1', text: '这个项目统一使用中文说明，提交前运行 pnpm test。', status: 'active', kind: 'fact', version: 1, pinned: true, projectId: 'movatext', createdAt: now, conversationId: 'c1', messageId: 'x1' },
  { id: 'm2', text: '界面一律使用暗色，不要引入新的色相。', status: 'active', kind: 'preference', version: 1, pinned: false, projectId: 'movatext', createdAt: now },
  { id: 'm3', text: 'Mova 的会话存储以 PostgreSQL 为权威，本地 JSON 只作回退。', status: 'active', kind: 'decision', version: 2, pinned: false, projectId: null, createdAt: now },
];
const tasks = Array.from({ length: 7 }, (_, index) => ({
  id: `job-${index}`,
  status: index === 2 ? 'skipped' : index === 4 ? 'failed' : 'done',
  attempts: 1,
  updatedAt: now - index * 3600_000,
  projectId: 'movatext',
  conversationId: '["CodeMova","movatext","新建文件"]',
  ...(index === 4 ? { lastError: 'sensitive-content' } : {}),
}));

const ok = value => Promise.resolve({ ok: true, value });
const bridge = {
  read: () => ok({
    memories, tasks, settings: { memoryEnabled: true, autoExtract: true, includeGlobal: true, contextMaxMemories: 12, contextMaxChars: 6000, maxMemories: 2000 },
    sessions: { conversations: {} }, checkpoints: [], events: [],
    storage: { filePath: 'C:\\Users\\34119\\AppData\\Roaming\\Mova\\memory.json' },
  }),
  jobs: () => ok(tasks),
  save: () => ok({}),
  update: () => ok({}),
  delete: () => ok({}),
  clear: () => ok({}),
  settings: () => ok({}),
  export: () => ok({ memories: [] }),
  search: () => ok(memories),
  maintenance: () => ok({ stats: { archive: 2, mergeGroups: 1, keep: 5 } }),
  vault: {
    status: () => ok({ configured: true, unlocked: true }),
    list: () => ok([
      { name: 'openai_api_key', kind: 'api-key', preview: '3f9a', updatedAt: now },
      { name: 'deploy_token', kind: 'token', preview: '77c1', updatedAt: now },
    ]),
    get: () => ok('secret'),
    put: () => ok({}),
    remove: () => ok({}),
    lock: () => ok({}),
    unlock: () => ok({}),
    setup: () => ok({}),
    changePassphrase: () => ok({}),
  },
};

createRoot(document.getElementById('root')).render(
  React.createElement(MemorySettings, { bridge, projectId: 'movatext' }),
);
