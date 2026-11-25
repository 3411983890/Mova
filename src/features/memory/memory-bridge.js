// Shared bridge helpers for the memory settings page.
// Every bridge call returns { ok: true, value } | { ok: false, error };
// `invoke` normalizes failures into an Error whose message is a Chinese code label.

export const ERROR_LABELS = {
  'invalid-input': '输入无效，请检查内容和数值范围。',
  'invalid-settings': '设置无效，请检查数值范围。',
  'sensitive-content': '内容疑似包含密码或密钥，仓库拒绝保存。请移除敏感信息。',
  'memory-limit': '记忆数量已达到仓库上限，请删除不再需要的记忆。',
  'storage-error': '本地存储失败，请检查磁盘空间和文件权限。',
  'corrupt-store': '本地仓库无法读取或文件已损坏，请先保留原文件。',
  'not-found': '该记录已不存在，请重新读取。',
  'key-conflict': '已有同类生效记忆，请先停用冲突项。',
  'invalid-status': '此记忆当前状态不允许该操作。',
  unsupported: '当前桌面端尚未提供该接口，请升级到服务版并重启 Mova。',
  'not-implemented': '该功能尚未实现，当前版本不会伪造结果。',
  'db-unavailable': '数据库不可用，请检查 PostgreSQL 服务是否已启动。',
  'queue-unavailable': '队列不可用（Redis 未连接），后台任务无法排队。',
  'embedding-unavailable': 'Embedding 模型不可用，语义通道已回退到关键词检索。',
  'backup-failed': '备份失败，旧备份已保留；请检查磁盘空间与数据库日志。',
  'backup-running': '已有备份任务正在进行，请稍后重试。',
  'backup-not-completed': '只能恢复已完成的备份。',
  'restore-failed': '恢复失败，现有数据已保留；请检查备份完整性与数据库日志。',
  'restore-busy': '恢复或写入暂停进行中，请稍后再试。',
  'restore-in-progress': '正在恢复，暂时不能执行此操作，请稍后重试。',
  'restore-stop-failed': '无法确认所有其他进程和外部连接已停止写入，未执行覆盖恢复。请使用 PITR 工具恢复到新集群。',
  'quota-exceeded': '存储配额已用尽，写入被拒绝；请清理数据或调高配额。',
  'vault-not-configured': '隐私保险库尚未设置主密码。',
  'vault-locked': '隐私保险库已锁定，请先输入主密码解锁。',
  'vault-auth': '主密码不正确。',
  'vault-exists': '隐私保险库已经设置过主密码。',
};

export function errorText(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return ERROR_LABELS[message] || message || '操作失败，请重试。';
}

export async function invoke(bridge, method, ...args) {
  if (typeof bridge?.[method] !== 'function') throw new Error('当前桌面端未提供该接口，请在 Mova 桌面端使用。');
  const result = await bridge[method](...args);
  if (!result?.ok) throw new Error(errorText(result?.error));
  return result.value;
}

export function formatBytes(bytes) {
  if (bytes == null || bytes === '') return '未报告';
  const total = Number(bytes);
  if (!Number.isFinite(total) || total < 0) return '未报告';
  if (total < 1024) return `${total} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = total / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

export function formatTime(value) {
  if (value == null || value === '') return '未记录';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function formatCount(value) {
  if (value == null || value === '') return '未报告';
  const total = Number(value);
  return Number.isFinite(total) ? total.toLocaleString('zh-CN') : String(value);
}
