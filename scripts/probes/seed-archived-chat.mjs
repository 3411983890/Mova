/**
 * 负责：往**真实库**里塞一条「已归档、但没有会话行」的聊天，用于在运行中的应用里目视验证归档页。
 * 不负责：清理（验证完要在「已归档的聊天」页里点删除，那条路径本身也是被验证的对象）。
 * 被谁调用：手工排查脚本，不在测试链里。
 *
 * 安全性：先把当前 settings 行导出到 qa/mova-settings-backup-<时间>.json，再用
 * 与 app.js 相同的 repository.saveSessions() 写入——快照从 loadSessions() 读出来再加一条，
 * 不会顺手删掉任何既有项目或会话。
 *
 * 用法：node scripts/probes/seed-archived-chat.mjs ["项目名"] ["聊天标题"]
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createPostgresRepository } = require('../../electron/db/postgres-repository.cjs');

const DB_URL = process.env.MOVA_DB_URL || 'postgres://mova:mova_local_password@127.0.0.1:55432/mova';
const project = process.argv[2] || 'Mova';
const title = process.argv[3] || '验证用：归档里的聊天';

mkdirSync('qa', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join('qa', `mova-settings-backup-${stamp}.json`);

const pg = require('pg');
const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
const settings = await pool.query('select owner_id, data from mova_settings');
writeFileSync(backup, JSON.stringify(settings.rows, null, 2), 'utf8');
console.log(`# 备份已写 ${backup}`);
await pool.end();

const repository = createPostgresRepository({ connectionString: DB_URL });
const loaded = await repository.loadSessions();
const projects = loaded.projects.map(row => ({ ...row, chats: [...row.chats] }));
let target = projects.find(row => row.name === project);
if (!target) {
  target = { name: project, chats: [], sourceFolders: [], memory: 'default', device: 'local' };
  projects.push(target);
}
const now = Date.now();
if (!target.chats.some(chat => chat.title === title)) {
  target.chats.push({
    title, mode: 'ChatMova', location: 'local', archived: true,
    createdAt: now - 3_600_000, updatedAt: now,
  });
}
await repository.saveSessions({
  version: 1,
  projects,
  conversations: loaded.conversations,
  aims: loaded.aims,
  usage: loaded.usage,
  permissionPresets: loaded.permissionPresets,
});

const after = await repository.loadSessions();
const found = after.projects.find(row => row.name === project)?.chats?.find(chat => chat.title === title) || null;
console.log(`# 写入结果：${found ? '存在' : '缺失'} archived=${found?.archived} updatedAt=${found?.updatedAt}`);
console.log(`# 归档页可见性取决于 buildProjects()，请到「设置 → 已归档的聊天」查看：${JSON.stringify([ 'ChatMova', project, title ])}`);
process.exit(found?.archived === true ? 0 : 1);
