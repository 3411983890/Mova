// Seeds only an isolated QA Electron profile, never the user's Mova data.
const os = require('node:os');
const path = require('node:path');
const { createMemoryRepository } = require('../../electron/memory-store.cjs');

const directory = path.join(os.tmpdir(), 'mova-memory-smoke-profile', 'memory');
const repository = createMemoryRepository({ directory });

const markdown = [
  '## 会话数据库方案',
  '',
  '已完成 **长期记忆** 与 *会话恢复* 的接入预览。当前使用 `JSON` 原子写入，后续可迁移到 PostgreSQL + pgvector。',
  '',
  '### 已确认事项',
  '',
  '1. 项目记忆默认隔离，全局记忆需要显式允许。',
  '2. 删除记忆时同时停止检索，而不只是隐藏界面。',
  '',
  '> 历史记录完整保留，但每次只发送相关上下文。',
  '',
  '| 能力 | 当前状态 |',
  '| --- | --- |',
  '| Markdown | 已支持 |',
  '| 代码块 | 已支持 |',
  '| 跨聊天语义搜索 | 待接入 |',
  '',
  '```ts',
  'const memory = await repository.context({ projectId: "QA", includeGlobal: false });',
  'console.log(memory.text);',
  '```',
  '',
  '参考：[OWASP AI Memory 安全研究](https://genai.owasp.org/)',
].join('\n');

const turns = [];
for (let i = 1; i <= 65; i++) {
  turns.push({ id: `qa-filler-${i}`, text: `第 ${i} 条较早的消息，用于验证长对话分页。`, reply: { source: 'model', status: 'done', text: `这是第 ${i} 条回复。`, model: 'preview-model' } });
}
turns.push({ id: 'qa-markdown', text: '请用 Markdown 总结长期记忆方案，并给出代码和链接。', reply: { source: 'model', status: 'done', text: markdown, model: 'preview-model' } });
turns.push({ id: 'qa-error', text: '重试一次，看看失败提示。', reply: { source: 'model', status: 'error', error: '模型服务暂时出错，请稍后重试。', text: '', model: 'preview-model' } });

const key = JSON.stringify(['ChatMova', 'QA预览', 'Markdown 与重试体验']);
const snapshot = {
  version: 1,
  projects: [{ name: 'QA预览', chats: [{ title: 'Markdown 与重试体验', mode: 'ChatMova', location: 'local', archived: false, createdAt: Date.now(), updatedAt: Date.now() }] }],
  conversations: [[key, turns]],
};

(async () => {
  await repository.saveSessions(snapshot);
  await repository.saveMemory({ text: '用户喜欢简洁的界面，并希望技术讲解通俗。', kind: 'preference', projectId: null, source: 'user' });
  await repository.saveMemory({ text: 'QA 项目使用本地 JSON 存储，后续计划迁移 PostgreSQL。', kind: 'decision', projectId: 'QA预览', source: 'user' });
  console.log('seeded', directory);
})();
