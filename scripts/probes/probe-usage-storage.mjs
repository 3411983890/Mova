/**
 * 只读检查：用真实的 PostgreSQL 跑一遍新版 loadSessions()/read()，
 * 确认会话级状态（目标 / 计划、真实用量）能带出来且不会抛错。
 * 不写入任何数据。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPostgresRepository } = require('../../electron/db/postgres-repository.cjs');

const repository = createPostgresRepository({
  connectionString: 'postgres://mova:mova_local_password@127.0.0.1:55432/mova',
  inlineIndex: false,
});

const sessions = await repository.loadSessions();
const snapshot = await repository.read();
await repository.close?.().catch?.(() => {});

const summary = {
  conversations: sessions.conversations.length,
  projects: sessions.projects.map(project => project.name),
  aimsType: Array.isArray(sessions.aims) ? `array(${sessions.aims.length})` : typeof sessions.aims,
  usageType: Array.isArray(sessions.usage) ? `array(${sessions.usage.length})` : typeof sessions.usage,
  readAims: Array.isArray(snapshot.sessions.aims) ? snapshot.sessions.aims.length : 'missing',
  readUsage: Array.isArray(snapshot.sessions.usage) ? snapshot.sessions.usage.length : 'missing',
  settingsKeysAreClean: !Object.hasOwn(await repository.settings(), '@chatUsage'),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
