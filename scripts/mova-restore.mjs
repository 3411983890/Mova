/**
 * 负责：在服务停止后校验并恢复 Mova 工作区备份。
 * 不负责：恢复模型账户、VPN 密钥或既有设备令牌。
 * 被谁调用：mova-control.mjs 的 restore 命令。
 */

import { copyFile, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export async function restoreCloudBackup(paths, source) {
  if (paths.database === source) throw new Error('备份文件须与工作区文件分开');
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const candidate = `${paths.database}.${randomUUID()}.new`;
  const prior = `${paths.database}.${Date.now()}.before-restore`;
  try {
    await copyFile(source, candidate);
    await chmod(candidate, 0o600);
    const db = new DatabaseSync(candidate);
    try {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份完整性检查失败');
      for (const name of ['bots', 'conversations', 'tasks', 'events', 'pairs', 'devices']) {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error('此文件不是 Mova 工作区备份');
      }
      db.exec("BEGIN; DELETE FROM devices; DELETE FROM pairs; UPDATE tasks SET status='queued',owner=NULL,lease_until=NULL WHERE status='running'; COMMIT;");
      db.exec('PRAGMA journal_mode=DELETE');
    } finally { db.close(); }
    // VACUUM captures pending WAL as well, so the pre-restore copy stays usable after removing sidecars.
    let retained = null;
    try {
      const current = new DatabaseSync(paths.database, { readOnly: true });
      try { current.prepare('VACUUM INTO ?').run(prior); } finally { current.close(); }
      await chmod(prior, 0o600);
      retained = prior;
    } catch (error) { if (error.code !== 'ERR_SQLITE_ERROR' || !/unable to open database file/i.test(error.message)) throw error; }
    await rm(`${paths.database}-wal`, { force: true });
    await rm(`${paths.database}-shm`, { force: true });
    await rename(candidate, paths.database);
    return { restored: paths.database, retained, devicesNeedPairing: true };
  } finally { await rm(candidate, { force: true }); }
}
