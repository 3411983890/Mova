/**
 * 负责：把 `memory:read` 那 8 秒拆开，看时间到底花在哪个 store 调用上。
 * 不负责：修改任何数据（只读 + 一次 seed，与启动时相同）。
 * 被谁调用：手工排查脚本。
 *
 * 背景：启动日志里 `slow-ipc memory:read durationMs≈8800-10100`，而库里只有 2 个项目、
 * 24 条记忆、0 条会话——这个量级不该要 9 秒。loadSessions() 只调 4 个查询，
 * 所以先逐个计时，再把整条 read() 计时，差值是模块加载/embedding 之类的固定成本。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DB_URL = process.env.MOVA_DB_URL || 'postgres://mova:mova_local_password@127.0.0.1:55432/mova';
const { createPgStore, DEFAULT_OWNER_ID } = require('../../electron/db/postgres-store.cjs');

const time = async (label, fn) => {
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const size = Array.isArray(value) ? `${value.length} rows` : '';
  console.log(`${label.padEnd(26)} ${ms.toFixed(1).padStart(8)} ms  ${size}`);
  return { value, ms };
};

const store = createPgStore({ connectionString: DB_URL, ownerId: DEFAULT_OWNER_ID, max: 2 });
await time('connect+seed', () => store.seed());
await time('settingsData', () => store.settingsData());
await time('projects', () => store.projects());
await time('conversations', () => store.conversations());
await time('memories', () => store.memories());
await time('databaseBytes', () => store.databaseBytes());
await time('counts', () => store.counts());
console.log('--- 第二轮（连接已热）');
await time('settingsData', () => store.settingsData());
await time('projects', () => store.projects());
await time('conversations', () => store.conversations());
await time('memories', () => store.memories());

console.log('--- 整条 repository.read()');
const { createPostgresRepository } = require('../../electron/db/postgres-repository.cjs');
const repository = createPostgresRepository({ connectionString: DB_URL });
const read = await time('repository.read', () => repository.read());
console.log(`     projects=${read.value.sessions?.projects?.length ?? 0} memories=${read.value.memories?.length ?? 0}`);
const load = await time('repository.loadSessions', () => repository.loadSessions());
console.log(`     projects=${load.value.projects.length} conversations=${load.value.conversations.length}`);
await store.close();
process.exit(0);
