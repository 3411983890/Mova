/**
 * 负责：设置页「线路健康状态」那一行的**纯逻辑**——相对时间、延迟分档与文案、一行摘要的数据模型。
 * 不负责：React 渲染（`vpn-health-line.jsx`）、真实测速与切换（`electron/vpn/health.mjs`）。
 * 被谁调用：`vpn-health-line.jsx`（视图层只负责画）、`tests/vpn-health-line.test.mjs`。
 *
 * 为什么单独一个 .mjs：`node --test` 不能直接 import `.jsx`（`ERR_UNKNOWN_FILE_EXTENSION`），
 * 而这些判定又必须被单测钉住（见 tests 文件头）。视图与逻辑分开后两边都能各自演进。
 */

const REGION_UNKNOWN = 'ZZ';

/** 相对时间：只给「刚刚 / N 分钟前 / N 小时前」，超过一天给日期。 */
export function sinceText(at, now = Date.now()) {
  const stamp = Math.max(0, Number(at) || 0);
  if (!stamp) return '';
  const delta = Math.max(0, Number(now) - stamp);
  if (delta < 30_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const date = new Date(stamp);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 延迟分档：只有真的测到才给档位，`null`/0/负数一律「未测速」。 */
export function delayTone(delayMs) {
  const value = Number(delayMs);
  if (!Number.isFinite(value) || value <= 0) return 'untested';
  if (value <= 300) return 'ok';
  if (value <= 800) return 'warn';
  return 'bad';
}

/** 延迟文案：`210 ms`；没测到就是「未测速」（绝不显示 0 ms）。 */
export function delayText(delayMs) {
  const value = Number(delayMs);
  if (!Number.isFinite(value) || value <= 0) return '未测速';
  return `${Math.round(value)} ms`;
}

/**
 * 一行健康摘要的纯数据。
 * @param {{ activeNode?: string, region?: { code?: string, label?: string }|null, checkedAt?: number,
 *   delayMs?: number|null, switched?: { from?: string, to?: string, crossRegion?: boolean, at?: number }|null,
 *   members?: { failures?: number }[] }} [poolHealth]
 * @param {number} [now]
 * @returns {{ title: string, regionLabel: string, delay: string, tone: string, checked: string,
 *   switchNote: string, crossRegion: boolean, unhealthy: number }}
 */
export function healthLineModel(poolHealth, now = Date.now()) {
  const health = poolHealth && typeof poolHealth === 'object' ? poolHealth : {};
  const activeNode = typeof health.activeNode === 'string' ? health.activeNode : '';
  const regionCode = typeof health.region?.code === 'string' ? health.region.code : '';
  const regionText = regionCode && regionCode !== REGION_UNKNOWN
    ? (health.region?.label || regionCode)
    : '未知地区';
  const switched = health.switched && typeof health.switched === 'object' ? health.switched : null;
  const switchedFrom = typeof switched?.from === 'string' ? switched.from : '';
  const switchedTo = typeof switched?.to === 'string' ? switched.to : '';
  const crossRegion = switched?.crossRegion === true;

  const switchNote = switched && switchedFrom && switchedTo
    ? crossRegion
      ? `已跨地区切换：${switchedFrom} → ${switchedTo}（会提高账号风控风险）`
      : `已切到同地区节点：${switchedFrom} → ${switchedTo}`
    : '';

  const failures = (Array.isArray(health.members) ? health.members : [])
    .reduce((total, item) => total + (Number(item?.failures) > 0 ? 1 : 0), 0);

  return {
    title: activeNode || '还没有可用节点',
    regionLabel: regionText,
    delay: delayText(health.delayMs),
    tone: delayTone(health.delayMs),
    checked: health.checkedAt ? `${sinceText(health.checkedAt, now)}检查` : '还没有检查过',
    switchNote,
    crossRegion,
    unhealthy: failures,
  };
}
