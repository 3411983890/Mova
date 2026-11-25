/**
 * 在**真 Postgres**上端到端复现用户的三个投诉，验证修复有效：
 *   1. 归档的对话重启后还在，并且会出现在归档列表里（包括库里没有会话行的聊天）；
 *   2. 永久删除的聊天重启后不再回来；
 *   3. 移除项目后侧栏不再出现。
 *
 * 做法：在同一个 Postgres 实例里建一个**临时库**（默认 mova_verify），跑完整迁移，
 * 然后用与 app.js 完全相同的调用链（createSessionSync + createPostgresRepository）
 * 写入 / 读回。"重启" = 丢掉 repository 与 sync 实例，重新建一份（基线缓存也一起没）。
 *
 * 不碰用户真库（mova）。跑完删掉临时库。
 *
 * 用法：node scripts/probes/probe-session-persistence.mjs [--keep]
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migrate } = require('../../electron/db/migrate.cjs');
const { createPostgresRepository } = require('../../electron/db/postgres-repository.cjs');
const { createSessionSync } = require('../../electron/session-sync.cjs');

const ADMIN_URL = process.env.MOVA_DB_ADMIN_URL || 'postgres://mova:mova_local_password@127.0.0.1:55432/mova';
const DB_NAME = process.env.MOVA_VERIFY_DB || 'mova_verify';
const VERIFY_URL = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
const KEEP = process.argv.includes('--keep');

const keyOf = (project, title, mode = 'CodeMova') => JSON.stringify([mode, project, title]);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const chatsOf = (loaded, project) => (loaded.projects.find(p => p.name === project)?.chats) ?? [];
const findChat = (loaded, project, title) => chatsOf(loaded, project).find(c => c.title === title) || null;
const turn = (id, at, text) => ({ id, text, at, reply: { source: 'model', status: 'done', text: `${text} → ok` } });

async function withPg(fn) {
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  try { return await fn(pool); } finally { await pool.end().catch(() => {}); }
}

async function recreateDatabase() {
  await withPg(async pool => {
    await pool.query(`drop database if exists ${DB_NAME}`).catch(async error => {
      // 有残留连接时先踢掉再删
      if (!/being accessed|is being accessed/.test(String(error?.message))) throw error;
      await pool.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [DB_NAME]);
      await pool.query(`drop database if exists ${DB_NAME}`);
    });
    await pool.query(`create database ${DB_NAME}`);
  });
}

async function dropDatabase() {
  await withPg(async pool => {
    await pool.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [DB_NAME]);
    await pool.query(`drop database if exists ${DB_NAME}`);
  });
}

/** 模拟 app.js：一个窗口 = 一个 client id，一份 repository + sync。 */
function newSession(client = 'probe-window') {
  const repository = createPostgresRepository({ connectionString: VERIFY_URL });
  const sync = createSessionSync();
  return {
    client,
    repository,
    sync,
    read: () => sync.read(client, repository).then(result => result.sessions),
    save: (snapshot, revision) => sync.save(client, repository, snapshot, revision),
  };
}

const t0 = Date.parse('2026-11-10T02:00:00.000Z');
const t1 = Date.parse('2026-11-12T08:30:00.000Z');

async function main() {
  console.log(`# 临时库 ${DB_NAME} @ ${VERIFY_URL.replace(/:[^:@/]+@/, ':***@')}`);
  await recreateDatabase();
  await migrate({ connectionString: VERIFY_URL, log: () => {} });
  console.log('# 迁移完成');

  // ── 场景 1：首次保存，一条普通聊天 + 一条「归档但没有会话行」的聊天 ──────────
  const first = newSession();
  const plainKey = keyOf('Alpha', '正常聊天');
  const archivedKey = keyOf('Alpha', '已归档聊天');
  const snapshotA = {
    version: 1,
    projects: [{
      name: 'Alpha',
      chats: [
        { title: '正常聊天', mode: 'CodeMova', archived: false, location: 'local', createdAt: t0, updatedAt: t1 },
        { title: '已归档聊天', mode: 'CodeMova', archived: true, location: 'local', createdAt: t0, updatedAt: t1 - 3_600_000 },
      ],
    }],
    conversations: [[plainKey, [turn('m1', t1, '你好'), turn('m2', t1 + 1000, '再来一句')]]],
  };
  const savedA = await first.save(snapshotA);
  check('保存返回 revision', typeof savedA?.revision === 'number', savedA);

  const loadedA = await first.read();
  check('读回：普通聊天存在', Boolean(findChat(loadedA, 'Alpha', '正常聊天')));
  check('读回：归档聊天存在（库里没有会话行也要保留）', Boolean(findChat(loadedA, 'Alpha', '已归档聊天')));
  check('读回：归档聊天 archived=true', findChat(loadedA, 'Alpha', '已归档聊天')?.archived === true);
  check('读回：普通聊天 archived=false', findChat(loadedA, 'Alpha', '正常聊天')?.archived === false);
  check('读回：时间戳是数字毫秒', typeof findChat(loadedA, 'Alpha', '正常聊天')?.updatedAt === 'number',
    findChat(loadedA, 'Alpha', '正常聊天')?.updatedAt);
  check('读回：归档页排序不是 NaN',
    Number.isFinite((findChat(loadedA, 'Alpha', '正常聊天')?.updatedAt ?? NaN) - (findChat(loadedA, 'Alpha', '已归档聊天')?.updatedAt ?? NaN)));

  // ── 场景 2：重启（丢实例、丢基线缓存）后归档仍然在 ───────────────────────
  const restarted = newSession('probe-window-2');
  const loadedB = await restarted.read();
  check('重启读回：归档聊天仍在', Boolean(findChat(loadedB, 'Alpha', '已归档聊天')));
  check('重启读回：归档聊天 archived=true', findChat(loadedB, 'Alpha', '已归档聊天')?.archived === true);
  check('重启读回：普通聊天仍在', Boolean(findChat(loadedB, 'Alpha', '正常聊天')));

  // ── 场景 3：同一份快照重复保存两次，归档聊天不能 flip-flop ──────────────
  await restarted.save(snapshotA);
  await restarted.save(snapshotA);
  const loadedC = await newSession('probe-window-3').read();
  check('重复保存两次后归档聊天仍在', Boolean(findChat(loadedC, 'Alpha', '已归档聊天')));
  check('重复保存两次后普通聊天仍在', Boolean(findChat(loadedC, 'Alpha', '正常聊天')));

  // ── 场景 4：永久删除普通聊天（含它的会话行）────────────────────────────
  const deleter = newSession('probe-window-4');
  await deleter.read(); // 建立本窗口基线
  await deleter.save({
    version: 1,
    projects: [{
      name: 'Alpha',
      chats: [{ title: '已归档聊天', mode: 'CodeMova', archived: true, location: 'local', createdAt: t0, updatedAt: t1 - 3_600_000 }],
    }],
    conversations: [],
  });
  const loadedD = await deleter.read();
  check('删除后：普通聊天不在', findChat(loadedD, 'Alpha', '正常聊天') === null);
  const loadedE = await newSession('probe-window-5').read();
  check('重启后：已删的普通聊天没有回来', findChat(loadedE, 'Alpha', '正常聊天') === null);

  // ── 场景 5：永久删除归档聊天（不能靠 @chatArchived 复活）────────────────
  const deleter2 = newSession('probe-window-6');
  await deleter2.read();
  await deleter2.save({ version: 1, projects: [{ name: 'Alpha', chats: [] }], conversations: [] });
  const loadedF = await deleter2.read();
  check('删除归档聊天后：不在', findChat(loadedF, 'Alpha', '已归档聊天') === null);
  const loadedG = await newSession('probe-window-7').read();
  check('重启后：已删的归档聊天没有回来', findChat(loadedG, 'Alpha', '已归档聊天') === null);

  // ── 场景 6：移除项目 ───────────────────────────────────────────────────
  const deleter3 = newSession('probe-window-8');
  await deleter3.read();
  await deleter3.save({ version: 1, projects: [], conversations: [] });
  const loadedH = await deleter3.read();
  check('删除项目后：项目不在', loadedH.projects.every(p => p.name !== 'Alpha'), loadedH.projects.map(p => p.name));
  const loadedI = await newSession('probe-window-9').read();
  check('重启后：项目没有回来', loadedI.projects.every(p => p.name !== 'Alpha'), loadedI.projects.map(p => p.name));

  // ── 场景 7：库里的真实行数（删除必须真的落到 SQL，而不是只改快照）──────
  await withPg(async pool => { /* 占位：保持 withPg 被使用 */ });
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: VERIFY_URL, max: 1 });
  try {
    const conv = await pool.query('select count(*)::int as n from mova_conversations');
    check('库里会话行真的删掉了', conv.rows[0].n === 0, conv.rows[0]);
    const proj = await pool.query('select name from mova_projects');
    check('库里项目行真的删掉了', proj.rows.every(row => row.name !== 'Alpha'), proj.rows);
    const settings = await pool.query('select data from mova_settings');
    const archived = settings.rows[0]?.data?.['@chatArchived'] ?? [];
    check('@chatArchived 已清空（不留复活源）', Array.isArray(archived) && archived.length === 0, archived);
  } finally {
    await pool.end().catch(() => {});
  }

  const failed = results.filter(row => !row.ok);
  console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log('# 失败项：' + failed.map(row => row.name).join('；'));
  return failed.length;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('探针异常：', error?.stack || error?.message || error);
  code = 2;
} finally {
  if (!KEEP) {
    await dropDatabase().catch(error => console.error('清理临时库失败：', error?.message || error));
  } else {
    console.log(`# --keep：保留临时库 ${DB_NAME}`);
  }
}
process.exit(code);
