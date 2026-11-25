import React, { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, Pin } from '@keyline-icons/react';
import { errorText, invoke } from './memory-bridge.js';
import { ServiceSettings } from './memory-service-settings.jsx';
import { PrivacyVault } from './privacy-vault.jsx';
import { SettingsDialog } from './settings-dialog.jsx';
import './memory-settings.css';
import { confirmAction } from '../ui/confirm.js';

const EMPTY = { memories: [], sessions: [], tasks: [], checkpoints: [], events: [], settings: {} };
const count = value => Array.isArray(value) ? value.length : Object.keys(value || {}).length;
const list = value => Array.isArray(value) ? value : Object.values(value || {});
const statusNames = { active: '生效', disabled: '已停用', superseded: '已被替代' };
// 提取任务默认展示条数：规范没有覆盖，按「只保留 3 条，其余展开」的产品要求定。
const JOB_PREVIEW = 3;
const jobLabels = { done: '已完成', skipped: '已跳过', failed: '失败', processing: '处理中' };
const jobLabel = status => jobLabels[status] || '等待中';
const kindLabel = kind => kind === 'memory' ? '记忆' : kind === 'message' || kind === 'session' ? '对话消息' : kind || '历史';

// Backups never include credential fields, even if a future repository adds them.
function safeBackup(value) {
  if (Array.isArray(value)) return value.map(safeBackup);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential/i.test(key) ? '[已隐藏敏感凭据]' : safeBackup(entry)]));
  if (typeof value === 'string') return value
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏 API 密钥]')
    .replace(/\b(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[已隐藏 API 密钥]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已隐藏私钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|password|secret)\s*[=:：]\s*["']?)[^\s"',;，；]+/gi, '$1[已隐藏]');
  return value;
}

function SourceButtons({ item, onOpenSource, disabled, onError }) {
  const sources = item.sources?.length ? item.sources : item.conversationId ? [item] : [];
  if (!sources.length) return <span className="memory-muted">无来源（手动记忆）</span>;
  return <div className="memory-actions">{sources.map((source, index) => <button type="button" className="settings-button" key={`${source.conversationId}-${source.messageId}-${index}`} disabled={disabled || !onOpenSource || !source.conversationId} onClick={async () => {
    try { await onOpenSource(source); } catch (error) { onError(errorText(error)); }
  }}>查看来源{sources.length > 1 ? ` ${index + 1}` : ''}</button>)}</div>;
}

export function MemorySettings({ bridge, projectId, onOpenSource, onChanged, serviceOnly = false }) {
  const uid = useId();
  const available = ['read', 'search', 'save', 'update', 'delete', 'settings', 'export', 'clear'].every(method => typeof bridge?.[method] === 'function');
  const [data, setData] = useState(EMPTY);
  const [jobs, setJobs] = useState([]);
  const [maintenance, setMaintenance] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scope, setScope] = useState(projectId ? 'project' : 'global');
  const [draft, setDraft] = useState('');
  const [addScope, setAddScope] = useState(projectId ? 'project' : 'global');
  const [addKind, setAddKind] = useState('fact');
  const [editing, setEditing] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [query, setQuery] = useState('');
  const [searchGlobal, setSearchGlobal] = useState(true);
  const [searchScope, setSearchScope] = useState(projectId ? 'project' : 'global');
  const [hits, setHits] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [menuFor, setMenuFor] = useState('');
  const [jobsOpen, setJobsOpen] = useState(false);
  const [contextLimit, setContextLimit] = useState('');
  const [contextChars, setContextChars] = useState('');
  const [memoryLimit, setMemoryLimit] = useState('');
  const currentProjectRef = useRef(projectId);
  currentProjectRef.current = projectId;
  const generation = useRef(0);
  const operationLock = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setLoaded(false); setError(''); setHits(null); setEditing(null); setConfirmation(null);
    if (!available) return;
    invoke(bridge, 'read').then(value => {
      if (generation.current !== current) return;
      setData({ ...EMPTY, ...value }); setLoaded(true);
    }).catch(reason => { if (generation.current === current) setError(errorText(reason)); });
    if (typeof bridge.jobs === 'function') {
      invoke(bridge, 'jobs').then(value => {
        if (generation.current === current) setJobs(Array.isArray(value) ? value.slice(0, 8) : []);
      }).catch(() => {});
    }
    return () => { generation.current++; };
  }, [bridge, available]);

  useEffect(() => { setHits(null); setScope(projectId ? 'project' : 'global'); setAddScope(projectId ? 'project' : 'global'); setSearchScope(projectId ? 'project' : 'global'); }, [projectId]);
  useEffect(() => { setContextLimit(String(data.settings?.contextMaxMemories ?? 12)); }, [data.settings?.contextMaxMemories]);
  useEffect(() => { setContextChars(String(data.settings?.contextMaxChars ?? 6000)); }, [data.settings?.contextMaxChars]);
  useEffect(() => { setMemoryLimit(String(data.settings?.maxMemories ?? 2000)); }, [data.settings?.maxMemories]);

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

  const disabled = !available || !loaded || busy;
  const settings = data.settings || {};
  const memories = list(data.memories).filter(item => scope === 'global' ? item.projectId == null : item.projectId === projectId);
  let bytes = 0;
  try { bytes = new Blob([JSON.stringify(data)]).size; } catch { /* Read data is normally JSON. */ }
  const updateSetting = (key, value) => run(() => invoke(bridge, 'settings', { [key]: value }), { change: { target: 'settings' }, message: '记忆设置已保存。' });
  // Service-mode keys (health/backup/index/quota) are patched together so one save writes one record.
  const saveServiceSettings = patch => run(() => invoke(bridge, 'settings', patch), { change: { target: 'settings' }, message: '服务版设置已保存。' });
  const confirm = (kind, item) => { setConfirmation({ kind, item }); setConfirmText(''); setError(''); };
  const confirmWord = confirmation?.kind === 'memories' ? '清空记忆' : '清空历史';
  // 提取任务默认只露 3 条，其余折叠在「显示更多」后面。
  const visibleJobs = jobsOpen ? jobs : jobs.slice(0, JOB_PREVIEW);

  /** 搜索与记忆列表共用一个位置：有结果时列表显示结果，清除后回到当前范围。 */
  function submitSearch(event) {
    event.preventDefault();
    if (!query.trim()) return;
    const currentProject = projectId;
    const currentQuery = query;
    const currentScope = searchScope;
    run(async () => {
      const all = currentScope === 'all';
      const result = await invoke(bridge, 'search', all
        ? { query: currentQuery.trim(), allProjects: true, includeGlobal: true, limit: 50 }
        : { query: currentQuery.trim(), projectId: currentScope === 'global' ? null : currentProject || null, includeGlobal: currentScope === 'global' ? true : searchGlobal || !currentProject, limit: 50 });
      if (currentProjectRef.current === currentProject) setHits(list(result).filter(hit => all ? true : currentScope === 'global' ? hit.projectId == null : hit.projectId === currentProject || (searchGlobal && hit.projectId == null)));
    }, { refresh: false });
  }

  async function openSource(item) {
    try { await onOpenSource(item); } catch (error) { setError(errorText(error)); }
  }

  async function deleteMemory(item) {    const confirmed = await confirmAction({
      title: '删除这条记忆？',
      body: '删除后无法恢复，也不会再被模型搜索到。',
      detail: `${statusNames[item.status] || '生效'} · ${item.kind || '记忆'}：${String(item.text || '').slice(0, 80)}`,
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!confirmed) return;
    run(async () => { await invoke(bridge, 'delete', item.id); }, { change: { target: 'memories' }, message: '记忆已删除。' });
  }

  /** 清空记忆 / 清空历史：必须输入确认词，作用于所有项目。 */
  function submitClear() {
    const pending = confirmation;
    if (!pending || confirmText !== confirmWord) return;
    run(async () => {
      await invoke(bridge, 'clear', { target: pending.kind });
      setConfirmation(null);
      setHits(null);
    }, { change: { target: pending.kind }, message: '删除操作已完成。' });
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

  function toggle(key, title, description, fallback) {
    return <div className="settings-row"><div className="settings-row-text"><strong>{title}</strong><p>{description}</p></div>
      <button type="button" className="settings-switch" role="switch" aria-label={title} aria-checked={settings[key] ?? fallback} disabled={disabled} onClick={() => updateSetting(key, !(settings[key] ?? fallback))}><span /></button></div>;
  }

  return <div className={`memory-settings${serviceOnly ? ' service-only' : ''}`} aria-busy={busy}>
    {!available && <div className="memory-banner" role="status">当前浏览器环境不支持 Electron 本地记忆仓库。此页仅说明功能，不能读写、搜索、导出或清空本地数据；请在 Mova 桌面端使用。</div>}
    {available && !loaded && !error && <p className="memory-muted" role="status">正在读取本地记忆…</p>}
    {error && <div className="memory-error" role="alert">{error}<button className="settings-button" type="button" disabled={busy || !available} onClick={() => run(async () => {}, { message: '已重新读取。' })}>重新读取</button></div>}
    <div role="status" aria-live="polite" className="memory-notice">{notice}</div>

    <section className="settings-section" aria-labelledby={`${uid}-preferences`}>
      <h3 className="settings-section-title" id={`${uid}-preferences`}>长期记忆</h3>
      <div className="settings-card">
        {toggle('memoryEnabled', '启用长期记忆', '保存可复用的偏好和项目约定；模型在需要时可主动搜索，关闭后不再提供记忆搜索。', true)}
        {toggle('autoExtract', '自动提取记忆', '默认自动提取，无需逐条审批；可在下方编辑、停用或删除。请勿在对话中提供敏感凭据。', true)}
        {toggle('includeGlobal', '包含全局记忆', '模型搜索当前项目的记忆时，同时允许搜索跨项目的全局记忆。', true)}
        <form className="settings-row" onSubmit={event => { event.preventDefault(); const value = Number(contextLimit); if (!Number.isInteger(value) || value < 1 || value > 100) { setError('上下文记忆上限必须是 1–100 的整数。'); return; } updateSetting('contextMaxMemories', value); }}>
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-limit`}>每次记忆搜索条数上限</label></strong><p>限制每次模型主动搜索返回的记忆条数；工具单次最多返回 12 条，不会删除其他记忆。</p></div>
          <div className="memory-actions"><input id={`${uid}-limit`} type="number" min="1" max="100" step="1" value={contextLimit} disabled={disabled} onChange={event => setContextLimit(event.target.value)} className="memory-number" required /><button type="submit" className="settings-button" disabled={disabled}>保存</button></div>
        </form>
        <form className="settings-row" onSubmit={event => { event.preventDefault(); const value = Number(contextChars); if (!Number.isInteger(value) || value < 1 || value > 20000) { setError('上下文记忆字符上限必须是 1–20000 的整数。'); return; } updateSetting('contextMaxChars', value); }}>
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-chars`}>每次记忆搜索字符上限</label></strong><p>限制每次模型主动搜索返回的完整结果长度，包含记忆正文及 ID、范围、来源等元数据；字符数不等同于模型 token 数。</p></div>
          <div className="memory-actions"><input id={`${uid}-chars`} type="number" min="1" max="20000" step="1" value={contextChars} disabled={disabled} onChange={event => setContextChars(event.target.value)} className="memory-number" required /><button type="submit" className="settings-button" disabled={disabled}>保存</button></div>
        </form>
        <form className="settings-row" onSubmit={event => { event.preventDefault(); const value = Number(memoryLimit); if (!Number.isInteger(value) || value < 1 || value > 10000) { setError('记忆总条数上限必须是 1–10000 的整数。'); return; } updateSetting('maxMemories', value); }}>
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-max`}>记忆总条数上限</label></strong><p>超过上限后自动提取会暂停写入；不会自动删除旧记忆，请手动整理。</p></div>
          <div className="memory-actions"><input id={`${uid}-max`} type="number" min="1" max="10000" step="1" value={memoryLimit} disabled={disabled} onChange={event => setMemoryLimit(event.target.value)} className="memory-number" required /><button type="submit" className="settings-button" disabled={disabled}>保存</button></div>
        </form>
        <div className="settings-row"><div className="settings-row-text"><strong>历史保留</strong><p>当前版本永久保留本机会话，不随上下文压缩删除；临时聊天不会写入存储，也不会读取或提取记忆。暂无按天数自动清理。</p></div><span className="settings-section-note">永久</span></div>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-memories`}>
      <div className="memory-heading"><h3 className="settings-section-title" id={`${uid}-memories`}>记忆库</h3><label className="memory-field-inline">查看范围<select value={scope} onChange={event => { setScope(event.target.value); setMenuFor(''); }} disabled={!available || busy} className="settings-select"><option value="project" disabled={!projectId}>当前项目</option><option value="global">全局记忆</option></select></label></div>
      <p className="memory-muted">项目列表只显示与当前项目 ID 完全匹配的记忆，全局列表不混入其它项目。搜索是列表的过滤手段：结果会标出所属项目，不会改变 Agent 的上下文范围。</p>

      <form className="memory-toolbar" onSubmit={submitSearch}>
        <div className="memory-search">
          <input id={`${uid}-query`} type="search" value={query} onChange={event => { setQuery(event.target.value); setHits(null); }} placeholder="搜索对话内容、偏好或项目约定" aria-label="搜索关键词" disabled={disabled} />
          <button type="submit" className="settings-button" disabled={disabled || !query.trim()}>搜索</button>
        </div>
        <label className="memory-field-inline" htmlFor={`${uid}-search-scope`}>范围<select id={`${uid}-search-scope`} className="settings-select" value={searchScope} onChange={event => { setSearchScope(event.target.value); setHits(null); }} disabled={disabled}><option value="project" disabled={!projectId}>当前项目</option><option value="global">全局记忆</option><option value="all">全部项目</option></select></label>
        {searchScope === 'project' && <label className="memory-field-inline"><input type="checkbox" checked={searchGlobal} disabled={disabled} onChange={event => { setSearchGlobal(event.target.checked); setHits(null); }} />含全局结果</label>}
        <button type="button" className="settings-button primary" disabled={disabled} onClick={() => setAddOpen(true)}>添加记忆</button>
      </form>

      {hits && <p className="memory-muted" role="status">找到 {hits.length} 条结果（最多 50 条）。<button type="button" className="memory-link" onClick={() => setHits(null)}>清除结果</button></p>}

      {hits
        ? <div className="memory-list">{hits.map((hit, index) => <article className="settings-card memory-entry" key={`${hit.kind}-${hit.id}-${index}`}>
          <div className="memory-heading"><span className="memory-muted">{kindLabel(hit.kind)} · {hit.projectId ? `项目 ${hit.projectId}` : '全局'}</span></div>
          <p className="memory-content">{hit.text || hit.content}</p>
          <SourceButtons item={hit} onOpenSource={onOpenSource} disabled={busy} onError={setError} />
        </article>)}</div>
        : <div className="memory-list">{memories.map(item => <article className="settings-card memory-entry" key={item.id} data-menu-open={menuFor === item.id}>
          <div className="memory-heading"><span className="memory-muted">{statusNames[item.status] || item.status || '生效'} · {item.kind || '记忆'}{item.version != null ? ` · v${item.version}` : ''}</span><span className="memory-muted">{item.sources?.length ? '来自对话' : '手动添加'}</span></div>
          <div className="memory-entry-row">
            <p className="memory-content">{item.text || '（空内容）'}</p>
            <div className="memory-item-actions">
              <button type="button" className="memory-icon-button" aria-label={item.pinned ? '取消置顶' : '置顶'} aria-pressed={Boolean(item.pinned)} title={item.pinned ? '取消置顶' : '置顶'} disabled={disabled} onClick={() => run(() => invoke(bridge, 'update', item.id, { pinned: !item.pinned }), { change: { target: 'memories' }, message: '置顶状态已更新。' })}><Pin size={15} aria-hidden="true" /></button>
              <div className="memory-menu-wrap">
                <button type="button" className="memory-icon-button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menuFor === item.id} title="更多操作" disabled={disabled} onClick={() => setMenuFor(menuFor === item.id ? '' : item.id)}><MoreHorizontal size={15} aria-hidden="true" /></button>
                {menuFor === item.id && <div className="memory-menu" role="menu" aria-label="记忆操作">
                  <button type="button" role="menuitem" onClick={() => { setMenuFor(''); setEditing(item.id); setEditContent(item.text || ''); }}>编辑</button>
                  <button type="button" role="menuitem" disabled={item.status === 'superseded'} onClick={() => { setMenuFor(''); run(() => invoke(bridge, 'update', item.id, { status: item.status === 'disabled' ? 'active' : 'disabled' }), { change: { target: 'memories' }, message: '记忆状态已更新。' }); }}>{item.status === 'disabled' ? '启用' : '停用'}</button>
                  <button type="button" role="menuitem" disabled={!item.conversationId || !onOpenSource} onClick={() => { setMenuFor(''); void openSource(item); }}>查看来源</button>
                  <button type="button" role="menuitem" data-tone="danger" onClick={() => { setMenuFor(''); void deleteMemory(item); }}>删除</button>
                </div>}
              </div>
            </div>
          </div>
        </article>)}</div>}
      {!hits && loaded && !memories.length && <div className="memory-empty"><p>此范围暂无记忆。用上方「添加记忆」手动记一条，或在对话里让模型提取。</p></div>}

      <div className="memory-heading memory-jobs-head"><h4 className="memory-subtitle">最近记忆提取任务</h4><span className="memory-count">{jobs.length} 条</span></div>
      <p className="memory-muted">提取任务会持久化；应用退出或模型失败后，任务保留并自动重试，不会静默丢失。</p>
      {jobs.length === 0
        ? <div className="memory-empty"><p>暂无提取任务。</p></div>
        : <>
          <div className="memory-list">{visibleJobs.map(job => <article className="settings-card memory-entry" key={job.id}>
            <div className="memory-heading"><span className="memory-muted">{jobLabel(job.status)} · 尝试 {job.attempts ?? 0}/3</span><span className="memory-muted">{job.updatedAt ? new Date(job.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''}</span></div>
            <p className="memory-content">{job.projectId ? `项目 ${job.projectId}` : '全局'} · {job.conversationId || '未知会话'}</p>
            {job.lastError && <p className="memory-field-error">原因：{job.lastError}</p>}
          </article>)}</div>
          {jobs.length > JOB_PREVIEW && <button type="button" className="settings-add memory-show-all" aria-expanded={jobsOpen} onClick={() => setJobsOpen(!jobsOpen)}>{jobsOpen ? '收起' : `显示更多（还有 ${jobs.length - JOB_PREVIEW} 条）`}</button>}
        </>}
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-storage`}>
      <h3 className="settings-section-title" id={`${uid}-storage`}>存储与备份</h3>
      <div className="settings-card"><div className="settings-row"><div className="settings-row-text"><strong>{data.storage?.filePath ? '本地 JSON 兼容仓库' : '当前记忆仓库'}</strong><p>{loaded ? `${count(data.memories)} 条记忆 · ${count(data.sessions?.conversations || data.sessions)} 个会话 · ${count(data.tasks)} 个任务 · ${count(data.checkpoints)} 个检查点 · ${count(data.events)} 个事件；估算 ${(bytes / 1024).toFixed(1)} KB。` : '尚未读取数据。'} 数据总量包含所有项目，不代表当前列表范围。估算不包含文件系统开销。{data.storage?.filePath ? <code className="memory-path" title={data.storage.filePath}>{data.storage.filePath}</code> : '服务模式下使用 PostgreSQL，连接与备份状态见「服务与索引」页。'}</p></div></div>
        <div className="settings-row"><div className="settings-row-text"><strong>手动导出备份</strong><p>导出全部项目的仓库数据，不包含应用 API 配置；凭据字段及常见密钥格式会遮盖，但历史正文仍可能含私人信息或未识别的秘密。备份为未加密 JSON，请自行检查并妥善保管。自动备份与恢复属于服务版能力，见「服务与索引」页。</p></div><button type="button" className="settings-button" disabled={disabled} onClick={async () => { const confirmed = await confirmAction({ title: '导出未加密备份？', body: '将导出所有项目的本地记忆与历史备份，可能包含私人信息。', detail: '备份为未加密 JSON，凭据字段与常见密钥格式会遮盖，但历史正文仍可能含私人信息。请检查备份，勿公开分享。', confirmLabel: '导出' }); if (confirmed) run(exportBackup, { refresh: false, message: '已请求下载备份，请检查浏览器或桌面端的下载结果。' }); }}>导出备份</button></div>
        <div className="settings-row"><div className="settings-row-text"><strong>整理与压缩</strong><p>扫描过期记忆、长期未使用且低重要性的记忆，以及同作用域的完全重复项。整理只停用或替代，不物理删除；置顶和高重要性记忆不会被归档。</p></div><button type="button" className="settings-button" disabled={busy || typeof bridge?.maintenance !== 'function'} onClick={async () => {
          const confirmed = await confirmAction({ title: '立即整理记忆？', body: '将停用过期/低价值记忆，并替代同作用域的完全重复项。', detail: '整理只停用或替代，不物理删除；置顶和高重要性记忆不会被归档。', confirmLabel: '开始整理' });
          if (!confirmed) return;
          run(async () => { setMaintenance(await invoke(bridge, 'maintenance', { apply: true })); }, { change: { target: 'memories' }, message: '记忆整理已完成。' });
        }}>扫描并整理</button></div>
        {maintenance && <div className="settings-row"><div className="settings-row-text"><p role="status">上次整理：归档 {maintenance.stats?.archive ?? 0} 条 · 合并 {maintenance.stats?.mergeGroups ?? 0} 组 · 保留 {maintenance.stats?.keep ?? 0} 条</p></div></div>}
        <div className="settings-row"><div className="settings-row-text"><strong>清空全部长期记忆</strong><p>删除所有项目和全局的记忆；保留对话历史。不可撤销，请先导出备份。</p></div><button type="button" className="settings-button danger" disabled={disabled} onClick={() => confirm('memories')}>清空记忆</button></div>
        <div className="settings-row"><div className="settings-row-text"><strong>清空全部对话历史</strong><p>删除所有项目的本地会话历史；不清空长期记忆，但其来源可能无法再打开。不可撤销。</p></div><button type="button" className="settings-button danger" disabled={disabled} onClick={() => confirm('sessions')}>清空历史</button></div>
      </div>
      <PrivacyVault bridge={bridge} />
    </section>

    <SettingsDialog
      open={Boolean(confirmation)}
      title={confirmation?.kind === 'memories' ? '清空全部长期记忆？' : '清空全部对话历史？'}
      size="small"
      onClose={() => setConfirmation(null)}
      footer={<>
        <button type="button" className="settings-button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
        <button type="button" className="settings-button danger" disabled={disabled || confirmText !== confirmWord} onClick={submitClear}>确认{confirmWord}</button>
      </>}
    >
      <div className="memory-form">
        <p className="memory-muted">{confirmation?.kind === 'memories'
          ? '删除所有项目和全局的记忆，保留对话历史。此操作作用于所有项目，且不可撤销，建议先导出备份。'
          : '删除所有项目的本地会话历史，不清空长期记忆，但其来源可能无法再打开。此操作作用于所有项目，且不可撤销。'}</p>
        <label htmlFor={`${uid}-confirm`}>输入“{confirmWord}”以确认</label>
        <input id={`${uid}-confirm`} value={confirmText} onChange={event => setConfirmText(event.target.value)} autoComplete="off" autoFocus disabled={busy} />
      </div>
    </SettingsDialog>

    <SettingsDialog open={addOpen} title="添加记忆" size="medium" onClose={() => setAddOpen(false)} footer={<>
      <button type="button" className="settings-button" onClick={() => setAddOpen(false)} disabled={busy}>取消</button>
      <button type="button" className="settings-button primary" disabled={disabled || !draft.trim()} onClick={() => run(async () => { await invoke(bridge, 'save', { text: draft.trim(), projectId: addScope === 'project' ? projectId : null, kind: addKind, source: 'user' }); setDraft(''); setAddOpen(false); }, { change: { target: 'memories' }, message: '手动记忆已保存。' })}>保存</button>
    </>}>
      <div className="memory-form">
        <label htmlFor={`${uid}-new`}>记忆内容</label>
        <textarea id={`${uid}-new`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="例如：这个项目统一使用中文说明，提交前运行测试。" rows="4" maxLength={4000} disabled={disabled} autoFocus />
        <div className="memory-actions">
          <label className="memory-field-inline">保存范围<select className="settings-select" value={addScope} onChange={event => setAddScope(event.target.value)} disabled={disabled}><option value="project" disabled={!projectId}>当前项目</option><option value="global">全局</option></select></label>
          <label className="memory-field-inline">类型<select className="settings-select" value={addKind} onChange={event => setAddKind(event.target.value)} disabled={disabled}><option value="fact">项目事实</option><option value="preference">用户偏好</option><option value="decision">项目决定</option><option value="note">备注</option></select></label>
        </div>
      </div>
    </SettingsDialog>

    <SettingsDialog open={Boolean(editing)} title="编辑记忆" size="medium" onClose={() => setEditing(null)} footer={<>
      <button type="button" className="settings-button" onClick={() => setEditing(null)} disabled={busy}>取消</button>
      <button type="button" className="settings-button primary" disabled={disabled || !editContent.trim()} onClick={() => run(async () => { await invoke(bridge, 'update', editing, { text: editContent.trim() }); setEditing(null); }, { change: { target: 'memories' }, message: '记忆已更新。' })}>保存修改</button>
    </>}>
      <div className="memory-form">
        <label htmlFor={`${uid}-edit`}>记忆内容</label>
        <textarea id={`${uid}-edit`} rows="4" value={editContent} onChange={event => setEditContent(event.target.value)} disabled={disabled} maxLength={4000} autoFocus />
      </div>
    </SettingsDialog>
    <ServiceSettings bridge={bridge} settings={settings} ready={available && loaded} busy={busy} onSaveSettings={saveServiceSettings} />

    <p className="memory-muted memory-limitations">服务版的连接状态、备份恢复、索引与配额只显示服务端实际报告的数据：未接入的接口显示“未检测／未报告”，不会显示为已连接。服务版模式下以 PostgreSQL 为会话/记忆权威；本地 JSON 仅作为未连接服务时的回退。临时聊天模式由聊天界面管理。</p>
  </div>;
}

export default MemorySettings;
