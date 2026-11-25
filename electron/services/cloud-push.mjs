/**
 * 负责：从工作区通知队列投递通用任务状态，失败后延迟重试。
 * 不负责：申请 iPhone 权限、签发用户设备令牌或传送聊天内容。
 * 被谁调用：cloud-api.mjs。
 */

const ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const TITLES = { done: 'Mova 任务已完成', failed: 'Mova 任务执行失败', blocked: 'Mova 任务等待处理' };
export const validPushToken = value => typeof value === 'string' && /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,180}\]$/.test(value);

export function startCloudPush(queue, accessToken = '') {
  const abort = new AbortController();
  let active;
  const retry = item => item.attempt >= 5 ? queue.remove(item.seq) : queue.retry(item.seq, item.attempt + 1);
  async function deliver() {
    const entries = queue.next();
    if (!entries.length) return;
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST', redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(7000)]),
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(entries.map(item => ({ to: item.token, title: TITLES[item.status], body: '打开 Mova 查看任务状态。', data: { taskId: item.taskId } }))),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        for (const item of entries) retry(item);
        return;
      }
      const result = await response.json();
      entries.forEach((item, index) => {
        const ticket = result.data?.[index];
        if (ticket?.status === 'ok') queue.remove(item.seq);
        else if (ticket?.details?.error === 'DeviceNotRegistered') queue.invalidate(item.token);
        else retry(item);
      });
    } catch {
      if (!abort.signal.aborted) for (const item of entries) retry(item);
    }
  }
  const timer = setInterval(() => {
    active ??= deliver().finally(() => { active = null; });
  }, 3000);
  return async () => { clearInterval(timer); abort.abort(); await active; };
}
