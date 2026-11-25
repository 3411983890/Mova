import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { errorText, formatBytes, formatCount, formatTime, invoke } from './memory-bridge.js';
import './service-settings.css';

// Defaults for the six service-mode sections. The backend must persist the same
// keys with the same defaults; unknown keys are rejected by memory-store today.
export const SERVICE_DEFAULTS = Object.freeze({
  autoStartServices: true,
  backupSchedule: 'daily 03:00',
  backupRetentionDays: 30,
  semanticSearch: true,
  hybridWeight: 0.5,
  extractorMode: 'llm',
});

const SCHEDULES = [
  ['daily 03:00', '每日 03:00'],
  ['daily 12:00', '每日 12:00'],
  ['weekly 03:00', '每周一 03:00'],
  ['off', '关闭自动备份'],
];

const EXTRACTORS = [
  ['llm', 'LLM 提取', '使用当前聊天模型从用户消息中提取事实、偏好和决定。会产生少量 token 费用；失败时明确报错，不回退规则。'],
  ['off', '关闭自动提取', '不自动提取；仍可在「记忆管理」手动添加，已有记忆不受影响。'],
];

const HEALTH_FIELDS = [
  ['database', '数据库 PostgreSQL'],
  ['redis', 'Redis 队列'],
  ['objectStorage', '对象存储 MinIO'],
  ['embedding', 'Embedding 模型'],
];

const HEALTH_LABELS = {
  database: { ok: ['正常', 'ok'], down: ['不可用', 'error'], migrating: ['迁移中', 'warn'] },
  redis: { ok: ['正常', 'ok'], down: ['不可用', 'error'], disabled: ['未启用', 'muted'] },
  objectStorage: { ok: ['正常', 'ok'], down: ['不可用', 'error'], disabled: ['未启用', 'muted'] },
  embedding: { ok: ['就绪', 'ok'], loading: ['加载中', 'warn'], down: ['不可用', 'error'] },
};

const BACKUP_LABELS = { running: ['进行中', 'warn'], completed: ['已完成', 'ok'], failed: ['失败', 'error'] };
const GB = 1024 ** 3;

function StatusPill({ value, labels, empty = '未报告' }) {
  if (value == null || value === '') return <span className="memory-pill" data-tone="unknown">{empty}</span>;
  const entry = labels?.[value];
  return <span className="memory-pill" data-tone={entry ? entry[1] : 'unknown'}>{entry ? entry[0] : String(value)}</span>;
}

function backupTime(record) {
  return record?.completedAt ?? record?.createdAt ?? record?.completed_at ?? record?.created_at ?? null;
}

function backupSortTime(record) {
  const raw = backupTime(record);
  const stamp = raw ? new Date(raw).getTime() : NaN;
  return Number.isNaN(stamp) ? 0 : stamp;
}

function backupKind(record) {
  if (record?.kind === 'manual') return '手动';
  if (record?.kind === 'scheduled') return '自动';
  return record?.kind || '备份';
}

export function BackupList({ backups, selectedId, onSelect, disabled }) {
  return <div className="settings-card">
    <div className="settings-row"><div className="settings-row-text"><strong>备份记录</strong><p>最多显示最近 20 条，按时间倒序；选中一条已完成备份后可点「恢复所选备份」。</p></div></div>
    {(backups || []).slice(0, 20).map((record, index) => <div className="settings-row memory-backup-row" key={record.id ?? `backup-${index}`}>
      <label className="memory-backup-select">
        <input type="radio" name="memory-backup-select" checked={selectedId === record.id} onChange={() => onSelect?.(record.id)} disabled={disabled || record.status !== 'completed'} />
        <span className="memory-backup-main">
          <strong>{backupKind(record)}备份</strong>
          <span className="memory-muted">{formatTime(backupTime(record))} · {formatBytes(record.bytes)}{record.error ? ` · ${errorText(record.error)}` : ''}</span>
        </span>
      </label>
      <StatusPill value={record.status} labels={BACKUP_LABELS} />
    </div>)}
  </div>;
}

export function QuotaStats({ stats }) {
  const totalBytes = Number(stats?.databaseBytes || 0) + Number(stats?.attachmentBytes || 0);
  const quotaBytes = stats?.quotaBytes == null ? null : Number(stats.quotaBytes);
  const quotaPercent = quotaBytes != null && Number.isFinite(quotaBytes) && quotaBytes > 0
    ? Math.min(100, (totalBytes / quotaBytes) * 100)
    : null;
  const quotaTone = quotaPercent == null ? undefined : quotaPercent >= 100 ? 'error' : quotaPercent >= 90 ? 'warn' : 'ok';
  return <div className="settings-card">
    <dl className="memory-stats">
      <div><dt>数据库</dt><dd title={`${stats?.databaseBytes ?? '未报告'} 字节`}>{formatBytes(stats?.databaseBytes)}</dd></div>
      <div><dt>附件与对象存储</dt><dd title={`${stats?.attachmentBytes ?? '未报告'} 字节`}>{formatBytes(stats?.attachmentBytes)}</dd></div>
      <div><dt>队列等待</dt><dd>{formatCount(stats?.queueWaiting)}</dd></div>
      <div><dt>队列失败</dt><dd data-tone={Number(stats?.queueFailed) > 0 ? 'error' : undefined}>{formatCount(stats?.queueFailed)}</dd></div>
      <div><dt>记忆</dt><dd>{formatCount(stats?.memories)}</dd></div>
      <div><dt>会话</dt><dd>{formatCount(stats?.conversations)}</dd></div>
      <div><dt>会话事件</dt><dd>{formatCount(stats?.events)}</dd></div>
      <div><dt>配额上限</dt><dd>{quotaBytes == null ? '未设置' : formatBytes(quotaBytes)}</dd></div>
    </dl>
    {quotaPercent != null && <div className="memory-quota">
      <div className="memory-quota-head"><span>已用 {formatBytes(totalBytes)} / {formatBytes(quotaBytes)}</span><span data-tone={quotaTone}>{quotaPercent.toFixed(1)}%</span></div>
      <div className="memory-quota-bar" role="img" aria-label={`存储配额已使用 ${quotaPercent.toFixed(1)}%`}><span data-tone={quotaTone} style={{ width: `${quotaPercent}%` }} /></div>
    </div>}
  </div>;
}

export function ServiceSettings({ bridge, settings, ready, busy, onSaveSettings }) {
  const uid = useId();
  const source = settings || {};
  const canSaveSettings = typeof onSaveSettings === 'function';
  const supported = {
    health: typeof bridge?.health === 'function',
    stats: typeof bridge?.stats === 'function',
    backup: typeof bridge?.backup === 'function',
    backups: typeof bridge?.backups === 'function',
    restore: typeof bridge?.restore === 'function',
    reindex: typeof bridge?.reindex === 'function',
  };

  const storedSchedule = source.backupSchedule ?? SERVICE_DEFAULTS.backupSchedule;
  const storedRetention = Number(source.backupRetentionDays ?? SERVICE_DEFAULTS.backupRetentionDays);
  const storedWeight = Number(source.hybridWeight ?? SERVICE_DEFAULTS.hybridWeight);
  const storedExtractor = source.extractorMode ?? SERVICE_DEFAULTS.extractorMode;
  const storedSemantic = source.semanticSearch ?? SERVICE_DEFAULTS.semanticSearch;
  const storedAutoStart = source.autoStartServices ?? SERVICE_DEFAULTS.autoStartServices;

  const [health, setHealth] = useState(null);
  const [healthPhase, setHealthPhase] = useState(supported.health ? 'loading' : 'unsupported');
  const [stats, setStats] = useState(null);
  const [statsPhase, setStatsPhase] = useState(supported.stats ? 'loading' : 'unsupported');
  const [backups, setBackups] = useState(null);
  const [backupsPhase, setBackupsPhase] = useState(supported.backups ? 'loading' : 'unsupported');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [planError, setPlanError] = useState('');
  const [weightError, setWeightError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [schedule, setSchedule] = useState(storedSchedule);
  const [retention, setRetention] = useState(String(storedRetention));
  const [weight, setWeight] = useState(String(storedWeight));
  const [quotaGb, setQuotaGb] = useState(String((Number(source.quotaBytes) || 0) / GB));
  const alive = useRef(true);
  const locked = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { setSchedule(storedSchedule); }, [storedSchedule]);
  useEffect(() => { setRetention(String(storedRetention)); }, [storedRetention]);
  useEffect(() => { setWeight(String(storedWeight)); }, [storedWeight]);
  useEffect(() => { setQuotaGb(String((Number(source.quotaBytes) || 0) / GB)); }, [source.quotaBytes]);

  const loadHealth = useCallback(async () => {
    if (!supported.health) return null;
    setHealthPhase('loading');
    try {
      const result = await invoke(bridge, 'health');
      if (alive.current) { setHealth(result || null); setHealthPhase('ready'); }
      return result;
    } catch (reason) {
      if (alive.current) { setHealth(null); setHealthPhase('error'); }
      throw reason;
    }
  }, [bridge, supported.health]);

  const loadStats = useCallback(async () => {
    if (!supported.stats) return null;
    setStatsPhase('loading');
    try {
      const result = await invoke(bridge, 'stats');
      if (alive.current) { setStats(result || null); setStatsPhase('ready'); }
      return result;
    } catch (reason) {
      if (alive.current) { setStats(null); setStatsPhase('error'); }
      throw reason;
    }
  }, [bridge, supported.stats]);

  const loadBackups = useCallback(async () => {
    if (!supported.backups) return null;
    setBackupsPhase('loading');
    try {
      const result = await invoke(bridge, 'backups');
      if (alive.current) {
        setBackups(Array.isArray(result) ? result : Object.values(result || {}));
        setBackupsPhase('ready');
      }
      return result;
    } catch (reason) {
      if (alive.current) { setBackups(null); setBackupsPhase('error'); }
      throw reason;
    }
  }, [bridge, supported.backups]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([loadHealth(), loadStats(), loadBackups()]).then(results => {
      if (cancelled || !alive.current) return;
      const failures = results.filter(item => item.status === 'rejected').map(item => errorText(item.reason));
      if (failures.length) setLoadError(failures.join(' '));
    });
    return () => { cancelled = true; };
  }, [loadHealth, loadStats, loadBackups]);

  async function operate(name, work) {
    if (locked.current) return;
    locked.current = true;
    setPending(name); setActionError(''); setLoadError(''); setPlanError(''); setWeightError(''); setNotice('');
    try {
      await work();
    } catch (reason) {
      if (alive.current) setActionError(errorText(reason));
    } finally {
      locked.current = false;
      if (alive.current) setPending('');
    }
  }

  const refreshAll = () => operate('refresh', async () => {
    const results = await Promise.allSettled([loadHealth(), loadStats(), loadBackups()]);
    const failures = results.filter(item => item.status === 'rejected').map(item => errorText(item.reason));
    if (failures.length) throw new Error(failures.join(' '));
    setNotice('已重新检测服务状态。');
  });

  const backupNow = () => operate('backup', async () => {
    const record = await invoke(bridge, 'backup', { kind: 'manual' });
    await Promise.allSettled([loadBackups(), loadStats()]);
    if (record?.status === 'failed') throw new Error(`手动备份失败：${errorText(record?.error || 'backup-failed')}`);
    setNotice(record?.status === 'running'
      ? '手动备份已开始，完成后请点「刷新记录」查看结果。'
      : record?.status === 'completed'
        ? '手动备份已完成，请核对下方记录。'
        : '已提交手动备份，请核对下方记录。');
  });

  const restoreBackup = target => operate('restore', async () => {
    if (!target?.id) throw new Error('请选择要恢复的备份。');
    await invoke(bridge, 'restore', { id: target.id });
    setRestoreTarget(null); setConfirmText(''); setSelectedId('');
    await Promise.allSettled([loadBackups(), loadStats(), loadHealth()]);
    setNotice('恢复已完成。请重新打开会话，确认历史与记忆是否一致。');
  });

  const rebuildIndex = () => operate('reindex', async () => {
    const result = await invoke(bridge, 'reindex');
    await Promise.allSettled([loadStats(), loadHealth()]);
    const queued = Number(result?.queued);
    setNotice(Number.isFinite(queued)
      ? `已排入索引重建队列：${queued} 个分块。重建在后台执行，队列积压见「存储配额与服务状态」。`
      : '已请求重建索引，后台执行；完成时间取决于队列与模型加载速度。');
  });

  const savePatch = patch => {
    if (!canSaveSettings || !patch) return;
    setPlanError(''); setWeightError(''); setNotice('');
    onSaveSettings(patch);
  };

  const actionDisabled = !ready || busy || pending !== '';
  const settingDisabled = actionDisabled || !canSaveSettings;
  const sortedBackups = [...(backups || [])].sort((left, right) => backupSortTime(right) - backupSortTime(left));
  const completedBackups = sortedBackups.filter(record => record?.status === 'completed');
  const lastBackup = completedBackups[0] || null;
  const selectedBackup = selectedId ? completedBackups.find(record => record.id === selectedId) || null : null;
  const scheduleOptions = SCHEDULES.some(([value]) => value === storedSchedule)
    ? SCHEDULES
    : [[storedSchedule, `自定义（${storedSchedule}）`], ...SCHEDULES];
  const knownExtractor = EXTRACTORS.some(([value]) => value === storedExtractor);
  const embeddingState = health?.embedding ?? null;
  const indexPath = stats?.indexPath ?? null;
  const indexPhase = !supported.stats
    ? { tone: 'unknown', label: '未报告' }
    : statsPhase === 'loading'
      ? { tone: 'unknown', label: '读取中…' }
      : !stats
        ? { tone: 'unknown', label: '未报告' }
        : !indexPath
          ? { tone: 'muted', label: '尚未建立索引' }
          : embeddingState === 'down'
            ? { tone: 'error', label: '索引存在，但 Embedding 不可用' }
            : embeddingState === 'loading'
              ? { tone: 'warn', label: '索引存在，模型加载中' }
              : { tone: 'ok', label: '已建立' };

  const planDirty = schedule !== storedSchedule
    || (Number.isInteger(Number(retention)) && Number(retention) !== storedRetention);
  const weightDirty = Math.abs(Number(weight) - storedWeight) > 1e-9;
  const semanticNote = !storedSemantic
    ? { tone: 'muted', text: '语义通道已关闭：检索只走关键词，不会产生 Embedding 调用。' }
    : !supported.health
      ? { tone: 'unknown', text: '无法获取服务端健康状态，当前不能确认语义通道是否可用。' }
      : embeddingState === 'down'
        ? { tone: 'error', text: 'Embedding 当前不可用：检索会自动回退关键词，不会伪造向量，也不会写入不存在的语义结果。' }
        : embeddingState === 'loading'
          ? { tone: 'warn', text: 'Embedding 正在加载：加载完成前的检索可能只走关键词，加载失败会保持关键词降级。' }
          : embeddingState === 'ok'
            ? { tone: 'ok', text: 'Embedding 就绪：检索按关键词与向量混合排序；索引缺失时向量通道为空。' }
            : { tone: 'unknown', text: '尚未检测到 Embedding 状态。' };

  return <div className="memory-service">
    <div role="status" aria-live="polite" className="memory-notice">{notice}</div>
    {actionError && <div className="memory-error" role="alert"><span>{actionError}</span><button type="button" className="settings-button" disabled={pending !== ''} onClick={refreshAll}>重新检测</button></div>}
    {loadError && !actionError && <div className="memory-error" role="alert"><span>{loadError}</span><button type="button" className="settings-button" disabled={pending !== ''} onClick={refreshAll}>重新检测</button></div>}

    <section className="settings-section" aria-labelledby={`${uid}-health`}>
      <h3 className="settings-section-title" id={`${uid}-health`}>服务连接与健康状态</h3>
      {!bridge && <div className="memory-banner" role="status">当前环境未连接 Mova 桌面端，无法检测服务状态。</div>}
      {bridge && !supported.health && <div className="memory-banner" role="status">当前桌面端尚未提供 memory:health 接口。这里只显示“未检测”，不会把未探测的服务显示为已连接。</div>}
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>运行模式</strong><p>{health?.mode ? `服务端报告的模式：${health.mode}。` : '尚未获得服务端报告；连接状态需要实际探测，不做推测。'}</p></div>
          <span className="memory-pill" data-tone="unknown">{health?.mode || (supported.health ? (healthPhase === 'loading' ? '检测中…' : '未报告') : '未检测')}</span>
        </div>
        {HEALTH_FIELDS.map(([key, label]) => <div className="settings-row" key={key}>
          <div className="settings-row-text"><strong>{label}</strong><p>{key === 'embedding' ? '语义检索依赖的本地 ONNX 模型；不可用时检索降级为关键词。' : key === 'redis' ? '后台队列依赖；未启用时提取、索引与备份不排队。' : key === 'objectStorage' ? '附件对象存储；未启用时附件留在本地目录。' : '会话、记忆与事件的权威存储。'}</p></div>
          <StatusPill value={health?.[key] ?? null} labels={HEALTH_LABELS[key]} empty={supported.health ? (healthPhase === 'loading' ? '检测中…' : '未报告') : '未检测'} />
        </div>)}
        <div className="settings-row">
          <div className="settings-row-text"><strong>队列积压</strong><p>等待中的后台任务数量；持续增长说明 Worker 未运行或处理不过来。</p></div>
          <span className="memory-stat-value">{health?.queueLag != null ? formatCount(health.queueLag) : (healthPhase === 'loading' ? '检测中…' : '未报告')}</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>自动启动本机服务</strong><p>开启后 Mova 启动时尝试拉起本机 PostgreSQL、Redis 与 MinIO（仅本地自托管模式）；关闭后需自行启动，服务不可用时功能降级，页面不会显示为已连接。</p></div>
          <button type="button" className="settings-switch" role="switch" aria-label="自动启动本机服务" aria-checked={storedAutoStart === true} disabled={settingDisabled} onClick={() => savePatch({ autoStartServices: storedAutoStart !== true })}><span /></button>
        </div>
        {health?.message && <div className="settings-row"><div className="settings-row-text"><strong>服务端说明</strong><p className="memory-warn-text">{health.message}</p></div></div>}
        <div className="settings-row">
          <div className="settings-row-text"><strong>连接检测</strong><p>{supported.health ? '重新调用健康检查并刷新备份与统计数据；单项失败显示对应状态，不会中断整页。' : '接口未接入时无法执行检测。'}</p></div>
          <div className="memory-actions">
            <button type="button" className="settings-button" disabled={!supported.health || pending !== ''} onClick={refreshAll}>{pending === 'refresh' ? '检测中…' : '检测连接'}</button>
          </div>
        </div>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-backup`}>
      <h3 className="settings-section-title" id={`${uid}-backup`}>自动备份与恢复</h3>
      <p className="settings-section-note">当前提供逻辑备份（pg_dump 数据库导出）。服务版默认无法确认所有进程和外部连接已停写，因此会拒绝覆盖当前数据库；可使用 <code>scripts/pitr.mjs</code> 将基础备份与 WAL 恢复到新集群。设置页不提供时间点选择，备份不包含附件。</p>
      {bridge && !supported.backup && <div className="memory-banner" role="status">当前桌面端尚未提供 memory:backup 接口，备份与恢复按钮不可用；不会假装已生成或已恢复备份。</div>}
      <form className="settings-card" onSubmit={event => {
        event.preventDefault();
        if (!planDirty) return;
        const days = Number(retention);
        if (!Number.isInteger(days) || days < 1 || days > 365) { setPlanError('备份保留天数必须是 1–365 的整数。'); return; }
        setPlanError('');
        savePatch({ backupSchedule: schedule, backupRetentionDays: days });
      }}>
        <div className="settings-row">
          <div className="settings-row-text"><strong>备份计划与保留</strong><p>自动备份按服务端本地时间执行，默认每日 03:00；保留天数到期后由服务端清理旧备份。关闭计划只停止自动备份，手动备份仍可用。</p></div>
          <div className="memory-actions">
            <label className="memory-field-inline">频率<select className="settings-select" value={schedule} onChange={event => setSchedule(event.target.value)} disabled={settingDisabled}>{scheduleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="memory-field-inline">保留<input type="number" className="memory-number" min="1" max="365" step="1" value={retention} onChange={event => setRetention(event.target.value)} disabled={settingDisabled} aria-label="备份保留天数" />天</label>
            <button type="submit" className="settings-button" disabled={settingDisabled || !planDirty}>保存计划</button>
          </div>
        </div>
        {planError && <p className="memory-field-error" role="alert">{planError}</p>}
      </form>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>上次备份</strong><p>{lastBackup ? `${backupKind(lastBackup)}备份 · ${formatTime(backupTime(lastBackup))} · ${formatBytes(lastBackup.bytes)}。` : supported.backups ? (backupsPhase === 'loading' ? '正在读取备份记录…' : '没有已完成的备份记录。') : '备份记录接口未接入。'}</p></div>
          <div className="memory-actions">
            <button type="button" className="settings-button" disabled={!supported.backup || pending !== ''} onClick={backupNow}>{pending === 'backup' ? '备份中…' : '备份现在'}</button>
            <button type="button" className="settings-button" disabled={!supported.backups || pending !== ''} onClick={() => operate('backups', loadBackups)}>{backupsPhase === 'loading' ? '刷新中…' : '刷新记录'}</button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>恢复备份</strong><p>仅允许选择已完成的备份。服务版默认不具备外部独占写入保证，覆盖恢复会被拒绝；完整性检查未配置时不会显示“已校验”。</p></div>
          <div className="memory-actions">
            <button type="button" className="settings-button danger" disabled={!supported.restore || !lastBackup || pending !== ''} onClick={() => { setRestoreTarget(lastBackup); setConfirmText(''); }}>恢复最近备份</button>
            <button type="button" className="settings-button danger" disabled={!supported.restore || !selectedBackup || pending !== ''} onClick={() => { setRestoreTarget(selectedBackup); setConfirmText(''); }}>恢复所选备份</button>
          </div>
        </div>
      </div>
      {supported.backups && backups && backups.length > 0 && <BackupList backups={sortedBackups} selectedId={selectedId} onSelect={setSelectedId} disabled={pending !== ''} />}
      {supported.backups && backupsPhase === 'ready' && backups && backups.length === 0 && <p className="memory-muted">服务端还没有备份记录。</p>}
      {restoreTarget && <form className="memory-confirm" onSubmit={event => { event.preventDefault(); if (confirmText !== '恢复') return; restoreBackup(restoreTarget); }}>
        <strong>确认恢复备份？</strong>
        <p className="memory-muted">请求用 {backupKind(restoreTarget)}备份（{formatTime(backupTime(restoreTarget))}）覆盖当前数据库。服务版默认无法保证外部连接已停写，将拒绝此操作；覆盖操作不可撤销。</p>
        <label htmlFor={`${uid}-restore`}>输入“恢复”确认</label>
        <input id={`${uid}-restore`} value={confirmText} onChange={event => setConfirmText(event.target.value)} autoComplete="off" autoFocus disabled={pending !== ''} />
        <div className="memory-actions">
          <button type="submit" className="settings-button danger" disabled={!ready || busy || pending !== '' || confirmText !== '恢复'}>{pending === 'restore' ? '恢复中…' : '确认恢复'}</button>
          <button type="button" className="settings-button" disabled={pending !== ''} onClick={() => { setRestoreTarget(null); setConfirmText(''); }}>取消</button>
        </div>
      </form>}
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-index`}>
      <h3 className="settings-section-title" id={`${uid}-index`}>Embedding 与索引</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>模型与维度</strong><p>本地 ONNX 运行时，不依赖 Python 或 Ollama；文档加 passage、查询加 query 前缀。首次下载失败时状态为不可用，检索降级为关键词。</p></div>
          <span className="memory-stat-value">{health?.embeddingModel || '未报告'}{health?.embeddingDim != null ? ` · ${health.embeddingDim} 维` : ''}</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>加载状态</strong><p>模型加载中或下载失败会直接显示，不会伪造向量。</p></div>
          <StatusPill value={embeddingState} labels={HEALTH_LABELS.embedding} empty={supported.health ? (healthPhase === 'loading' ? '检测中…' : '未报告') : '未检测'} />
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>索引状态</strong><p>检索分块存放在服务端数据库；尚未建立索引时语义通道为空，只走关键词。</p></div>
          <span className="memory-pill" data-tone={indexPhase.tone}>{indexPhase.label}</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>索引位置</strong></div>
          <span className="memory-stat-value">{indexPath ? <code className="memory-path" title={indexPath}>{indexPath}</code> : '未报告'}</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>重建索引</strong><p>清空并重建全部分块，后台执行；期间语义结果可能不完整，关键词检索仍可用。不会索引思考、工具、临时会话或敏感内容。</p></div>
          <button type="button" className="settings-button" disabled={!supported.reindex || pending !== ''} onClick={rebuildIndex}>{pending === 'reindex' ? '提交中…' : '重建索引'}</button>
        </div>
        {embeddingState !== 'ok' && supported.health && <div className="settings-row"><div className="settings-row-text"><strong>失败原因</strong><p className="memory-warn-text">{health?.message || '健康检查报告 Embedding 未就绪，但未给出具体原因；请查看服务端日志与模型缓存目录。'}</p></div></div>}
        {supported.health && embeddingState !== 'ok' && <p className="memory-field-error" role="status">Embedding 未就绪时重建索引会排队等待或失败，建议先修复模型加载。</p>}
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-semantic`}>
      <h3 className="settings-section-title" id={`${uid}-semantic`}>语义检索与混合权重</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>启用语义检索</strong><p>关闭后只使用关键词（全文加中文 ngram）排序，不产生 Embedding 调用；Embedding 不可用时自动回退关键词。</p></div>
          <button type="button" className="settings-switch" role="switch" aria-label="启用语义检索" aria-checked={storedSemantic === true} disabled={settingDisabled} onClick={() => savePatch({ semanticSearch: storedSemantic !== true })}><span /></button>
        </div>
        <form className="settings-row" onSubmit={event => {
          event.preventDefault();
          if (!weightDirty) return;
          const value = Number(weight);
          if (!Number.isFinite(value) || value < 0 || value > 1) { setWeightError('混合权重必须是 0–1 之间的数字。'); return; }
          setWeightError('');
          savePatch({ hybridWeight: Math.round(value * 100) / 100 });
        }}>
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-weight`}>混合检索权重</label></strong><p>0 表示只按关键词，1 表示只按向量相似度；默认 0.5 即关键词 0.5、向量 0.5。调整后由服务端在 RRF 融合时应用。</p></div>
          <div className="memory-actions">
            <input id={`${uid}-weight`} className="memory-range" type="range" min="0" max="1" step="0.05" value={weight} onChange={event => setWeight(event.target.value)} disabled={settingDisabled} aria-valuetext={`向量 ${Number(weight).toFixed(2)}，关键词 ${(1 - Number(weight)).toFixed(2)}`} />
            <output className="memory-weight-value" htmlFor={`${uid}-weight`}>向量 {Number.isFinite(Number(weight)) ? Number(weight).toFixed(2) : '—'}<span> / 关键词 {Number.isFinite(Number(weight)) ? (1 - Number(weight)).toFixed(2) : '—'}</span></output>
            <button type="submit" className="settings-button" disabled={settingDisabled || !weightDirty}>保存权重</button>
          </div>
        </form>
        {weightError && <p className="memory-field-error" role="alert">{weightError}</p>}
        <div className="settings-row"><div className="settings-row-text"><strong>通道状态</strong><p className={semanticNote.tone === 'error' || semanticNote.tone === 'warn' ? 'memory-warn-text' : undefined}>{semanticNote.text}</p></div></div>
        <div className="settings-row"><div className="settings-row-text"><strong>检索测试</strong><p>本版本没有服务端检索测试接口，不会在设置页伪造“测试通过”。切换开关与权重后，可在「历史搜索」中验证结果；语义通道是否可用以上方健康检查为准。</p></div></div>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-extractor`}>
      <h3 className="settings-section-title" id={`${uid}-extractor`}>记忆提取模式</h3>
      <div className="settings-card" role="radiogroup" aria-label="记忆提取模式">
        {EXTRACTORS.map(([value, title, description]) => <div className="settings-row" key={value}>
          <label className="memory-choice">
            <input type="radio" name={`${uid}-extractor`} value={value} checked={storedExtractor === value} disabled={settingDisabled} onChange={() => savePatch({ extractorMode: value })} />
            <span className="settings-row-text"><strong>{title}</strong><p>{description}</p></span>
          </label>
        </div>)}
      </div>
      {!knownExtractor && <p className="memory-field-error" role="status">服务端返回了未识别的提取模式「{storedExtractor}」，请选择上方任一模式保存以覆盖。</p>}
      <p className="settings-section-note">LLM 提取使用当前聊天模型，只发送用户消息，不发送助手回复；密码、API 密钥等敏感内容会在发送和写入前过滤。LLM 不可用、超时、限流或返回非法结果时，这条记忆会标记为失败并提示，不会静默回退到规则提取。「自动提取记忆」总开关关闭时，任何模式都不写入。</p>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-quota`}>
      <div className="memory-heading"><h3 className="settings-section-title" id={`${uid}-quota`}>存储配额与服务状态</h3><button type="button" className="settings-button" disabled={!supported.stats || pending !== ''} onClick={() => operate('stats', async () => { setLoadError(''); await loadStats(); setNotice('存储统计已刷新。'); })}>{pending === 'stats' ? '刷新中…' : '刷新'}</button></div>
      {bridge && !supported.stats && <div className="memory-banner" role="status">当前桌面端尚未提供 memory:stats 接口，容量与队列数据不可用。</div>}
      {statsPhase === 'loading' && !stats && <p className="memory-muted" role="status">正在读取存储统计…</p>}
      {stats && <QuotaStats stats={stats} />}
      <form className="settings-row" onSubmit={event => {
        event.preventDefault();
        const gb = Number(quotaGb);
        if (!Number.isFinite(gb) || gb < 0 || gb > 1024) { setLoadError('配额必须是 0–1024 GB 的数值；0 表示不限制。'); return; }
        savePatch({ quotaBytes: Math.round(gb * GB) });
      }}>
        <div className="settings-row-text"><strong><label htmlFor={`${uid}-quota-gb`}>配额上限（GB）</label></strong><p>0 表示不限制。服务端会按数据库与附件总量检查；超过上限时写入返回配额错误。</p></div>
        <div className="memory-actions"><input id={`${uid}-quota-gb`} type="number" min="0" max="1024" step="0.1" value={quotaGb} disabled={settingDisabled} onChange={event => setQuotaGb(event.target.value)} className="memory-number" /><button type="submit" className="settings-button" disabled={settingDisabled}>保存配额</button></div>
      </form>
      <p className="settings-section-note">大小由服务端统计，可能包含索引与临时文件，与磁盘实际占用略有差异；配额上限保存后由服务端在写入前检查。</p>
    </section>
  </div>;
}

export default ServiceSettings;
