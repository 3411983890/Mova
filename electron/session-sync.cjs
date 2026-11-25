'use strict';

// ── 行比较：稳定序列化 ───────────────────────────────────────────────────────
// `mova_session_events.content` / `mova_settings.data` 是 Postgres **jsonb**：
// 写进去再读出来，键顺序会被重排（先按 key 的字节长度、再按字节序）。所以拿
// `JSON.stringify(a) === JSON.stringify(b)` 比较「磁盘读回的行」和「渲染层的行」
// 是**系统性**失效的——同一份数据换个键序就不相等。删除判定因此永远不成立，
// 2 秒后 `syncWorkspace()` 的整份覆盖就把删掉的聊天又塞回界面（「删了又回来」）。
//
// 这里做两件事：
//   1. 递归按键名排序后再序列化（键序不再影响判定）；
//   2. 时间字段统一折算成毫秒再比较：服务端给 ISO 字符串、渲染层给数字，
//      它们是同一条数据，不该判成「不一样」。
const TIME_FIELDS = new Set(['at', 'createdAt', 'created_at', 'updatedAt', 'updated_at']);

function millis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function canonical(value, field) {
  if (TIME_FIELDS.has(field)) {
    const ms = millis(value);
    if (ms !== null) return ms;
  }
  if (Array.isArray(value)) return value.map(item => canonical(item, ''));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key], key);
    return out;
  }
  return value === undefined ? null : value;
}

const stableStringify = value => JSON.stringify(canonical(value, ''));
const same = (a, b) => a === b || stableStringify(a) === stableStringify(b);

// 只比「内容」：时间字段折算成 0 再比较。并发保护的判定需要区分「别人真的改了内容」
// 和「只是又一次保存把 updatedAt 刷新了」，后者不能挡住删除（否则删除会周期性失效）。
function contentCanonical(value, field) {
  if (TIME_FIELDS.has(field) && millis(value) !== null) return 0;
  if (Array.isArray(value)) return value.map(item => contentCanonical(item, ''));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = contentCanonical(value[key], key);
    return out;
  }
  return value === undefined ? null : value;
}
const contentChanged = (a, b) => JSON.stringify(contentCanonical(a, '')) !== JSON.stringify(contentCanonical(b, ''));
const chatKey = chat => JSON.stringify([chat.mode || 'CodeMova', chat.title]);

// ── 更新时间：并发编辑保护的比较基准 ────────────────────────────────────────
// 一行的「更新时间」既可能是数字毫秒（渲染层、`buildProjects()`），也可能是 ISO
// 字符串（Postgres），所以两个形状都要认。取不到就是 null：没有可比时间戳的行
// 一律按「删除意图」处理（默认删），这也是审计要求的默认值。
function stampOf(value) {
  if (!value || typeof value !== 'object') return null;
  let max = null;
  for (const field of ['updatedAt', 'updated_at', 'createdAt', 'created_at', 'at']) {
    const ms = millis(value[field]);
    if (ms !== null && (max === null || ms > max)) max = ms;
  }
  return max;
}

// 会话行的形状是 `[key, turns]`：会话表上的 `updated_at` 是**保存时间**（每次
// 快照都会刷新），拿它当基准会把「同一份内容的重复保存」误判成并发编辑，删除
// 会被永久挡住。所以会话行只比消息自己的时间（`turn.at` / `turn.updatedAt`）。
function rowStamp(row) {
  if (Array.isArray(row)) {
    let max = null;
    for (const item of row.slice(1)) {
      const candidates = Array.isArray(item) ? item : [item];
      for (const candidate of candidates) {
        const ms = stampOf(candidate);
        if (ms !== null && (max === null || ms > max)) max = ms;
      }
    }
    return max;
  }
  return stampOf(row);
}

const warnConcurrentKeep = info => {
  console.warn('[session-sync] 磁盘上的这一行在本窗口上次读取之后被改过，删除被跳过（保留别人的新改动）', info);
};

/**
 * 把本窗口的「删除 / 新增 / 编辑」意图合并到磁盘现状上。
 *
 * 删除判定基于**意图**而不是整行全等：
 *   - `before`（本窗口上次看到的服务端快照）里有、`after` 里没有 → 删除意图，
 *     **默认删**；
 *   - 只有当磁盘行比 `before` 里那一行**更新**（`updatedAt` 更晚）**且内容真的
 *     不同**时，才认为别的客户端刚改过它 → 保留磁盘行并告警（并发编辑保护）。
 *     「内容相同只是时间戳形状不同」不算改过，否则重复保存会永久挡住删除。
 *
 * @param {Array} current 磁盘现状（服务端形状）
 * @param {Array} before  本窗口上次看到的服务端快照
 * @param {Array} after   本窗口这次要保存的形状
 * @param {Function} key  行 → 键
 * @param {Function} merge 同一行在本窗口里被改过时怎么合并
 * @param {{guard?: boolean, label?: string, onKeep?: Function}} options
 *        `guard: false` 关闭并发保护（项目行用：它只有 overlay 属性，没有自己的
 *        内容时间，任何「更新时间更晚」都不是真人编辑）。
 */
function mergeRows(current, before, after, key, merge = (_current, _before, next) => next, options = {}) {
  const guard = options.guard !== false;
  const label = options.label || 'row';
  const onKeep = options.onKeep || warnConcurrentKeep;
  const result = new Map((Array.isArray(current) ? current : []).map(row => [key(row), row]));
  const previous = new Map((Array.isArray(before) ? before : []).map(row => [key(row), row]));
  const next = new Map((Array.isArray(after) ? after : []).map(row => [key(row), row]));

  for (const [id, baseRow] of previous) {
    if (next.has(id)) continue;
    const diskRow = result.get(id);
    if (diskRow === undefined) continue;
    const diskStamp = rowStamp(diskRow);
    const baseStamp = rowStamp(baseRow);
    const concurrent = guard && diskStamp !== null && baseStamp !== null
      && diskStamp > baseStamp && contentChanged(diskRow, baseRow);
    if (concurrent) {
      onKeep({ kind: label, key: id, diskStamp, baseStamp });
      continue;
    }
    result.delete(id);
  }

  for (const [id, row] of next) {
    const old = previous.get(id);
    if (old !== undefined) {
      if (same(old, row)) continue; // 本窗口没动过这一行：磁盘现状优先
      if (!result.has(id)) continue; // 别的客户端删掉了它：删除优先于过期编辑
    }
    result.set(id, merge(result.get(id), old, row));
  }
  return [...result.values()];
}

function mergeSessions(current, before, after, options = {}) {
  if (!before) return after;
  if (same(current, before)) return after;
  const onKeep = options.onKeep;
  const turnKey = (turn, index) => turn.id ?? index;
  const rows = (items = []) => items.map((turn, index) => [turnKey(turn, index), turn]);
  const disk = current || {};
  const base = before || {};
  const next = after || {};
  // 这些字段是**服务端 overlay** 里的东西（`buildProjects()` 从库里重建出来的）。
  // 渲染层没带上它们，不代表用户把它删了；按「没有就删」处理会静默丢掉项目的
  // sourceFolders / memory / device，所以只覆盖、不删除。
  const overlayFields = new Set(['sourceFolders', 'memory', 'device']);
  return {
    version: 1,
    projects: mergeRows(disk.projects, base.projects, next.projects, row => row.name,
      (live, old, changed) => {
        if (!live) return changed;
        const merged = { ...live };
        for (const field of new Set([...Object.keys(old || {}), ...Object.keys(changed)])) {
          if (field === 'chats' || same(old?.[field], changed[field])) continue;
          if (Object.hasOwn(changed, field)) merged[field] = changed[field];
          else if (!overlayFields.has(field)) delete merged[field];
        }
        merged.chats = mergeRows(live.chats, old?.chats || [], changed.chats, chatKey, undefined,
          { label: 'chat', onKeep });
        return merged;
      }, { guard: false, label: 'project', onKeep }),
    conversations: mergeRows(disk.conversations, base.conversations, next.conversations, row => row[0],
      (live, old, changed) => [changed[0], mergeRows(rows(live?.[1]), rows(old?.[1]), rows(changed[1]), row => row[0], undefined,
        { label: 'turn', onKeep }).map(row => row[1])],
      { label: 'conversation', onKeep }),
    ...Object.fromEntries(['aims', 'usage', 'permissionPresets', 'modelSelections'].map(field => [field,
      mergeRows(disk[field] || [], base[field] || [], next[field] || [], row => row[0], undefined,
        { label: field, onKeep })])),
  };
}

function createSessionSync() {
  let pending = Promise.resolve();
  // client → { revision, sessions }：这个窗口最后一次看到（或写入）的**服务端可比形状**。
  // 以前这里存的是渲染层快照，还依赖一次性的 `previews`；一旦命中过一次 preview
  // 就没有基线可比，删除于是「有时生效、过一阵复发」。现在基线常驻，且永远带 revision。
  const baselines = new Map();
  let latest = null; // 最近一次读到的服务端快照（任意窗口）
  let revision = 0;
  const run = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  const remember = (client, entry) => {
    baselines.set(client, entry);
    latest = entry;
  };
  /**
   * 选一条可比基线。优先用这个窗口自己的（它对应渲染层已知的 revision）；
   * 渲染层丢了 revision（`refresh` 之后）或基线落后时就退回最近一次服务端快照。
   */
  const baselineFor = (client, acceptedRevision) => {
    const own = baselines.get(client) || null;
    if (own && (acceptedRevision === undefined || own.revision === acceptedRevision || own.revision === revision)) {
      return own.sessions;
    }
    if (latest) return latest.sessions;
    return own ? own.sessions : null;
  };
  return {
    read: (client, repository, known) => run(async () => {
      if (known === revision && baselines.has(client)) return { revision };
      const sessions = await repository.loadSessions();
      remember(client, { revision, sessions });
      return { revision, sessions };
    }),
    save: (client, repository, snapshot, acceptedRevision) => run(async () => {
      if (snapshot?.version !== 1 || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.conversations) ||
          snapshot.projects.some(row => !row || !Array.isArray(row.chats))) throw new Error('invalid-snapshot');
      const current = await repository.loadSessions();
      const before = baselineFor(client, acceptedRevision);
      const merged = mergeSessions(current, before, snapshot);
      if (!same(current, merged)) {
        await repository.saveSessions(merged);
        revision += 1;
      }
      // 写完立刻把「刚写进去的合并结果」记为基线：下一轮删除判定比的就是它，
      // 不需要再等一次 read，也不依赖一次性 preview。
      remember(client, { revision, sessions: merged });
      return { revision, refresh: !same(merged, snapshot) };
    }),
    changed: () => { revision += 1; },
    forget: client => { baselines.delete(client); },
  };
}

module.exports = { createSessionSync, mergeSessions, mergeRows, same, stableStringify, rowStamp };
