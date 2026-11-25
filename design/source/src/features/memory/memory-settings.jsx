import React, { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, Pin, Search } from '@keyline-icons/react';
import { SettingsDialog } from './settings-dialog.jsx';
import { notify } from '../ui/toast.js';
import { PrivacyVaultPanel, ServicePanel } from './server-and-vault.jsx';
import './memory-settings.css';

const EMPTY = { memories: [], sessions: [], tasks: [], checkpoints: [], events: [], settings: {} };
const count = value => Array.isArray(value) ? value.length : Object.keys(value || {}).length;
const list = value => Array.isArray(value) ? value : Object.values(value || {});
const ERROR_LABELS = { 'invalid-input': '输入无效，请检查内容和数值范围。', 'invalid-settings': '设置无效，请检查数值范围。', 'sensitive-content': '内容疑似包含密码或密钥，仓库拒绝保存。请移除敏感信息。', 'memory-limit': '记忆数量已达到仓库上限，请删除不再需要的记忆。', 'storage-error': '本地存储失败，请检查磁盘空间和文件权限。', 'corrupt-store': '本地仓库无法读取或文件已损坏，请先保留原文件。', 'not-found': '该记忆已不存在，请重新读取。', 'key-conflict': '已有同类生效记忆，请先停用冲突项。', 'invalid-status': '此记忆当前状态不允许该操作。' };
const errorText = error => { const message = typeof error === 'string' ? error : error?.message; return ERROR_LABELS[message] || message || '操作失败，请重试。'; };
const statusNames = { active: '生效', disabled: '已停用', superseded: '已被替代' };
const kindNames = { fact: '项目事实', preference: '用户偏好', decision: '项目决定', note: '备注', convention: '约定', task: '任务' };
const KIND_OPTIONS = [{ value: 'fact', label: '项目事实' }, { value: 'preference', label: '用户偏好' }, { value: 'decision', label: '项目决定' }, { value: 'note', label: '备注' }];

// 浏览器预览（无桌面端本地仓库）时用于演示的示例数据，全部为虚构内容。
const DEMO = {
  ...EMPTY,
  settings: { memoryEnabled: true, autoExtract: true, includeGlobal: true, contextMaxMemories: 12, contextMaxChars: 6000, maxMemories: 2000 },
  storage: { filePath: 'C:\\Users\\示例用户\\AppData\\Roaming\\Mova\\memory\\store.json' },
  memories: [
    { id: 'demo-1', projectId: null, text: '这个项目统一使用中文说明，提交前先运行 npm.cmd run build 与 typecheck。', status: 'active', kind: 'convention', version: 3, pinned: true, updatedAt: '2026-11-10 18:20', sources: [{ conversationId: 'demo', messageId: 'm1' }, { conversationId: 'demo', messageId: 'm2' }] },
    { id: 'demo-2', projectId: null, text: '设置页的内容列与聊天一致：最宽 718px 居中，行内说明在 66% 处换行。', status: 'active', kind: 'convention', version: 1, pinned: false, updatedAt: '2026-11-09 21:04', sources: [] },
    { id: 'demo-3', projectId: null, text: '偏好：回复先给结论，再给要点；不要使用绿色作为界面背景。', status: 'active', kind: 'preference', version: 2, pinned: false, updatedAt: '2026-11-08 14:32' },
    { id: 'demo-4', projectId: null, text: '旧的构建方式：直接改根目录 app.js（已废弃，构建会覆盖）。', status: 'disabled', kind: 'fact', version: 1, pinned: false, updatedAt: '2026-10-30 09:10' },
    { id: 'demo-5', projectId: null, text: '设计稿的背景只用 #181818 / #161616 两档，强调色统一为蓝色。', status: 'superseded', kind: 'fact', version: 1, pinned: false, updatedAt: '2026-10-21 11:45' },
  ],
};

async function invoke(bridge, method, ...args) {
  if (typeof bridge?.[method] !== 'function') throw new Error('当前环境未提供本地记忆接口，请在 Mova 桌面端使用。');
  const result = await bridge[method](...args);
  if (!result?.ok) throw new Error(errorText(result?.error));
  return result.value;
}

// Backups never include credential fields, even if a future repository adds them.
function safeBackup(value) {
  if (Array.isArray(value)) return value.map(safeBackup);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential/i.test(key) ? '[已隐藏敏感凭据]' : safeBackup(entry)]));
  if (typeof value === 'string') return value
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏 API 密钥]')
    .replace(/\b(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[已隐藏 API 密钥]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏私钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|password|secret)\s*[=:：]\s*["']?)[^\s"',;，；]+/gi, '$1[已隐藏]');
  return value;
}

function SourceLinks({ item, onOpenSource, disabled, onError }) {
  const sources = item.sources?.length ? item.sources : item.conversationId ? [item] : [];
  if (!sources.length) return null;
  const visible = sources.slice(0, 2);
  return <div className="memory-actions">
    {visible.map((source, index) => <button type="button" className="settings-button" key={`${source.conversationId}-${source.messageId}-${index}`} disabled={disabled || !onOpenSource || !source.conversationId} onClick={async () => {
      try { await onOpenSource(source); } catch (error) { onError(errorText(error)); }
    }}>查看来源{sources.length > 1 ? ` ${index + 1}` : ''}</button>)}
    {sources.length > 2 && <span className="memory-count">+{sources.length - 2}</span>}
  </div>;
}

export function MemorySettings({ bridge, projectId, onOpenSource, onChanged }) {
  const uid = useId();
  const available = ['read', 'search', 'save', 'update', 'delete', 'settings', 'export', 'clear'].every(method => typeof bridge?.[method] === 'function');
  const demo = !available;
  const [data, setData] = useState(demo ? DEMO : EMPTY);
  const [loaded, setLoaded] = useState(demo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setNotice = message => { if (message) notify(message); };
  const [scope, setScope] = useState(projectId ? 'project' : 'global');
  const [query, setQuery] = useState('');
  const [searchGlobal, setSearchGlobal] = useState(true);
  const [hits, setHits] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [draft, setDraft] = useState('');
  const [addScope, setAddScope] = useState(projectId ? 'project' : 'global');
  const [addKind, setAddKind] = useState('fact');
  const [editText, setEditText] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [menuFor, setMenuFor] = useState(null);
  const [menuFlip, setMenuFlip] = useState(false);
  const [contextLimit, setContextLimit] = useState('');
  const [contextChars, setContextChars] = useState('');
  const [memoryLimit, setMemoryLimit] = useState('');
  const currentProjectRef = useRef(projectId);
  currentProjectRef.current = projectId;
  const generation = useRef(0);
  const operationLock = useRef(false);

  useEffect(() => {
    if (demo) { setData(DEMO); setLoaded(true); return; }
    const current = ++generation.current;
    setLoaded(false); setError(''); setHits(null); setDialog(null);
    if (!available) return;
    invoke(bridge, 'read').then(value => {
      if (generation.current !== current) return;
      setData({ ...EMPTY, ...value }); setLoaded(true);
    }).catch(reason => { if (generation.current === current) setError(errorText(reason)); });
    return () => { generation.current++; };
  }, [bridge, available, demo]);

  useEffect(() => { setHits(null); setScope(projectId ? 'project' : 'global'); setAddScope(projectId ? 'project' : 'global'); setMenuFor(null); }, [projectId]);
  useEffect(() => { setContextLimit(String(data.settings?.contextMaxMemories ?? 12)); }, [data.settings?.contextMaxMemories]);
  useEffect(() => { setContextChars(String(data.settings?.contextMaxChars ?? 6000)); }, [data.settings?.contextMaxChars]);
  useEffect(() => { setMemoryLimit(String(data.settings?.maxMemories ?? 2000)); }, [data.settings?.maxMemories]);
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

  async function run(operation, { change, message, refresh = true } = {}) {
    if (operationLock.current) return;
    operationLock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (change && onChanged) {
        try { await onChanged(change); } catch (reason) { setError(`本地操作已完成，但刷新应用失败：${errorText(reason)}`); }
      }
      if (refresh) { const next = await invoke(bridge, 'read'); setData({ ...EMPTY, ...next }); setLoaded(true); }
      if (message) setNotice(message);
      return result;
    } catch (reason) { setError(errorText(reason)); }
    finally { operationLock.current = false; setBusy(false); }
  }

  const disabled = demo || !loaded || busy;
  const settings = data.settings || {};
  const all = list(data.memories);
  const memories = all.filter(item => scope === 'global' ? item.projectId == null : item.projectId === projectId);
  const searchable = hits ?? memories;
  let bytes = 0;
  try { bytes = new Blob([JSON.stringify(data)]).size; } catch { /* Read data is normally JSON. */ }

  const updateSetting = (key, value) => run(() => invoke(bridge, 'settings', { [key]: value }), { change: { target: 'settings' }, message: '记忆设置已保存。' });
  const openDialog = (type, payload = {}) => { setMenuFor(null); setConfirmText(''); setError(''); setDialog({ type, ...payload }); };
  const closeDialog = () => { setDialog(null); setConfirmText(''); };
  const confirmWord = dialog?.type === 'confirm-memories' ? '清空记忆' : '清空历史';

  function toggle(key, title, description, fallback) {
    return <div className="settings-row"><div className="settings-row-text"><strong>{title}</strong><p>{description}</p></div>
      <button type="button" className="settings-switch" role="switch" aria-label={title} aria-checked={settings[key] ?? fallback} disabled={disabled} onClick={() => updateSetting(key, !(settings[key] ?? fallback))}><span /></button></div>;
  }

  function numberRow({ key, title, description, value, onChange, min, max, id }) {
    return <form className="settings-row" onSubmit={event => {
      event.preventDefault();
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) { setError(`「${title}」必须是 ${min}–${max} 的整数。`); return; }
      updateSetting(key, parsed);
    }}>
      <div className="settings-row-text"><strong><label htmlFor={id}>{title}</label></strong><p>{description}</p></div>
      <div className="memory-actions">
        <input id={id} className="memory-number" type="number" inputMode="numeric" min={min} max={max} step="1" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} required />
        <button type="submit" className="settings-button" disabled={disabled}>保存</button>
      </div>
    </form>;
  }

  async function exportBackup() {
    const payload = await invoke(bridge, 'export');
    const json = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const blob = new Blob([JSON.stringify(safeBackup(json), null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `Mova-memory-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function submitSearch(event) {
    event?.preventDefault();
    if (!query.trim()) return;
    if (demo) {
      const need = query.trim();
      setHits(DEMO.memories.filter(item => item.text.includes(need)));
      return;
    }
    const currentProject = projectId; const currentQuery = query;
    run(async () => {
      const result = await invoke(bridge, 'search', { query: currentQuery.trim(), projectId: currentProject || null, includeGlobal: searchGlobal || !currentProject, limit: 50 });
      if (currentProjectRef.current !== currentProject) return;
      setHits(list(result).filter(hit => currentProject ? hit.projectId === currentProject || (searchGlobal && hit.projectId == null) : hit.projectId == null));
    }, { refresh: false });
  }

  function statusBadge(item) {
    return <span className="memory-status" data-state={item.status || 'active'}>{statusNames[item.status] || item.status || '生效'}</span>;
  }

  function memoryRow(item) {
    return <div className="memory-item" key={item.id}>
      <button type="button" className="memory-item-main" onClick={() => openDialog('detail', { item })} aria-label={`查看记忆：${item.text?.slice(0, 40) ?? ''}`}>
        <span className="memory-item-title">{item.text || '（空内容）'}</span>
        <span className="memory-item-meta">
          {statusBadge(item)}
          <span>{kindNames[item.kind] || item.kind || '记忆'}</span>
          {item.version != null && <span>v{item.version}</span>}
          {item.projectId == null && <span>全局</span>}
          {item.pinned && <span>已置顶</span>}
        </span>
      </button>
      <div className="memory-item-actions">
        <button type="button" className="memory-icon-button" aria-pressed={!!item.pinned} aria-label={item.pinned ? '取消置顶' : '置顶'} disabled={disabled}
          onClick={() => run(() => invoke(bridge, 'update', item.id, { pinned: !item.pinned }), { change: { target: 'memories' }, message: '置顶状态已更新。' })}><Pin size="1em" aria-hidden="true" /></button>
        <div className="memory-menu-wrap">
          <button type="button" className="memory-icon-button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuFor === item.id} disabled={busy}
            onClick={event => { event.stopPropagation(); if (menuFor === item.id) { setMenuFor(null); return; } const box = event.currentTarget.getBoundingClientRect(); setMenuFlip(box.bottom + 128 > window.innerHeight - 8); setMenuFor(item.id); }}><MoreHorizontal size="1em" aria-hidden="true" /></button>
          {menuFor === item.id && <div className="memory-menu" role="menu" data-flip={menuFlip || undefined}>
            <button type="button" role="menuitem" disabled={busy} onClick={() => { setEditText(item.text || ''); openDialog('edit', { item }); }}>编辑内容</button>
            <button type="button" role="menuitem" disabled={disabled || item.status === 'superseded'} onClick={() => run(() => invoke(bridge, 'update', item.id, { status: item.status === 'disabled' ? 'active' : 'disabled' }), { change: { target: 'memories' }, message: '记忆状态已更新。' })}>{item.status === 'disabled' ? '重新启用' : '停用此条'}</button>
            <button type="button" role="menuitem" data-tone="danger" disabled={busy} onClick={() => openDialog('confirm-delete', { item })}>删除</button>
          </div>}
        </div>
      </div>
    </div>;
  }

  function hitRow(hit, index) {
    const label = kindNames[hit.kind] || (hit.kind === 'memory' ? '记忆' : hit.kind === 'message' || hit.kind === 'session' ? '对话消息' : hit.kind || '历史');
    return <div className="memory-item" key={`${hit.kind}-${hit.id}-${index}`}>
      <div className="memory-item-main">
        <span className="memory-item-title">{hit.text || hit.content || '（无内容）'}</span>
        <span className="memory-item-meta">
          <span>{label}</span>
          <span className="memory-project">{hit.projectName || (hit.projectId == null ? '全局' : scope === 'all' ? '其他项目' : '当前项目')}</span>
        </span>
      </div>
      <div className="memory-item-actions"><SourceLinks item={hit} onOpenSource={onOpenSource} disabled={busy} onError={setError} /></div>
    </div>;
  }

  const detailItem = dialog?.type === 'detail' ? dialog.item : null;

  return <div className="memory-settings" aria-busy={busy}>
    {demo && <div className="memory-banner" role="status">当前为浏览器预览：本地记忆仓库仅在 Mova 桌面端可用，下面的数据是<strong>示例</strong>，所有写入、导出与清空操作已禁用。弹窗与列表可以照常打开查看。</div>}
    {available && !loaded && !error && <p className="memory-muted" role="status">正在读取本地记忆…</p>}
    {error && <div className="memory-error" role="alert"><span>{error}</span><button className="settings-button" type="button" disabled={busy || demo} onClick={() => run(async () => {}, { message: '已重新读取。' })}>重新读取</button></div>}

    <section className="settings-section" aria-labelledby={`${uid}-preferences`}>
      <h3 className="settings-section-title" id={`${uid}-preferences`}>长期记忆</h3>
      <div className="settings-card">
        {toggle('memoryEnabled', '启用长期记忆', '把可复用的偏好、项目约定等保存在本机，并用于后续对话。关闭后不再注入长期记忆。', true)}
        {toggle('autoExtract', '自动提取记忆', '默认自动提取，无需逐条审批；可在下方编辑、停用或删除。请勿在对话中提供敏感凭据。', true)}
        {toggle('includeGlobal', '包含全局记忆', '构建当前项目上下文时，同时使用跨项目的全局记忆。', true)}
        {numberRow({ key: 'contextMaxMemories', title: '上下文记忆条数上限', description: '每次对话最多注入多少条记忆；不会删除仓库中的其他记忆。', value: contextLimit, onChange: setContextLimit, min: 1, max: 100, id: `${uid}-limit` })}
        {numberRow({ key: 'contextMaxChars', title: '上下文记忆字符上限', description: '限制注入的记忆文本总长度；字符数不等同于模型 token 数。', value: contextChars, onChange: setContextChars, min: 1, max: 20000, id: `${uid}-chars` })}
        {numberRow({ key: 'maxMemories', title: '记忆总条数上限', description: '超过上限后自动提取会暂停写入；不会自动删除旧记忆，请手动整理。', value: memoryLimit, onChange: setMemoryLimit, min: 1, max: 10000, id: `${uid}-max` })}
        <div className="settings-row"><div className="settings-row-text"><strong>历史保留</strong><p>当前版本永久保留本机会话，不随上下文压缩删除；临时聊天不会写入存储，也不会读取或提取记忆。暂无按天数自动清理。</p></div><span className="settings-section-note">永久</span></div>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-library`}>
      <div className="settings-section-head">
        <h3 className="settings-section-title" id={`${uid}-library`}>记忆库</h3>
        <p className="settings-section-note">项目范围只显示与当前项目 ID 完全匹配的记忆；全局范围不混入其他项目。搜索为文本匹配，不是语义检索。</p>
      </div>

      <form className="memory-toolbar" onSubmit={submitSearch} role="search">
        <label className="memory-search">
          <Search size="1em" aria-hidden="true" />
          <input type="search" value={query} placeholder="搜索记忆正文" aria-label="搜索记忆正文" disabled={!loaded}
            onChange={event => { setQuery(event.target.value); if (!event.target.value) setHits(null); }} />
        </label>
        <select className="settings-select" value={scope} aria-label="查看与搜索范围" disabled={!loaded || busy}
          onChange={event => { setScope(event.target.value); setHits(null); setMenuFor(null); }}>
          <option value="project" disabled={!projectId}>当前项目</option>
          <option value="global">全局记忆</option>
          <option value="all">全部项目</option>
        </select>
        {projectId && scope !== 'all' && <label className="memory-field-inline memory-toolbar-scope">
          <input type="checkbox" checked={searchGlobal} disabled={!loaded || busy} onChange={event => { setSearchGlobal(event.target.checked); setHits(null); }} />含全局结果
        </label>}
        <button type="submit" className="settings-button" disabled={!query.trim()}>搜索</button>
        <button type="button" className="settings-button primary" disabled={!loaded} onClick={() => { setDraft(''); openDialog('add'); }}>添加记忆</button>
      </form>

      {hits && <p className="memory-muted" role="status">找到 {hits.length} 条结果（最多 50 条）。<button type="button" className="memory-link" onClick={() => { setHits(null); setQuery(''); }}>清除搜索</button></p>}

      {loaded && !searchable.length && <div className="memory-empty">
        <p>{hits ? '没有匹配的记忆，换一个关键词试试。' : '此范围暂无记忆。'}</p>
        {!hits && <button type="button" className="settings-button" disabled={disabled} onClick={() => { setDraft(''); openDialog('add'); }}>添加第一条记忆</button>}
      </div>}

      {searchable.length > 0 && <div className="settings-card memory-list">{searchable.map((item, index) => hits ? hitRow(item, index) : memoryRow(item))}</div>}

      <p className="memory-muted">{hits ? '搜索结果来自本地关键词匹配，最多返回 50 条。' : '点击整行打开记忆详情；行内的置顶与「更多」菜单可以完成编辑、停用与删除。'}</p>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-storage`}>
      <h3 className="settings-section-title" id={`${uid}-storage`}>存储与备份</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <strong>本机 JSON 仓库</strong>
            <p>{loaded ? `${count(data.memories)} 条记忆 · ${count(data.sessions?.conversations || data.sessions)} 个会话 · ${count(data.tasks)} 个任务 · ${count(data.checkpoints)} 个检查点 · ${count(data.events)} 个事件；JSON 估算 ${(bytes / 1024).toFixed(1)} KB。` : '尚未读取本地数据。'} 统计包含所有项目，不代表当前列表范围，也不含文件系统开销。</p>
            {data.storage?.filePath && <code className="memory-path" title={data.storage.filePath}>{data.storage.filePath}</code>}
          </div>
          <span className="settings-section-note">未加密</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>手动导出备份</strong><p>导出全部项目的仓库数据，不包含应用 API 配置；凭据字段与常见密钥格式会遮盖，但历史正文仍可能含私人信息。自动备份与整库恢复在「服务与索引」页。</p></div>
          <button type="button" className="settings-button" disabled={busy} onClick={() => openDialog('confirm-export')}>导出备份</button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>清空全部长期记忆</strong><p>删除所有项目与全局的记忆；保留对话历史。不可撤销，请先导出备份。</p></div>
          <button type="button" className="settings-button danger" disabled={busy} onClick={() => openDialog('confirm-memories')}>清空记忆</button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>清空全部对话历史</strong><p>删除所有项目的本地会话历史；不清空长期记忆，但其来源可能无法再打开。不可撤销。</p></div>
          <button type="button" className="settings-button danger" disabled={busy} onClick={() => openDialog('confirm-sessions')}>清空历史</button>
        </div>
      </div>
      <p className="memory-muted memory-limitations">当前为本地 JSON 存储与关键词检索；尚未接入语义搜索／向量索引、自动备份、Pi SessionManager 或 worker 恢复。临时聊天模式由聊天界面管理。</p>
    </section>

    <ServicePanel />

    <PrivacyVaultPanel />

    {/* 记忆详情 */}
    <SettingsDialog open={dialog?.type === 'detail'} onClose={closeDialog} title="记忆详情" size="wide"
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>关闭</button>
        <button type="button" className="settings-button" disabled={busy || detailItem?.status === 'superseded'} onClick={() => { if (!detailItem) return; setEditText(detailItem.text || ''); openDialog('edit', { item: detailItem }); }}>编辑</button>
        <button type="button" className="settings-button danger" disabled={busy} onClick={() => detailItem && openDialog('confirm-delete', { item: detailItem })}>删除</button>
      </>}>
      {detailItem && <>
        <p className="memory-detail-text">{detailItem.text || '（空内容）'}</p>
        <dl className="memory-detail-grid">
          <div><dt>状态</dt><dd>{statusBadge({ status: detailItem.status })}</dd></div>
          <div><dt>类型</dt><dd>{kindNames[detailItem.kind] || detailItem.kind || '记忆'}</dd></div>
          <div><dt>版本</dt><dd>{detailItem.version != null ? `v${detailItem.version}` : '—'}</dd></div>
          <div><dt>范围</dt><dd>{detailItem.projectId == null ? '全局' : '当前项目'}</dd></div>
          <div><dt>置顶</dt><dd>{detailItem.pinned ? '已置顶' : '未置顶'}</dd></div>
          <div><dt>更新时间</dt><dd>{detailItem.updatedAt || '—'}</dd></div>
        </dl>
        <SourceLinks item={detailItem} onOpenSource={onOpenSource} disabled={busy} onError={setError} />
      </>}
    </SettingsDialog>

    {/* 新增 / 编辑 */}
    <SettingsDialog open={dialog?.type === 'add' || dialog?.type === 'edit'} onClose={closeDialog} title={dialog?.type === 'edit' ? '编辑记忆' : '添加记忆'}
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>取消</button>
        <button type="submit" form={`${uid}-memory-form`} className="settings-button primary"
          disabled={disabled || !(dialog?.type === 'edit' ? editText : draft).trim()}>{dialog?.type === 'edit' ? '保存修改' : '添加记忆'}</button>
      </>}>
      <form id={`${uid}-memory-form`} className="memory-form" onSubmit={event => {
        event.preventDefault();
        if (dialog?.type === 'edit') {
          const text = editText.trim();
          if (!text || !dialog.item) return;
          run(async () => { await invoke(bridge, 'update', dialog.item.id, { text }); closeDialog(); }, { change: { target: 'memories' }, message: '记忆已更新。' });
          return;
        }
        const text = draft.trim();
        if (!text) return;
        run(async () => { await invoke(bridge, 'save', { text, projectId: addScope === 'project' ? projectId : null, kind: addKind, source: 'user' }); setDraft(''); closeDialog(); }, { change: { target: 'memories' }, message: '手动记忆已保存。' });
      }}>
        <label htmlFor={`${uid}-memory-text`}>记忆内容</label>
        <textarea id={`${uid}-memory-text`} rows="4" maxLength={4000} autoFocus
          value={dialog?.type === 'edit' ? editText : draft}
          onChange={event => { if (dialog?.type === 'edit') setEditText(event.target.value); else setDraft(event.target.value); }}
          placeholder="例如：这个项目统一使用中文说明，提交前运行测试。"
          disabled={disabled} required />
        <div className="memory-form-row">
          <span className="memory-count">{(dialog?.type === 'edit' ? editText : draft).length} / 4000</span>
        </div>
        {dialog?.type !== 'edit' && <div className="memory-actions">
          <label className="memory-field-inline">保存范围
            <select className="settings-select" value={addScope} disabled={disabled} onChange={event => setAddScope(event.target.value)}>
              <option value="project" disabled={!projectId}>当前项目</option>
              <option value="global">全局</option>
            </select>
          </label>
          <label className="memory-field-inline">类型
            <select className="settings-select" value={addKind} disabled={disabled} onChange={event => setAddKind(event.target.value)}>
              {KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>}
        <p className="memory-muted">不要粘贴密码、密钥或私钥；仓库会拒绝明显凭据，其余内容仍会明文保存到本机。</p>
      </form>
    </SettingsDialog>

    {/* 单条删除：一次点击确认 */}
    <SettingsDialog open={dialog?.type === 'confirm-delete'} onClose={closeDialog} title="删除这条记忆？"
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>取消</button>
        <button type="button" className="settings-button danger-solid" disabled={disabled}
          onClick={() => run(async () => { await invoke(bridge, 'delete', dialog.item.id); closeDialog(); setHits(null); }, { change: { target: 'memories' }, message: '记忆已删除。' })}>删除</button>
      </>}>
      <p>删除后不可恢复；如果这条记忆还会用到，可以先用「停用」代替删除。</p>
      {dialog?.item && <p className="memory-detail-text">{dialog.item.text}</p>}
    </SettingsDialog>

    {/* 批量清空：输入确认词 */}
    <SettingsDialog open={dialog?.type === 'confirm-memories' || dialog?.type === 'confirm-sessions'} onClose={closeDialog}
      title={dialog?.type === 'confirm-sessions' ? '清空全部对话历史？' : '清空全部长期记忆？'}
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>取消</button>
        <button type="button" className="settings-button danger-solid" disabled={disabled || confirmText !== confirmWord}
          onClick={() => {
            const target = dialog?.type === 'confirm-sessions' ? 'sessions' : 'memories';
            run(async () => { await invoke(bridge, 'clear', { target }); closeDialog(); setHits(null); }, { change: { target }, message: '清空操作已完成。' });
          }}>确认{confirmWord}</button>
      </>}>
      <p>{dialog?.type === 'confirm-sessions'
        ? '将删除所有项目的本地会话历史，长期记忆保留，但它们的来源可能无法再打开。此操作作用于所有项目，不可撤销。'
        : '将删除所有项目与全局的长期记忆，对话历史保留。此操作作用于所有项目，不可撤销。建议先导出备份。'}</p>
      <label className="memory-confirm-field" htmlFor={`${uid}-confirm`}>
        <span>输入 <strong className="memory-confirm-word">{confirmWord}</strong> 以确认</span>
        <input id={`${uid}-confirm`} value={confirmText} autoComplete="off" disabled={disabled} onChange={event => setConfirmText(event.target.value)} />
      </label>
    </SettingsDialog>

    {/* 导出说明 */}
    <SettingsDialog open={dialog?.type === 'confirm-export'} onClose={closeDialog} title="导出未加密备份？"
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>取消</button>
        <button type="button" className="settings-button primary" disabled={disabled}
          onClick={() => run(exportBackup, { refresh: false, message: '已请求下载备份，请检查浏览器或桌面端的下载结果。' }).then(closeDialog)}>导出备份</button>
      </>}>
      <p>将导出所有项目的未加密本地记忆与历史，文件可能包含私人信息。凭据字段和常见密钥格式会自动遮盖，但不能保证覆盖全部秘密。</p>
      <p>导出后请自行检查文件，不要公开分享；当前没有自动备份。</p>
    </SettingsDialog>
  </div>;
}

export default MemorySettings;
