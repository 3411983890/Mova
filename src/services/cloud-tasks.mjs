/**
 * 负责：等待云任务回执并传递取消操作。
 * 不负责：创建任务、存储聊天或选择主机。
 * 被谁调用：项目会话和桌面 Bot 模型运行器。
 */
export async function waitForCloudTask(call, task, { signal, onStatus } = {}) {
  try {
    let previous;
    while (true) {
      signal?.throwIfAborted();
      if (previous !== task.status) { onStatus?.(task.status); previous = task.status; }
      if (task.status === 'done') return task;
      if (!['queued', 'running'].includes(task.status)) {
        throw Object.assign(new Error(task.error || (task.status === 'cancelled' ? '云任务已取消' : '云任务未完成，可重试')), { taskStatus: task.status });
      }
      await new Promise((resolve, reject) => {
        const abort = () => { globalThis.clearTimeout(timer); reject(signal.reason); };
        const timer = globalThis.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1200);
        signal?.addEventListener('abort', abort, { once: true });
      });
      task = await call('task', { id: task.id });
    }
  } finally {
    if (signal?.aborted && ['queued', 'running'].includes(task.status)) {
      await call('cancel', { id: task.id }).catch(() => {});
    }
  }
}
