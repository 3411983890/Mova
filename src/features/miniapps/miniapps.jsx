/**
 * 负责：实现 Bot 自研小程序的两个 UI 承载表面：
 *   1) `MiniAppsView`：左侧栏入口对应的“小程序聚合主页”和“主界面完整模式（Full Main View）”，
 *      包含搜索、按创建 Bot 筛选、置顶、重命名、权限与跨 Bot 共享（sharedWith）管理、JSON/CSV 导出、停用、卸载保留数据确认。
 *   2) `MiniAppSideDrawer`：聊天卡片点击子页面后在右侧直接滑开的运行抽屉。
 *   两者共用同一个严格沙箱化的 `<iframe sandbox="allow-scripts">` 执行器、postMessage RPC 桥和故障自愈 Error Boundary。
 * 不负责：后端持久化、manifest 校验或 PolicyGateway 权限裁决（由 electron/bots/mini-app-service.mjs 负责）。
 * 被谁调用：app.js。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowUpRight, Bin, Box, Check, FileText, Pause, Pen, Pin, Play, RefreshCw, Search, ShieldCheck, TriangleAlert, X,
} from '@keyline-icons/react';
import { BallAvatar } from '../bot/bot-conversation.jsx';
import './miniapps.css';

const SEEDED_FALLBACK_APPS = [
  {
    appId: 'app_trip_packer',
    name: '行前清单看板',
    description: '由策划专员按当前群聊出行规划自动生成，实时追踪证件、装备与预算条目。',
    version: '1.0.0',
    createdByBotId: 'planner',
    conversationId: 'group-team',
    pinned: true,
    disabled: false,
    lastOpenedAt: null,
    manifest: {
      appId: 'app_trip_packer',
      name: '行前清单看板',
      version: '1.0.0',
      createdByBotId: 'planner',
      routes: [
        { id: 'overview', title: '总览' },
        { id: 'checklist', title: '清单条目' },
        { id: 'budget', title: '预算' },
      ],
      permissions: ['storage', 'ui.toast'],
      sharedWith: ['mova', 'designer', 'developer'],
    },
  },
];

function buildFallbackAppHtml(app, routeId = 'overview') {
  const routes = app?.manifest?.routes || [{ id: 'overview', title: '总览' }];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body{font-family:"Microsoft YaHei UI",sans-serif;background:#1b1b1b;color:#eee;margin:0;padding:14px}
    .tabs{display:flex;gap:6px;margin:10px 0}.tab{padding:5px 10px;border-radius:7px;border:1px solid #393939;background:#262626;color:#ddd;cursor:pointer;font-size:12px}
    .tab.active{background:#3a78e0;color:#fff;border-color:transparent}
    .card{padding:12px;border:1px solid #333;border-radius:10px;background:#222;font-size:13px;line-height:1.6}
  </style></head><body>
    <strong>${String(app?.name || '小程序').replace(/</g, '&lt;')}</strong>
    <div class="tabs">${routes.map(r => `<button class="tab${r.id === routeId ? ' active' : ''}">${String(r.title).replace(/</g, '&lt;')}</button>`).join('')}</div>
    <div class="card">${String(app?.description || '预览模式运行中，支持与宿主安全通信。').replace(/</g, '&lt;')}</div>
  </body></html>`;
}

function downloadTextFile(filename, content, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function unwrapIpc(res) {
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) throw new Error(res.message || res.error || '操作失败');
    return res.value;
  }
  return res;
}

function normalizeExportPayload(res, app, format) {
  if (typeof res === 'string') return { filename: `${app?.name || app?.appId || 'miniapp'}.${format}`, content: res };
  if (res && typeof res.content === 'string') return { filename: res.filename || `${app?.name || app?.appId}.${format}`, content: res.content };
  return {
    filename: `${app?.name || app?.appId || 'miniapp'}.${format}`,
    content: format === 'csv' ? 'namespace,key,value_json\n' : JSON.stringify(res ?? {}, null, 2),
  };
}

function SandboxedMiniAppRunner({ app, route, onRouteChange, onAppUpdated, onNotify, onTriggerBotRepair }) {
  const iframeRef = useRef(null);
  const localKvRef = useRef(new Map());
  const [sandboxHtml, setSandboxHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(false);
  const [runtimeError, setRuntimeError] = useState(app?.lastError || null);

  const loadAppHtml = useCallback(async () => {
    if (!app) return;
    setLoading(true);
    try {
      if (window.movaDesktop?.miniApps?.open) {
        const opened = unwrapIpc(await window.movaDesktop.miniApps.open(app.appId, { route: route || 'overview', theme: 'dark' }));
        if (opened?.sandboxedHtml) {
          setSandboxHtml(opened.sandboxedHtml);
          setRuntimeError(opened.app?.lastError || null);
          if (opened.app && onAppUpdated) onAppUpdated(opened.app);
          return;
        }
      }
      setSandboxHtml(buildFallbackAppHtml(app, route));
      setRuntimeError(app.lastError || null);
    } catch (error) {
      setRuntimeError({ message: error?.message || '无法加载小程序沙箱内容', stack: '' });
    } finally {
      setLoading(false);
    }
  }, [app?.appId, app?.version, route]);

  useEffect(() => {
    loadAppHtml();
  }, [loadAppHtml]);

  useEffect(() => {
    if (!app) return undefined;
    async function onWindowMessage(event) {
      const win = iframeRef.current?.contentWindow;
      if (!win || event.source !== win) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.source === 'mova-miniapp-error') {
        const errObj = { message: msg.message || '小程序运行脚本发生异常', stack: msg.stack || '' };
        setRuntimeError(errObj);
        if (window.movaDesktop?.miniApps?.reportError) {
          window.movaDesktop.miniApps.reportError(app.appId, errObj).catch(() => {});
        }
        return;
      }

      if (msg.source !== 'mova-miniapp' || !msg.id) return;
      try {
        let result = null;
        if (msg.method === 'ui.toast') {
          onNotify?.(msg.params?.text || '', { tone: 'info' });
          result = { ok: true };
        } else if (msg.method === 'ui.navigate') {
          if (msg.params?.routeId) onRouteChange?.(msg.params.routeId);
          result = { ok: true, routeId: msg.params?.routeId };
        } else if (window.movaDesktop?.miniApps?.rpcCall) {
          result = unwrapIpc(await window.movaDesktop.miniApps.rpcCall(app.appId, { method: msg.method, params: msg.params || {} }));
        } else {
          // 离线无桌面桥时提供内存存储兜底
          if (msg.method === 'storage.set') {
            localKvRef.current.set(String(msg.params?.key), msg.params?.value);
            result = msg.params?.value;
          } else if (msg.method === 'storage.get') {
            result = localKvRef.current.get(String(msg.params?.key)) ?? null;
          } else if (msg.method === 'storage.list') {
            result = [...localKvRef.current.entries()].map(([key, value]) => ({ key, value }));
          }
        }
        win.postMessage({ source: 'mova-host', id: msg.id, result }, '*');
      } catch (err) {
        win.postMessage({ source: 'mova-host', id: msg.id, error: err?.message || 'RPC 执行失败' }, '*');
      }
    }
    window.addEventListener('message', onWindowMessage);
    return () => window.removeEventListener('message', onWindowMessage);
  }, [app?.appId, onNotify, onRouteChange]);

  async function handleExportRawData() {
    try {
      if (window.movaDesktop?.miniApps?.exportData) {
        const res = unwrapIpc(await window.movaDesktop.miniApps.exportData(app.appId, 'json'));
        const { filename, content } = normalizeExportPayload(res, app, 'json');
        downloadTextFile(filename, content, 'application/json;charset=utf-8');
        onNotify?.('已导出原始数据 JSON');
      } else {
        downloadTextFile(
          `${app.name || app.appId}-backup.json`,
          JSON.stringify([...localKvRef.current.entries()], null, 2),
          'application/json;charset=utf-8',
        );
      }
    } catch (err) {
      onNotify?.(err?.message || '导出失败', { tone: 'error' });
    }
  }

  async function handleRepair() {
    if (!app) return;
    setRepairing(true);
    try {
      if (window.movaDesktop?.miniApps?.requestRepair) {
        const updated = unwrapIpc(await window.movaDesktop.miniApps.requestRepair(app.appId));
        setRuntimeError(null);
        if (updated) onAppUpdated?.(updated);
        onTriggerBotRepair?.(app, updated);
        await loadAppHtml();
        onNotify?.(`已由创建 Bot 修复「${app.name}」并升级至 v${updated?.version || ''}`);
      } else {
        setRuntimeError(null);
        await loadAppHtml();
      }
    } catch (err) {
      onNotify?.(err?.message || '自动修复失败', { tone: 'error' });
    } finally {
      setRepairing(false);
    }
  }

  if (!app) return null;
  if (app.disabled) {
    return <div className="miniapp-error-boundary">
      <Pause size={24} />
      <h3>该小程序已停用</h3>
      <p>停用期间数据保留且禁止写入。你可以在管理卡片中随时重新启用。</p>
      <button type="button" className="miniapp-btn" onClick={handleExportRawData}><FileText size={14} />导出原始数据</button>
    </div>;
  }

  if (runtimeError) {
    return <div className="miniapp-error-boundary" role="alert">
      <TriangleAlert size={24} />
      <h3>小程序运行遇到异常</h3>
      <p>{runtimeError.message}</p>
      {runtimeError.stack ? <pre className="miniapp-error-stack">{runtimeError.stack.slice(0, 600)}</pre> : null}
      <div className="miniapp-error-actions">
        <button type="button" className="miniapp-btn miniapp-btn--primary" disabled={repairing} onClick={handleRepair}>
          <RefreshCw size={13} />{repairing ? '修复中...' : '让创建 Bot 修复'}
        </button>
        <button type="button" className="miniapp-btn" onClick={handleExportRawData}>
          <FileText size={13} />导出原始数据
        </button>
      </div>
    </div>;
  }

  return <div className="miniapp-runner">
    {loading ? <div className="miniapp-loading">正在启动隔离沙箱...</div> : null}
    <iframe
      ref={iframeRef}
      key={`${app.appId}:${app.version}:${route}`}
      className="miniapp-iframe"
      sandbox="allow-scripts"
      srcDoc={sandboxHtml}
      title={`${app.name} 小程序视图`}
    />
  </div>;
}

export function MiniAppSideDrawer({
  open, appId, route, bots = [], apps = [], onRouteChange, onOpenFullView, onClose, onAppsChanged, onNotify,
}) {
  const [localApp, setLocalApp] = useState(null);

  useEffect(() => {
    if (!open || !appId) { setLocalApp(null); return undefined; }
    let cancelled = false;
    async function load() {
      const fromList = apps.find(a => a.appId === appId) || SEEDED_FALLBACK_APPS.find(a => a.appId === appId);
      if (fromList && !cancelled) setLocalApp(fromList);
      if (window.movaDesktop?.miniApps?.get) {
        try {
          const fresh = unwrapIpc(await window.movaDesktop.miniApps.get(appId));
          if (fresh && !cancelled) setLocalApp(fresh);
        } catch { /* 保留本地列表对象 */ }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [open, appId, apps]);

  if (!open || !localApp) return null;
  const routes = localApp.manifest?.routes || [{ id: 'overview', title: '总览' }];
  const currentRoute = route || routes[0]?.id || 'overview';
  const creatorBot = bots.find(b => b.id === localApp.createdByBotId);

  return <div className="miniapp-drawer">
    <header className="miniapp-drawer-head">
      <div className="miniapp-drawer-title">
        <span className="miniapp-drawer-icon"><Box size={15} /></span>
        <div>
          <strong>{localApp.name}</strong>
          <small>v{localApp.version} · {creatorBot?.name || localApp.createdByBotId}</small>
        </div>
      </div>
      <div className="miniapp-drawer-actions">
        {onOpenFullView ? <button type="button" className="miniapp-icon-btn" title="在主界面中打开" aria-label="在主界面中打开" onClick={() => onOpenFullView(localApp.appId, currentRoute)}>
          <ArrowUpRight size={15} />
        </button> : null}
        <button type="button" className="miniapp-icon-btn" title="关闭侧边栏" aria-label="关闭侧边栏" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
    </header>

    {routes.length > 1 ? <div className="miniapp-route-tabs" role="tablist" aria-label="小程序子页面">
      {routes.map(r => <button
        key={r.id}
        type="button"
        role="tab"
        aria-selected={currentRoute === r.id}
        className={`miniapp-route-tab${currentRoute === r.id ? ' active' : ''}`}
        onClick={() => onRouteChange?.(r.id)}
      >{r.title}</button>)}
    </div> : null}

    <div className="miniapp-drawer-body">
      <SandboxedMiniAppRunner
        app={localApp}
        route={currentRoute}
        onRouteChange={onRouteChange}
        onAppUpdated={updated => {
          setLocalApp(updated);
          onAppsChanged?.();
        }}
        onNotify={onNotify}
      />
    </div>
  </div>;
}

export function MiniAppsView({
  active = true,
  bots = [],
  focusedAppId = null,
  focusedRoute = 'overview',
  onSelectApp,
  onOpenSideDrawer,
  onOpenConversation,
  onNotify,
}) {
  const [apps, setApps] = useState([]);
  const [query, setQuery] = useState('');
  const [creatorFilter, setCreatorFilter] = useState('all');
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [permApp, setPermApp] = useState(null);
  const [uninstallTarget, setUninstallTarget] = useState(null);
  const [retainDataBackup, setRetainDataBackup] = useState(true);
  const [activeRoute, setActiveRoute] = useState(focusedRoute || 'overview');

  const refreshApps = useCallback(async () => {
    if (window.movaDesktop?.miniApps?.list) {
      try {
        const list = unwrapIpc(await window.movaDesktop.miniApps.list());
        if (Array.isArray(list)) { setApps(list); return; }
      } catch { /* fallback below */ }
    }
    setApps(prev => (prev.length ? prev : SEEDED_FALLBACK_APPS));
  }, []);

  useEffect(() => {
    if (active) refreshApps();
  }, [active, refreshApps]);

  useEffect(() => {
    if (focusedRoute) setActiveRoute(focusedRoute);
  }, [focusedRoute]);

  const focusedApp = useMemo(
    () => (focusedAppId ? apps.find(a => a.appId === focusedAppId) || null : null),
    [apps, focusedAppId],
  );

  const creatorIds = useMemo(
    () => [...new Set(apps.map(a => a.createdByBotId).filter(Boolean))],
    [apps],
  );

  const visibleApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...apps]
      .filter(a => creatorFilter === 'all' || a.createdByBotId === creatorFilter)
      .filter(a => !q || `${a.name} ${a.description} ${a.appId}`.toLowerCase().includes(q))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [apps, creatorFilter, query]);

  async function handlePin(app) {
    if (window.movaDesktop?.miniApps?.togglePin) {
      await window.movaDesktop.miniApps.togglePin(app.appId, !app.pinned);
      await refreshApps();
    } else {
      setApps(prev => prev.map(item => (item.appId === app.appId ? { ...item, pinned: !item.pinned } : item)));
    }
  }

  async function handleToggleDisabled(app) {
    if (window.movaDesktop?.miniApps?.setDisabled) {
      await window.movaDesktop.miniApps.setDisabled(app.appId, !app.disabled);
      await refreshApps();
    } else {
      setApps(prev => prev.map(item => (item.appId === app.appId ? { ...item, disabled: !item.disabled } : item)));
    }
  }

  async function handleRenameSubmit(event, app) {
    event.preventDefault();
    const clean = renameDraft.trim();
    if (!clean) return;
    if (window.movaDesktop?.miniApps?.rename) {
      await window.movaDesktop.miniApps.rename(app.appId, clean);
      await refreshApps();
    } else {
      setApps(prev => prev.map(item => (item.appId === app.appId ? { ...item, name: clean } : item)));
    }
    setRenamingId(null);
  }

  async function handleExport(app, format = 'json') {
    try {
      if (window.movaDesktop?.miniApps?.exportData) {
        const res = unwrapIpc(await window.movaDesktop.miniApps.exportData(app.appId, format));
        const { filename, content } = normalizeExportPayload(res, app, format);
        downloadTextFile(filename, content, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
        onNotify?.(`已导出「${app.name}」数据 (${format.toUpperCase()})`);
      } else {
        downloadTextFile(`${app.name}.${format}`, format === 'csv' ? 'namespace,key,value_json\n' : '{}');
      }
    } catch (err) {
      onNotify?.(err?.message || '导出失败', { tone: 'error' });
    }
  }

  async function handleSavePermissions(appId, sharedWith) {
    if (window.movaDesktop?.miniApps?.updatePermissions) {
      await window.movaDesktop.miniApps.updatePermissions(appId, { sharedWith });
      await refreshApps();
    } else {
      setApps(prev => prev.map(item => (item.appId === appId ? { ...item, manifest: { ...item.manifest, sharedWith } } : item)));
    }
    setPermApp(null);
    onNotify?.('已更新跨 Bot 数据共享范围');
  }

  async function handleConfirmUninstall() {
    if (!uninstallTarget) return;
    const app = uninstallTarget;
    if (window.movaDesktop?.miniApps?.uninstall) {
      const res = unwrapIpc(await window.movaDesktop.miniApps.uninstall(app.appId, { retainDataBackup }));
      if (retainDataBackup && res?.backup) {
        const { filename, content } = normalizeExportPayload(res.backup, app, 'json');
        downloadTextFile(filename, content, 'application/json;charset=utf-8');
      }
      await refreshApps();
    } else {
      setApps(prev => prev.filter(item => item.appId !== app.appId));
    }
    if (focusedAppId === app.appId) onSelectApp?.(null);
    setUninstallTarget(null);
    onNotify?.(`已卸载「${app.name}」`);
  }

  if (focusedApp) {
    const routes = focusedApp.manifest?.routes || [{ id: 'overview', title: '总览' }];
    const currentRoute = routes.some(r => r.id === activeRoute) ? activeRoute : (routes[0]?.id || 'overview');
    const creatorBot = bots.find(b => b.id === focusedApp.createdByBotId);

    return <div className="miniapps-full">
      <header className="miniapps-full-head">
        <button type="button" className="miniapp-btn" onClick={() => onSelectApp?.(null)}>
          <ArrowLeft size={14} />全部小程序
        </button>
        <div className="miniapps-full-meta">
          <strong>{focusedApp.name}</strong>
          <span>v{focusedApp.version} · 创建者：{creatorBot?.name || focusedApp.createdByBotId}</span>
        </div>
        <div className="miniapps-full-tools">
          <button type="button" className="miniapp-btn" onClick={() => handleExport(focusedApp, 'json')}><FileText size={13} />导出 JSON</button>
          {onOpenSideDrawer ? <button type="button" className="miniapp-btn" onClick={() => onOpenSideDrawer(focusedApp.appId, currentRoute)}>在右侧打开</button> : null}
        </div>
      </header>
      <div className="miniapp-route-tabs miniapp-route-tabs--full" role="tablist">
        {routes.map(r => <button
          key={r.id}
          type="button"
          role="tab"
          aria-selected={currentRoute === r.id}
          className={`miniapp-route-tab${currentRoute === r.id ? ' active' : ''}`}
          onClick={() => setActiveRoute(r.id)}
        >{r.title}</button>)}
      </div>
      <div className="miniapps-full-body">
        <SandboxedMiniAppRunner
          app={focusedApp}
          route={currentRoute}
          onRouteChange={setActiveRoute}
          onAppUpdated={refreshApps}
          onNotify={onNotify}
        />
      </div>
    </div>;
  }

  return <div className="miniapps-page">
    <header className="miniapps-header">
      <div>
        <h1>小程序中心</h1>
        <p>查看与管理由 Bot 根据对话为你动态孵化与迭代的专属轻应用</p>
      </div>
      <div className="miniapps-toolbar">
        <label className="miniapps-search">
          <Search size={14} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索小程序名称或描述" aria-label="搜索小程序" />
          {query ? <button type="button" aria-label="清空" onClick={() => setQuery('')}><X size={12} /></button> : null}
        </label>
        <button type="button" className="miniapp-btn" onClick={refreshApps}><RefreshCw size={13} />刷新</button>
      </div>
    </header>

    <div className="miniapps-filter-row">
      <button type="button" className={`miniapp-filter-chip${creatorFilter === 'all' ? ' active' : ''}`} onClick={() => setCreatorFilter('all')}>全部 ({apps.length})</button>
      {creatorIds.map(botId => {
        const bot = bots.find(b => b.id === botId);
        return <button
          key={botId}
          type="button"
          className={`miniapp-filter-chip${creatorFilter === botId ? ' active' : ''}`}
          onClick={() => setCreatorFilter(botId)}
        >
          {bot ? <BallAvatar className="miniapp-creator-dot" {...bot.appearance} /> : null}
          <span>{bot?.name || botId}</span>
        </button>;
      })}
    </div>

    {visibleApps.length === 0 ? <div className="miniapps-empty">
      <Box size={28} />
      <strong>暂无符合条件的小程序</strong>
      <p>在任意私聊或群聊中让 Bot 为你生成一个专属工具、看板或清单，它会出现在这里。</p>
    </div> : <div className="miniapps-grid">
      {visibleApps.map(app => {
        const creator = bots.find(b => b.id === app.createdByBotId);
        const routes = (app.manifest?.routes || []).slice(0, 3);
        const sharedCount = (app.manifest?.sharedWith || []).length;
        return <article key={app.appId} className={`miniapp-card${app.disabled ? ' is-disabled' : ''}${app.pinned ? ' is-pinned' : ''}`}>
          <div className="miniapp-card-top">
            <div className="miniapp-card-title-row">
              <span className="miniapp-card-icon"><Box size={16} /></span>
              {renamingId === app.appId ? <form className="miniapp-rename-form" onSubmit={e => handleRenameSubmit(e, app)}>
                <input autoFocus value={renameDraft} onChange={e => setRenameDraft(e.target.value)} maxLength="32" />
                <button type="submit" aria-label="保存"><Check size={12} /></button>
                <button type="button" aria-label="取消" onClick={() => setRenamingId(null)}><X size={12} /></button>
              </form> : <>
                <strong>{app.name}</strong>
                <button type="button" className="miniapp-inline-edit" aria-label="重命名" onClick={() => { setRenamingId(app.appId); setRenameDraft(app.name); }}><Pen size={12} /></button>
              </>}
            </div>
            <div className="miniapp-card-badges">
              <span className="miniapp-badge">v{app.version}</span>
              {app.disabled ? <span className="miniapp-badge miniapp-badge--warn">已停用</span> : null}
              <button type="button" className={`miniapp-pin-btn${app.pinned ? ' is-on' : ''}`} title={app.pinned ? '取消置顶' : '置顶'} aria-pressed={Boolean(app.pinned)} onClick={() => handlePin(app)}>
                <Pin size={13} />
              </button>
            </div>
          </div>

          <p className="miniapp-card-desc">{app.description || '独立沙箱数据存储 · 支持实时迭代升级'}</p>

          <div className="miniapp-card-meta">
            <span>创建 Bot：{creator?.name || app.createdByBotId}</span>
            <span>跨 Bot 共享：{sharedCount} 个</span>
            {app.conversationId && onOpenConversation ? <button type="button" className="miniapp-link-btn" onClick={() => onOpenConversation(app.conversationId)}>来源会话</button> : null}
          </div>

          {routes.length > 0 ? <div className="miniapp-card-routes">
            {routes.map(r => <button
              key={r.id}
              type="button"
              className="miniapp-route-pill"
              onClick={() => {
                if (onOpenSideDrawer) onOpenSideDrawer(app.appId, r.id);
                else { setActiveRoute(r.id); onSelectApp?.(app.appId, r.id); }
              }}
            >{r.title}</button>)}
          </div> : null}

          <footer className="miniapp-card-actions">
            <button type="button" className="miniapp-btn miniapp-btn--primary" onClick={() => { setActiveRoute(routes[0]?.id || 'overview'); onSelectApp?.(app.appId, routes[0]?.id || 'overview'); }}>主界面打开</button>
            {onOpenSideDrawer ? <button type="button" className="miniapp-btn" onClick={() => onOpenSideDrawer(app.appId, routes[0]?.id || 'overview')}>右侧打开</button> : null}
            <button type="button" className="miniapp-btn" title="设置共享与权限" onClick={() => setPermApp(app)}><ShieldCheck size={13} /></button>
            <button type="button" className="miniapp-btn" title="导出 JSON 数据" onClick={() => handleExport(app, 'json')}>JSON</button>
            <button type="button" className="miniapp-btn" title="导出 CSV 数据" onClick={() => handleExport(app, 'csv')}>CSV</button>
            <button type="button" className="miniapp-btn" title={app.disabled ? '重新启用' : '停用'} onClick={() => handleToggleDisabled(app)}>
              {app.disabled ? <Play size={13} /> : <Pause size={13} />}
            </button>
            <button type="button" className="miniapp-btn miniapp-btn--danger" title="卸载小程序" onClick={() => { setRetainDataBackup(true); setUninstallTarget(app); }}><Bin size={13} /></button>
          </footer>
        </article>;
      })}
    </div>}

    {permApp ? <div className="miniapp-modal-backdrop" onClick={() => setPermApp(null)}>
      <div className="miniapp-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="小程序权限与共享设置">
        <div className="miniapp-modal-head">
          <h3>共享范围 · {permApp.name}</h3>
          <button type="button" onClick={() => setPermApp(null)}><X size={15} /></button>
        </div>
        <p className="miniapp-modal-note">只有下列被授权的 Bot 才可通过工具查询此小程序的数据；未授权 Bot 无法跨边界读取。</p>
        <div className="miniapp-perm-list">
          {bots.filter(b => b.id !== permApp.createdByBotId).map(bot => {
            const currentShared = permApp.manifest?.sharedWith || [];
            const checked = currentShared.includes(bot.id);
            return <label key={bot.id}>
              <input
                type="checkbox"
                checked={checked}
                onChange={e => {
                  const next = e.target.checked
                    ? [...new Set([...currentShared, bot.id])]
                    : currentShared.filter(id => id !== bot.id);
                  setPermApp({ ...permApp, manifest: { ...permApp.manifest, sharedWith: next } });
                }}
              />
              <span>{bot.name} ({bot.tag})</span>
            </label>;
          })}
        </div>
        <div className="miniapp-modal-actions">
          <button type="button" className="miniapp-btn" onClick={() => setPermApp(null)}>取消</button>
          <button type="button" className="miniapp-btn miniapp-btn--primary" onClick={() => handleSavePermissions(permApp.appId, permApp.manifest?.sharedWith || [])}>保存共享</button>
        </div>
      </div>
    </div> : null}

    {uninstallTarget ? <div className="miniapp-modal-backdrop" onClick={() => setUninstallTarget(null)}>
      <div className="miniapp-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="确认卸载小程序">
        <div className="miniapp-modal-head">
          <h3>卸载「{uninstallTarget.name}」？</h3>
          <button type="button" onClick={() => setUninstallTarget(null)}><X size={15} /></button>
        </div>
        <p className="miniapp-modal-note">卸载后会移除该小程序代码与快捷入口。你可以选择在卸载前保留/导出全部用户数据。</p>
        <label className="miniapp-checkbox-row">
          <input type="checkbox" checked={retainDataBackup} onChange={e => setRetainDataBackup(e.target.checked)} />
          <span>保留数据备份并导出 JSON 文件</span>
        </label>
        <div className="miniapp-modal-actions">
          <button type="button" className="miniapp-btn" onClick={() => setUninstallTarget(null)}>取消</button>
          <button type="button" className="miniapp-btn miniapp-btn--danger" onClick={handleConfirmUninstall}>确认卸载</button>
        </div>
      </div>
    </div> : null}
  </div>;
}
