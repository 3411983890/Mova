/**
 * 「网络与线路」设置页的数据钩子。
 *
 * 负责：把 `window.movaDesktop.vpn` 的 IPC 调用与 `vpn:event` 推送收敛成 React 状态
 * （status / providers / busy / error），并提供「线路 → 下拉选项」与「下拉值 → 路由指向」
 * 两个纯换算；桥接缺失时给出明确的「不可用」状态而不是空白页。
 * 不负责：展示结构（vpn-settings.jsx）、样式（vpn-settings.css）、主进程校验。
 *
 * 通道名与错误文案全部来自 `electron/vpn/contract.mjs`，本文件不复制字面量。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ERROR_TEXT, summarizeImportResult, toErrorCode } from '../../../electron/vpn/contract.mjs';

/** 没有 Electron 桥接（浏览器里直接打开 dist/index.html）时的占位状态。 */
const BRIDGE_MISSING = Object.freeze({ bridgeMissing: true });

function messageOf(error) {
  if (typeof error === 'string') return ERROR_TEXT[error] ?? ERROR_TEXT.request;
  const code = toErrorCode(error);
  const fallback = typeof error?.message === 'string' && error.message ? error.message : ERROR_TEXT.request;
  return ERROR_TEXT[code] ?? fallback;
}

/**
 * 桥接返回 `{ ok, value }` / `{ ok: false, error: 错误码, message: 具体原因 }`；也接受裸值。
 *
 * 失败时**优先用主进程给的具体原因**：`fail()` 把「策略池至少要选择一个节点」「订阅链接必须
 * 是 http(s) 地址」这类能直接照着改的话放在 `message` 里，而 `error` 只是错误码。以前这里
 * 只读错误码，界面就只能显示通用的「所选线路节点不可用或已超时」，用户看不出该改什么。
 */
function unwrap(result) {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (!result.ok) {
      const code = typeof result.error === 'string' ? result.error : toErrorCode(result.error);
      const specific = typeof result.message === 'string' ? result.message.trim() : '';
      throw Object.assign(new Error(specific || ERROR_TEXT[code] || messageOf(result.error)), { code });
    }
    return result.value;
  }
  return result;
}

const DIRECT_VALUE = 'direct';

/**
 * 一条路由指向 → 下拉框的值。
 * `modelOverrides` 与 `routes` 用同一套编码，继承关系由「没有这个键」表达。
 */
export function routeValueOf(target) {
  if (!target || typeof target !== 'object') return DIRECT_VALUE;
  if (target.mode === 'pool' && target.poolId) return `pool:${target.poolId}`;
  if (target.mode === 'node' && target.nodeId) return `node:${target.nodeId}`;
  return DIRECT_VALUE;
}

/** 下拉框的值 → 路由指向（与 `normalizeRouteTarget` 可接受的形状一致）。 */
export function parseRouteValue(value, { failover = true } = {}) {
  const text = String(value ?? '');
  if (text.startsWith('pool:') && text.length > 5) return { mode: 'pool', poolId: text.slice(5), failover };
  if (text.startsWith('node:') && text.length > 5) return { mode: 'node', nodeId: text.slice(5), failover };
  return { mode: 'direct', failover };
}

/** 下拉选项：直连 + 每个策略池 + 每个固定节点（节点太多时只列前 80 个，避免菜单卡顿）。 */
export function buildRouteOptions(status) {
  const options = [{ value: DIRECT_VALUE, label: '直连（不走 VPN）' }];
  const pools = Array.isArray(status?.routes?.pools) ? status.routes.pools : [];
  for (const pool of pools) {
    const port = status?.engine?.ports?.[`pool:${pool.id}`];
    options.push({
      value: `pool:${pool.id}`,
      label: `⚡ ${pool.name}${port ? ` · ${port}` : ' · 未分配端口'}`,
    });
  }
  const nodes = Array.isArray(status?.nodes) ? status.nodes : [];
  for (const item of nodes.slice(0, 80)) {
    options.push({ value: `node:${item.id}`, label: `${item.name}${item.region ? `（${item.region}）` : ''}` });
  }
  return options;
}

/**
 * @param {object} desktop `window.movaDesktop`
 * @returns {{
 *   status: object|null, providers: object[], loading: boolean, busy: string, error: string,
 *   bridgeMissing: boolean, readError: () => string,
 *   actions: Record<string, Function>
 * }}
 */
export function useVpn(desktop) {
  const bridge = desktop?.vpn;
  const [status, setStatus] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(Boolean(bridge));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  /**
   * 最近一次 `run()` 的失败原因。
   * 为什么要额外存一份：`error` 是 state，`await action()` 之后 React 还没重渲染，
   * 弹窗拿到的仍是上一次的闭包值；这里同步留一份，弹窗提交失败时立刻就能读到本次原因。
   */
  const lastError = useRef('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!bridge?.status) {
      setStatus(BRIDGE_MISSING);
      setLoading(false);
      return null;
    }
    try {
      const value = await bridge.status();
      const snapshot = unwrap(value);
      if (!alive.current) return null;
      setStatus(snapshot);
      setError('');
      return snapshot;
    } catch (failure) {
      if (alive.current) {
        setStatus(previous => previous ?? BRIDGE_MISSING);
        setError(failure?.message || '读取线路状态失败');
      }
      return null;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [bridge]);

  // 模型清单（第 3 段用）：只读 providers:list，拿不到就用内置订阅两行兜底。
  const loadProviders = useCallback(async () => {
    if (!desktop?.providers?.list) return;
    try {
      const value = unwrap(await desktop.providers.list());
      const rows = Array.isArray(value?.providers) ? value.providers : [];
      if (alive.current) setProviders(rows);
    } catch {
      if (alive.current) setProviders([]);
    }
  }, [desktop]);

  useEffect(() => {
    void refresh();
    void loadProviders();
  }, [refresh, loadProviders]);

  // 主进程推状态变化（内核启停、配置重载）后重读一次快照。
  useEffect(() => {
    if (!bridge?.onEvent) return undefined;
    const off = bridge.onEvent(() => { void refresh(); });
    return typeof off === 'function' ? off : undefined;
  }, [bridge, refresh]);

  /** 统一包一层：记录 busy、吞掉异常并写进 error（页面用一句中文说明，不抛给 React）。 */
  const run = useCallback(async (label, operation) => {
    if (!bridge) return null;
    setBusy(label);
    setError('');
    lastError.current = '';
    try {
      const value = await operation(bridge);
      return value;
    } catch (failure) {
      const message = failure?.message || '操作失败';
      lastError.current = message;
      if (alive.current) setError(message);
      return null;
    } finally {
      if (alive.current) setBusy('');
    }
  }, [bridge]);

  /** 读本次动作的失败原因（失败后立刻调用；成功或开始时是空串）。 */
  const readError = useCallback(() => lastError.current, []);

  /**
   * 导入结果 → 页面提示行文案。
   *
   * 全部导入成功时返回空串（成功提示由页面的 toast 负责）；只要有「跳过 / 降级」，
   * 就写进页面顶部那一行提示：`共 9 条，导入 7 条，跳过 2 条（不支持的协议：anytls ×2）`。
   * 这样「为什么少了两个节点」当场可见——本次真实订阅实测里，anytls 被静默丢掉正是最不能接受的点。
   */
  const importNoticeOf = useCallback(value => {
    const summary = summarizeImportResult(value);
    return summary.partial ? summary.text : '';
  }, []);

  const actions = useMemo(() => ({
    refresh,
    /**
     * 手动跑一轮线路巡检。内核没跑时主进程会回 `skipped`，这里把它翻译成一句可读提示，
     * 而不是假装「检查过了、一切正常」。
     */
    checkHealth: () => run('health', async api => {
      const bridge = api?.health;
      if (!bridge || typeof bridge.check !== 'function') throw new Error('当前版本不支持线路检查');
      const value = unwrap(await bridge.check());
      if (value?.skipped === 'core_not_running') throw new Error('内核没有运行，先启动内核再检查');
      if (value?.skipped === 'no_pool') throw new Error('还没有策略池，先建一个再检查');
      await refresh();
      return value;
    }),
    /** 逐个测试所有策略池里的全部节点（走 Mihomo Controller 的 delay 接口）。 */
    testDelays: () => run('delays', async api => {
      const value = unwrap(await api.testDelays({}));
      await refresh();
      return value;
    }),
    /** 「允许跨地区切换」开关：默认关。关着时同地区没有备选就不切换（账号风控优先）。 */
    setCrossRegion: allow => run('health', async api => {
      const bridge = api?.health;
      if (!bridge || typeof bridge.settings !== 'function') throw new Error('当前版本不支持这个开关');
      const value = unwrap(await bridge.settings({ allowCrossRegion: allow === true }));
      await refresh();
      return value;
    }),
    importClipboard: () => run('import', async api => {
      const value = unwrap(await api.importClipboard({}));
      const notice = importNoticeOf(value);
      if (notice && alive.current) setError(notice);
      await refresh();
      return value;
    }),
    importSubscription: input => run('import', async api => {
      const value = unwrap(await api.importSubscription(input));
      const notice = importNoticeOf(value);
      if (notice && alive.current) setError(notice);
      await refresh();
      return value;
    }),
    refreshSubscription: id => run('refresh', async api => {
      unwrap(await api.refreshSubscription({ id }));
      await refresh();
      return true;
    }),
    removeSubscription: id => run('remove', async api => {
      unwrap(await api.removeSubscription({ id }));
      await refresh();
      return true;
    }),
    scanFxy: () => run('scan', async api => unwrap(await api.scanFxy())),
    importFxy: profileId => run('import', async api => {
      const value = unwrap(await api.importFxy({ profileId }));
      await refresh();
      return value;
    }),
    savePool: input => run('pool', async api => {
      const value = unwrap(await api.pool.save(input));
      await refresh();
      return value;
    }),
    removePool: id => run('pool', async api => {
      unwrap(await api.pool.remove({ id }));
      await refresh();
      return true;
    }),
    selectPoolNode: (poolId, nodeId) => run('pool', async api => {
      unwrap(await api.pool.selectNode({ poolId, nodeId }));
      await refresh();
      return true;
    }),
    setProviderRoute: (providerId, value, failover) => run('routes', async api => {
      const target = parseRouteValue(value, { failover });
      unwrap(await api.setRoutes({ routes: { [providerId]: target } }));
      await refresh();
      return true;
    }),
    setModelRoute: (providerId, modelId, value, failover) => run('routes', async api => {
      // `inherit` = 删掉这条覆盖（主进程用 null 表达删除），而不是「覆盖成直连」。
      const target = value === 'inherit' ? null : parseRouteValue(value, { failover });
      unwrap(await api.setRoutes({ modelOverrides: { [`${providerId}/${modelId}`]: target } }));
      await refresh();
      return true;
    }),
    coreAction: action => run('core', async api => {
      const value = unwrap(await api.core.action({ action }));
      await refresh();
      return value;
    }),
    /**
     * 开机自启（`core.autoStart`）：只是把偏好写进路由表，不启动内核。
     * 真正的启动发生在下次软件启动时（主进程读这个字段）；当前这一次仍由用户点「启动内核」。
     * 不做成「点了立刻开」是有意的：那个动作已经有「启动内核」按钮，两个按钮做同一件事会让人以为没生效。
     */
    setCoreAutoStart: enabled => run('core', async api => {
      const target = enabled === true;
      unwrap(await api.setRoutes({ core: { autoStart: target } }));
      await refresh();
      return target;
    }),
    pickCorePath: () => run('core', async api => {
      const value = unwrap(await api.core.pickPath());
      await refresh();
      return value;
    }),
    downloadCore: () => run('core', async api => unwrap(await api.core.download())),
    probeModel: (providerId, modelId) => run('probe', async api => unwrap(await api.probeModel({ providerId, modelId }))),
  }), [run, refresh, importNoticeOf]);

  return {
    status,
    providers,
    loading,
    busy,
    error,
    bridgeMissing: !bridge,
    readError,
    actions,
  };
}
