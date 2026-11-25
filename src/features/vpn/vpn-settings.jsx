/**
 * 设置页 · 网络与线路（按模型分配 VPN）。
 *
 * 负责：自上而下三段的页面编排——① 分流引擎与线路导入 ② 策略池与全部线路
 * ③ AI 模型线路分配——以及三段里的弹窗状态（订阅导入、新建线路池、删除确认）。
 * 不负责：IPC 细节与动作重试（use-vpn.js）、样式（vpn-settings.css）、
 * 页头（外层 .settings-panel-head 提供）、主进程校验（electron/vpn/ipc.mjs）。
 *
 * 挂载方式（app.js 的 selectSettingsPage）：
 *   createRoot($('#settings-page-network')).render(<VpnSettings desktop={window.movaDesktop} />);
 *
 * 关键取向：本页**只做真能跑的事**。内核没装就明确说「未安装 + 怎么装」，
 * 不做假进度、不做自动下载、不做假测速（方案 §3 与实施报告「未实现」）。
 */
import React, { useMemo, useState } from 'react';
import { CmSelect, CmSwitch, CmToastStack, Icon, useToasts } from '../cli-models/cli-models-parts.jsx';
import { buildRouteOptions, routeValueOf, useVpn } from './use-vpn.js';
import { VpnHealthLine } from './vpn-health-line.jsx';
import './vpn-health-line.css';
import { PoolDialog, RemoveDialog, STRATEGY_OPTIONS, SubscriptionDialog } from './vpn-import-dialog.jsx';
import '../cli-models/cli-models-settings.css';
import './vpn-settings.css';

/** 内核状态 → 用户看得懂的一句话（信息 + 下一步）。 */
function kernelHeadline(core, listeners) {
  const state = core?.state ?? 'idle';
  const ports = listeners.map(item => item.port).filter(Boolean);
  if (state === 'running') {
    return {
      tone: 'ok',
      title: '独立分流内核运行中',
      detail: ports.length
        ? `已开启 ${ports.length} 个模型端口（${ports.join(' / ')}）`
        : '内核已运行，但还没有任何模型被分配到线路',
    };
  }
  if (state === 'starting') return { tone: 'idle', title: '内核启动中…', detail: '通常不到一秒' };
  if (state === 'stopping') return { tone: 'idle', title: '内核正在停止…', detail: '' };
  if (state === 'kernel_missing' || core?.kernelFound === false) {
    return {
      tone: 'warn',
      title: '未安装 Mihomo 内核 · 当前全部模型直连',
      detail: '装上内核后才能给不同模型分配独立出口；在此之前聊天完全不受影响。',
    };
  }
  if (state === 'start_failed') {
    return {
      tone: 'warn',
      title: '内核启动失败',
      detail: core?.lastError || '请检查配置与端口占用后重试。',
    };
  }
  if (state === 'stopped') return { tone: 'idle', title: '内核已停止', detail: '线路分配保留，启动内核后生效' };
  return { tone: 'idle', title: '内核未启动', detail: '点「启动内核」后按下方分配生效' };
}

/** 策略池的类型显示名（选项表在弹窗文件里，这里只做取值，避免两份定义）。 */
function strategyLabel(value) {
  return STRATEGY_OPTIONS.find(item => item.value === value)?.label ?? value;
}

export function VpnSettings({ desktop }) {
  const { status, providers, loading, busy, error, bridgeMissing, readError, actions } = useVpn(desktop);
  const { items: toasts, push: toast, dismiss } = useToasts();
  const [subscriptionDraft, setSubscriptionDraft] = useState(null);
  const [poolDraft, setPoolDraft] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [expandedProvider, setExpandedProvider] = useState('');
  /**
   * 三个弹窗各自的「本次提交失败原因」。
   * 页级 `error` 渲染在页首，弹窗是 showModal + ::backdrop，横幅被完全遮住——
   * 所以弹窗内的动作失败必须落在弹窗自己身上，否则点保存等于什么都没发生。
   */
  const [subscriptionError, setSubscriptionError] = useState('');
  const [poolError, setPoolError] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [installHintOpen, setInstallHintOpen] = useState(false);

  const core = status?.core ?? {};
  const engine = status?.engine ?? { listeners: [], ports: {}, unassigned: [] };
  const health = status?.health ?? null;
  const listeners = Array.isArray(engine.listeners) ? engine.listeners : [];
  const pools = Array.isArray(status?.routes?.pools) ? status.routes.pools : [];
  const providerRoutes = status?.routes?.routes ?? {};
  const modelOverrides = status?.routes?.modelOverrides ?? {};
  const nodes = Array.isArray(status?.nodes) ? status.nodes : [];
  const subscriptions = Array.isArray(status?.subscriptions) ? status.subscriptions : [];
  const options = useMemo(() => buildRouteOptions(status), [status]);
  const headline = kernelHeadline(core, listeners);
  const running = core.running === true;
  // `core.autoStart` 来自路由表的 core 段（主进程 status 会展开它）。缺字段按开启处理，
  // 与 store 的默认值（autoStart !== false）保持一致，避免旧配置被显示成「关」。
  const autoStart = core.autoStart !== false;
  const nodeNameOf = id => nodes.find(item => item.id === id)?.name ?? '';

  /** 跑一个动作并在结束后弹一句结果（失败时用 hook 给的 error 行内展示，不重复弹）。 */
  async function perform(promise, successText) {
    const value = await promise;
    if (value !== null && value !== undefined && successText) toast(successText, 'ok');
    return value;
  }

  /** 弹窗里的动作失败：把本次原因写进这个弹窗，弹窗保持打开让用户改完再试。 */
  function failInto(setter) {
    setter(readError() || '操作失败，请稍后重试。');
  }

  // 主进程没装配 vpn:* IPC：只渲染这一条横幅。三段里的按钮全都点不动（run() 直接
  // return null），渲染出来只会是永远无效的「启动内核」，所以一个都不给。
  if (bridgeMissing) {
    return (
      <div className="vpn-page" data-source="unavailable">
        <section className="settings-section">
          <h3 className="settings-section-title">线路通道不可用</h3>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>主进程未提供线路通道</strong>
                <p>当前窗口没有装配 <code>vpn:*</code> IPC（可能是主进程里 VPN 模块加载失败）。所有模型保持直连，聊天不受影响；刷新页面后仍这样，请重装或更新 Mova。</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  // 首屏还没有 status：只渲染加载态。否则「正在读取线路状态…」会和
  // 「还没有导入任何线路来源」「还没有策略池」两处空态同屏，读屏会连读三件事。
  if (loading && !status) {
    return (
      <div className="vpn-page" data-source="live">
        <section className="settings-section">
          <div className="settings-card">
            <div className="vpn-loading" role="status">正在读取线路状态…</div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="vpn-page" data-source="live">
      {error ? (
        <section className="settings-section">
          <div className="vpn-error" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        </section>
      ) : null}

      {/* ── ① 分流引擎与线路导入 ───────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section-title">分流引擎与线路导入</h3>
        <div className="settings-card vpn-engine-card">
          <div className={`vpn-engine-head vpn-engine-${headline.tone}`}>
            <div className="vpn-engine-text">
              <strong><span className="vpn-dot" aria-hidden="true" />{headline.title}</strong>
              {headline.detail ? <p>{headline.detail}</p> : null}
            </div>
            <div className="vpn-engine-actions">
              {/* 开机自启放在最左边（用户要求的位置）：它描述的是「以后每次启动怎么办」，
                  而不是这次开不开，所以和右边两个即时动作分开读。 */}
              <button
                type="button"
                className={`settings-button vpn-autostart${autoStart ? ' is-on' : ''}`}
                role="switch"
                aria-checked={autoStart}
                aria-label={`开机自启内核（当前${autoStart ? '已开启' : '已关闭'}）`}
                title="开启后，每次启动 Mova 都会自动启动内核；关闭时仍可手动点「启动内核」"
                disabled={Boolean(busy)}
                onClick={() => perform(actions.setCoreAutoStart(!autoStart), autoStart ? '已关闭开机自启' : '已开启开机自启')}
              >
                开机自启：{autoStart ? '开' : '关'}
              </button>
              <button
                type="button"
                className="settings-button"
                disabled={Boolean(busy)}
                onClick={() => perform(actions.coreAction(running ? 'stop' : 'start'), running ? '内核已停止' : '内核已启动')}
              >
                {running ? '停止内核' : '启动内核'}
              </button>
              <button
                type="button"
                className="settings-button"
                disabled={Boolean(busy)}
                onClick={() => perform(actions.pickCorePath(), '已更新内核路径')}
              >
                选择内核
              </button>
              {/* 本版本不含内核自动下载（离线构建，ipc.mjs 里 core:download 无条件抛
                  core_download_failed）：这里直接把已有的安装指引展开，不再调用不可用的 IPC。 */}
              {core.installHint ? (
                <button
                  type="button"
                  className="settings-button"
                  aria-expanded={installHintOpen}
                  onClick={() => setInstallHintOpen(previous => !previous)}
                >
                  {installHintOpen ? '收起内核安装说明' : '内核安装说明'}
                </button>
              ) : null}
            </div>
          </div>

          {installHintOpen && core.installHint ? (
            <div className="vpn-hint">
              <strong>内核安装指引</strong>
              <pre>{core.installHint}</pre>
              {Array.isArray(core.candidates) && core.candidates.length ? (
                <p className="vpn-hint-paths">已检查：{core.candidates.join(' · ')}</p>
              ) : null}
            </div>
          ) : null}

          <div className="vpn-import-row">
            <button
              type="button"
              className="settings-button primary"
              disabled={Boolean(busy)}
              onClick={() => perform(actions.importClipboard(), '已解析剪贴板内容')}
            >
              剪贴板一键导入
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={Boolean(busy)}
              onClick={() => {
                setSubscriptionError('');
                setSubscriptionDraft({ url: '', name: '' });
              }}
            >
              导入订阅链接…
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={Boolean(busy)}
              onClick={async () => {
                const scanned = await actions.scanFxy();
                if (!scanned) return;
                if (!scanned.found) {
                  toast('未在本机发现 Fxy 配置目录', 'default');
                  return;
                }
                const imported = await perform(actions.importFxy(''), null);
                if (imported) toast(`已从 Fxy 导入 ${imported.nodesAdded} 个节点`, 'ok');
              }}
            >
              读取本机 Fxy 配置
            </button>
          </div>

          <div className="vpn-source-list">
            {subscriptions.length === 0 ? (
              <p className="vpn-empty">还没有导入任何线路来源。支持订阅链接、Clash/Mihomo YAML、Base64 节点列表与 vless/mieru 等分享链接。</p>
            ) : subscriptions.map(item => (
              <div className="vpn-source-row" key={item.id}>
                <div className="vpn-source-text">
                  <strong>{item.name}</strong>
                  <span>{item.kind === 'fxy' ? 'Fxy 配置' : item.kind === 'subscription' ? item.urlHint : '剪贴板线路'} · {item.nodeCount} 个节点</span>
                </div>
                <div className="vpn-source-actions">
                  {item.kind === 'subscription' ? (
                    <button
                      type="button"
                      className="settings-button"
                      disabled={Boolean(busy)}
                      onClick={() => perform(actions.refreshSubscription(item.id), '订阅已刷新')}
                    >
                      <Icon name="refresh" /> 刷新
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="settings-button danger"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setRemoveError('');
                      setRemoving({ kind: 'source', id: item.id, name: item.name });
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── ② 自动切换池 & 全部线路 ─────────────────────────────────── */}
      <section className="settings-section">
        {/* 段标题与它的动作同排：规范允许「标题行右侧放操作」，比把按钮塞进卡片底部更好找。 */}
        <div className="settings-section-head">
          <h3 className="settings-section-title">自动切换池与全部线路</h3>
          <div className="vpn-section-actions">
            <button
              type="button"
              className="settings-button"
              disabled={Boolean(busy) || !core.running || nodes.length === 0}
              title={core.running ? '逐个测试每个策略池里的全部节点' : '先启动内核才能测速'}
              onClick={async () => {
                const value = await actions.testDelays();
                if (!value) { if (readError()) toast(readError(), 'error'); return; }
                toast(
                  value.working
                    ? `测速完成：${value.working}/${value.total} 个节点可用`
                    : `测速完成：${value.total} 个节点全部不可用`,
                  value.working ? 'ok' : 'error',
                );
              }}
            >
              {busy === 'delays' ? '测速中…' : '测速'}
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={Boolean(busy) || nodes.length === 0}
              title={nodes.length === 0 ? '先导入线路来源' : '新建线路池'}
              onClick={() => {
                setPoolError('');
                setPoolDraft({ id: '', name: '', strategy: 'url-test', nodeIds: [] });
              }}
            >
              <Icon name="plus" /> 新建线路池
            </button>
          </div>
        </div>
        <div className="settings-card">
          <div className="vpn-pool-list">
            {pools.length === 0 ? (
              <p className="vpn-empty">还没有策略池。策略池 = 一组节点 + 一个自动切换策略，每个池独占一个本地端口。</p>
            ) : pools.map(pool => {
              const port = engine.ports?.[`pool:${pool.id}`];
              const current = pool.selectedNodeId ? nodeNameOf(pool.selectedNodeId) : nodeNameOf(pool.nodeIds?.[0]);
              return (
                <div className="vpn-pool-block" key={pool.id}>
                  <div className="vpn-pool-row">
                    <div className="vpn-pool-text">
                      <strong>{pool.name}</strong>
                      <span>
                        {strategyLabel(pool.strategy)} · {port ? `端口 ${port}` : '未分配端口'}
                        {current ? ` · 当前 ${current}` : ''}
                      </span>
                    </div>
                    <div className="vpn-pool-actions">
                      <button
                        type="button"
                        className="settings-button"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setPoolError('');
                          setPoolDraft({
                            id: pool.id,
                            name: pool.name,
                            strategy: pool.strategy,
                            nodeIds: [...(pool.nodeIds ?? [])],
                          });
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="settings-button danger"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setRemoveError('');
                          setRemoving({ kind: 'pool', id: pool.id, name: pool.name });
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {/* 健康状态：这个池现在用哪个节点、多快、多久前查过、有没有被切换过。
                      数据来自 runtime 的 healthSnapshot()（status.health.pools[poolId]）。 */}
                  <VpnHealthLine
                    health={health?.pools?.[pool.id] ?? null}
                    allowCrossRegion={health?.allowCrossRegion === true}
                    busy={busy === 'health'}
                    disabled={Boolean(busy) && busy !== 'health'}
                    onCheck={async () => {
                      const value = await actions.checkHealth();
                      if (!value && readError()) toast(readError(), 'error');
                    }}
                    onToggleCrossRegion={async allow => {
                      const value = await actions.setCrossRegion(allow);
                      if (!value && readError()) toast(readError(), 'error');
                    }}
                  />
                </div>
              );
            })}
          </div>
          {nodes.length === 0 ? (
            <div className="vpn-import-row">
              <span className="vpn-inline-note">先导入线路来源，才能建池</span>
            </div>
          ) : null}

          {nodes.length === 0 ? (
            <div className="vpn-node-empty">
              <p>还没有线路。先导入订阅或剪贴板，节点会出现在这里</p>
            </div>
          ) : (
            <div className="vpn-node-grid">
              {nodes.map(item => (
                <div className="vpn-node-card" key={item.id}>
                  <div className="vpn-node-head">
                    <strong title={item.name}>{item.name}</strong>
                    <span className="vpn-node-type">{item.type}</span>
                  </div>
                  <div className="vpn-node-meta">
                    <span>{item.serverHint}</span>
                    <span data-tone="untested">未测速</span>
                  </div>
                  <div className="vpn-node-tags">
                    {item.region ? <span className="vpn-tag">{item.region}</span> : null}
                    {(item.tags ?? []).map(tag => <span className="vpn-tag" key={tag}>{tag}</span>)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── ③ AI 模型线路分配 ──────────────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section-title">AI 模型线路分配</h3>
        <div className="settings-card">
          {providers.length === 0 ? (
            <p className="vpn-empty">读不到模型目录（providers:list 未返回数据）。线路分配仍然生效，等模型目录可用后这里会列出 Provider。</p>
          ) : providers.map(provider => {
            const target = providerRoutes[provider.id];
            const failover = target?.failover !== false;
            const expanded = expandedProvider === provider.id;
            const models = Array.isArray(provider.models) ? provider.models : [];
            return (
              <div className="vpn-provider-block" key={provider.id}>
                <div className="vpn-provider-row">
                  <div className="vpn-provider-text">
                    <strong>{provider.name || provider.id}</strong>
                    <span>{provider.kind === 'subscription' ? '订阅通道' : '自定义 Provider'}</span>
                  </div>
                  <div className="vpn-provider-controls">
                    <CmSelect
                      ariaLabel={`${provider.name || provider.id} 的线路`}
                      value={routeValueOf(target)}
                      options={options}
                      disabled={Boolean(busy) || (options.length <= 1)}
                      onChange={value => perform(actions.setProviderRoute(provider.id, value, failover), '已更新线路分配')}
                    />
                    <span className="vpn-switch-label">自动切线</span>
                    <CmSwitch
                      label={`${provider.name || provider.id} 自动切线`}
                      checked={failover}
                      disabled={Boolean(busy)}
                      onChange={next => perform(actions.setProviderRoute(provider.id, routeValueOf(target), next), '已更新自动切线')}
                    />
                    <button
                      type="button"
                      className="settings-button"
                      disabled={Boolean(busy)}
                      onClick={async () => {
                        const result = await actions.probeModel(provider.id, '');
                        // 只解析到端口 = 已经走线路（ok）；配了线路但回落直连 = 失败（error）；
                        // 本来就是直连 = 一句提示（default）。CmToastStack 只有 ok/error 两档，
                        // 以前传 'warn' 会静默退化成中性。
                        if (result) {
                          toast(
                            result.detail || '已检查',
                            result.viaProxy ? 'ok' : (result.degraded ? 'error' : 'default'),
                          );
                        }
                      }}
                    >
                      连通测试
                    </button>
                    {models.length ? (
                      <button type="button" className="settings-button" onClick={() => setExpandedProvider(expanded ? '' : provider.id)}>
                        {expanded ? '收起模型' : `单模型覆盖（${models.length}）`}
                      </button>
                    ) : null}
                  </div>
                </div>
                {expanded ? (
                  <div className="vpn-model-list">
                    {models.map(model => {
                      const key = `${provider.id}/${model.id}`;
                      const override = modelOverrides[key];
                      return (
                        <div className="vpn-model-row" key={key}>
                          <span className="vpn-model-name" title={model.id}>{model.name || model.id}</span>
                          <CmSelect
                            ariaLabel={`${model.name || model.id} 的线路`}
                            value={override ? routeValueOf(override) : 'inherit'}
                            options={[{ value: 'inherit', label: '继承 Provider' }, ...options]}
                            disabled={Boolean(busy)}
                            onChange={value => perform(actions.setModelRoute(provider.id, model.id, value, override?.failover !== false), '已更新单模型线路')}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 弹窗与提示 ────────────────────────────────────────────── */}
      <SubscriptionDialog
        draft={subscriptionDraft}
        busy={Boolean(busy)}
        error={subscriptionError}
        onChange={next => {
          setSubscriptionError('');
          setSubscriptionDraft(next);
        }}
        onCancel={() => {
          setSubscriptionError('');
          setSubscriptionDraft(null);
        }}
        onSubmit={async () => {
          const draft = subscriptionDraft;
          if (!draft) return;
          setSubscriptionError('');
          const result = await actions.importSubscription({ url: draft.url.trim(), name: draft.name.trim() });
          if (result) {
            setSubscriptionDraft(null);
            toast(`已导入 ${result.nodeCount} 个节点`, 'ok');
          } else {
            // 失败原因必须留在弹窗里：弹窗保持打开，用户改完链接可以直接再点「导入」。
            failInto(setSubscriptionError);
          }
        }}
      />

      <PoolDialog
        draft={poolDraft}
        nodes={nodes}
        busy={Boolean(busy)}
        error={poolError}
        onChange={next => {
          setPoolError('');
          setPoolDraft(next);
        }}
        onCancel={() => {
          setPoolError('');
          setPoolDraft(null);
        }}
        onSubmit={async () => {
          const draft = poolDraft;
          if (!draft) return;
          setPoolError('');
          const result = await actions.savePool({
            id: draft.id || undefined,
            name: draft.name.trim(),
            strategy: draft.strategy,
            nodeIds: draft.nodeIds,
          });
          if (result) {
            setPoolDraft(null);
            toast('线路池已保存', 'ok');
          } else {
            failInto(setPoolError);
          }
        }}
      />

      <RemoveDialog
        target={removing}
        busy={Boolean(busy)}
        error={removeError}
        onCancel={() => {
          setRemoveError('');
          setRemoving(null);
        }}
        onConfirm={async () => {
          const target = removing;
          if (!target) return;
          setRemoveError('');
          const done = target.kind === 'pool'
            ? await perform(actions.removePool(target.id), '线路池已删除')
            : await perform(actions.removeSubscription(target.id), '线路来源已删除');
          if (done !== null) {
            setRemoving(null);
          } else {
            failInto(setRemoveError);
          }
        }}
      />

      <CmToastStack items={toasts} onDismiss={dismiss} />
    </div>
  );
}
