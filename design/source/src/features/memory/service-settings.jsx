import React, { useEffect, useId, useMemo, useState } from 'react';
import { SettingsDialog } from './settings-dialog.jsx';
import { notify } from '../ui/toast.js';
import './service-settings.css';

/* 服务版（本机 PostgreSQL + Redis 队列 + MinIO + 本地 Embedding）的界面。
   浏览器预览没有桌面桥接，用示例数据填满页面，控件按「只读演示」处理。 */

const DEMO_HEALTH = {
  mode: 'postgres',
  database: 'ok',
  redis: 'ok',
  objectStorage: 'ok',
  embedding: 'ok',
  embeddingModel: 'Xenova/multilingual-e5-small',
  embeddingDim: 384,
  queueLag: 0,
  message: '',
};

const DEMO_STATS = {
  databaseBytes: 486_539_264,
  attachmentBytes: 71_303_168,
  queueWaiting: 0,
  queueFailed: 0,
  memories: 126,
  conversations: 38,
  events: 4_812,
  quotaBytes: 1024 ** 3,
  indexPath: 'C:\\Users\\示例\\AppData\\Roaming\\Mova\\models\\vector-index',
};

const DEMO_BACKUPS = [
  { id: 'bk-2026-11-10-0300', createdAt: '2026-11-10 03:00', kind: '每日', size: 412_336_128, status: 'completed' },
  { id: 'bk-2026-11-09-0300', createdAt: '2026-11-09 03:00', kind: '每日', size: 408_944_640, status: 'completed' },
  { id: 'bk-2026-11-08-1200', createdAt: '2026-11-08 12:04', kind: '手动', size: 405_012_480, status: 'failed', error: 'pg_dump 退出码 1：连接被重置' },
];

const STATUS_LABELS = {
  ok: '正常',
  loading: '加载中',
  migrating: '迁移中',
  down: '不可用',
  disabled: '未启用',
  unknown: '未检测',
  completed: '已完成',
  failed: '失败',
  running: '进行中',
};

const PLAN_OPTIONS = [
  { value: 'daily-03', label: '每日 03:00' },
  { value: 'daily-12', label: '每日 12:00' },
  { value: 'weekly-03', label: '每周一 03:00' },
];

const EXTRACT_MODES = [
  { value: 'rules', label: '规则提取', description: '只在命中明确句式时保存，例如「记住 X」；最省资源，也最容易漏。' },
  { value: 'llm', label: '低成本 LLM 提取', description: '按需调用模型判断偏好与决定；不可用时自动回退规则提取。' },
  { value: 'off', label: '关闭自动提取', description: '只保存手动添加的记忆；已有记忆仍会参与上下文注入。' },
];

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function pillTone(status) {
  if (status === 'ok' || status === 'completed') return 'ok';
  if (status === 'loading' || status === 'migrating' || status === 'running') return 'warn';
  if (status === 'down' || status === 'failed') return 'error';
  if (status === 'disabled') return 'muted';
  return 'unknown';
}

function Pill({ status, label }) {
  const tone = pillTone(status);
  return <span className="memory-pill" data-tone={tone}>{label ?? STATUS_LABELS[status] ?? status ?? '未检测'}</span>;
}

export function ServiceSettings({ bridge }) {
  const uid = useId();
  const demo = !bridge;
  const setNotice = message => { if (message) notify(message); };
  const [dialog, setDialog] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [plan, setPlan] = useState('daily-03');
  const [retention, setRetention] = useState('30');
  const [quota, setQuota] = useState('1');
  const [weight, setWeight] = useState(0.5);
  const [extractMode, setExtractMode] = useState('rules');
  const [semantic, setSemantic] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [backups, setBackups] = useState(DEMO_BACKUPS);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const health = DEMO_HEALTH;
  const stats = DEMO_STATS;
  const autoBackup = plan !== 'off';
  const quotaBytes = Math.max(0, Number(quota) || 0) * 1024 ** 3;
  const usedRatio = stats.quotaBytes > 0 ? Math.min(1, (stats.databaseBytes + stats.attachmentBytes) / stats.quotaBytes) : 0;
  const usedTone = usedRatio >= 0.9 ? 'error' : usedRatio >= 0.7 ? 'warn' : 'ok';
  const indexTone = health.embedding === 'ok' ? 'ok' : health.embedding === 'loading' ? 'warn' : 'error';
  const indexLabel = health.embedding === 'ok' ? '已建立' : health.embedding === 'loading' ? '模型加载中' : '尚未建立索引';

  const dependencies = useMemo(() => ([
    { key: 'database', title: '数据库 · PostgreSQL', description: '会话、记忆、搜索分块与备份记录的唯一权威来源。', status: health.database },
    { key: 'redis', title: '队列 · Redis', description: '索引、备份与会话同步任务；积压会延迟记忆生效。', status: health.redis },
    { key: 'objectStorage', title: '对象存储 · MinIO', description: '图片与附件的本地镜像；不可用时回退本地文件。', status: health.objectStorage },
    { key: 'embedding', title: '语义模型 · Embedding', description: `${health.embeddingModel} · ${health.embeddingDim} 维，本地 ONNX 推理。`, status: health.embedding },
  ]), [health]);

  const openDialog = (type, payload = {}) => { setConfirmText(''); setError(''); setDialog({ type, ...payload }); };
  const closeDialog = () => { setDialog(null); setConfirmText(''); };

  useEffect(() => {
    if (dialog?.type === 'restore') setConfirmText('');
  }, [dialog?.type]);

  function runBackup() {
    setBusy(true);
    setTimeout(() => {
      setBackups(current => [{
        id: `bk-${Date.now()}`,
        createdAt: '刚刚',
        kind: '手动',
        size: stats.databaseBytes,
        status: 'completed',
      }, ...current]);
      setBusy(false);
      setNotice('备份已完成，可在下方备份记录里查看。');
    }, 600);
  }

  function runReindex() {
    setReindexing(true);
    setNotice('已提交重建索引任务，进度可在服务端队列中查看。');
    setTimeout(() => setReindexing(false), 1200);
  }

  const restoreTarget = dialog?.type === 'restore' ? dialog.backup : null;

  return <div className="memory-settings service-settings">
    {demo && <div className="memory-banner" role="status">当前为浏览器预览：本机服务不在此环境运行，下面的健康状态、备份记录与统计是<strong>示例数据</strong>，写入类操作不会真正执行。</div>}
    {error && <div className="memory-error" role="alert"><span>{error}</span></div>}

    {/* S1 服务连接与健康状态 */}
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">服务连接与健康状态</h3>
        <p className="settings-section-note">四项依赖独立探测：某一项失败只影响对应能力，不阻塞其他功能；连接失败时页面回退为只读，不会把本地 JSON 当作可写权威。</p>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>运行模式</strong><p>本机 Docker 服务；仅监听 127.0.0.1，数据库密码不会显示在界面上。</p></div>
          <span className="memory-pill" data-tone="ok">PostgreSQL</span>
        </div>
        {dependencies.map(item => <div className="settings-row" key={item.key}>
          <div className="settings-row-text"><strong>{item.title}</strong><p>{item.description}</p></div>
          <Pill status={item.status} />
        </div>)}
        <div className="settings-row">
          <div className="settings-row-text"><strong>队列积压</strong><p>等待 {stats.queueWaiting} · 失败 {stats.queueFailed}；失败任务会指数退避重试三次。</p></div>
          <span className="memory-stat-value" data-tone={stats.queueFailed > 0 ? 'error' : undefined}>{health.queueLag}</span>
        </div>
        {health.message && <div className="settings-row"><div className="settings-row-text"><strong>服务端说明</strong><p className="memory-warn-text">{health.message}</p></div></div>}
        <div className="settings-row">
          <div className="settings-row-text"><strong>自动启动本机服务</strong><p>启动桌面版时自动唤起 Docker 服务并执行数据库迁移。</p></div>
          <button type="button" className="settings-switch" role="switch" aria-label="自动启动本机服务" aria-checked="true" disabled={demo}><span /></button>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>检测连接</strong><p>重新探测四项依赖与队列状态。</p></div>
          <button type="button" className="settings-button" onClick={() => setNotice('已重新检测服务状态。')}>检测连接</button>
        </div>
      </div>
    </section>

    {/* S2 自动备份与恢复 */}
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">自动备份与恢复</h3>
        <p className="settings-section-note">逻辑备份（数据库导出）用于整库恢复；WAL 归档与时间点恢复走命令行 <code>scripts/pitr.mjs</code>，设置页不提供时间点选择，也不会覆盖当前库。</p>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>自动备份</strong><p>按计划在后台执行逻辑备份，失败不会删除旧备份。</p></div>
          <button type="button" className="settings-switch" role="switch" aria-label="自动备份" aria-checked={autoBackup}
            onClick={() => setPlan(autoBackup ? 'off' : 'daily-03')}><span /></button>
        </div>
        {autoBackup && <div className="settings-row">
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-plan`}>备份计划</label></strong><p>每日或每周固定时间执行；同一时间点只保留一个计划。</p></div>
          <select id={`${uid}-plan`} className="settings-select" value={plan} onChange={event => setPlan(event.target.value)}>
            {PLAN_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>}
        <div className="settings-row">
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-retention`}>保留天数</label></strong><p>超过天数的备份会被清理；最近一次成功备份始终保留。</p></div>
          <div className="memory-actions">
            <input id={`${uid}-retention`} className="memory-number" type="number" min="1" max="365" step="1" value={retention} onChange={event => setRetention(event.target.value)} />
            <button type="button" className="settings-button" onClick={() => setNotice(`备份保留天数已保存：${retention} 天。`)}>保存</button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>上次备份</strong><p>{backups[0]?.createdAt ?? '尚无'} · {backups[0]?.kind ?? '—'} · {formatBytes(backups[0]?.size ?? 0)}</p></div>
          <div className="memory-actions">
            <Pill status={backups[0]?.status ?? 'unknown'} />
            <button type="button" className="settings-button primary" disabled={busy} onClick={runBackup}>{busy ? '备份中…' : '备份现在'}</button>
          </div>
        </div>
      </div>

      <div className="settings-section-head">
        <h3 className="settings-section-title">备份记录</h3>
        <p className="settings-section-note">只列出已完成或失败的备份；恢复前会停止生成并确认，失败时保留当前数据。</p>
      </div>
      {backups.length === 0
        ? <div className="memory-empty"><p>服务端还没有备份记录。</p></div>
        : <div className="settings-card memory-list">{backups.map(backup => <div className="memory-item" key={backup.id}>
          <div className="memory-item-main">
            <span className="memory-item-title">{backup.createdAt} · {backup.kind}备份</span>
            <span className="memory-item-meta">
              <Pill status={backup.status} />
              <span>{formatBytes(backup.size)}</span>
              {backup.error && <span className="memory-warn-text">{backup.error}</span>}
            </span>
          </div>
          <div className="memory-item-actions">
            <button type="button" className="settings-button" disabled={backup.status !== 'completed'} onClick={() => openDialog('restore', { backup })}>恢复</button>
          </div>
        </div>)}</div>}
    </section>

    {/* S3 Embedding 与索引 */}
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">Embedding 与索引</h3>
        <p className="settings-section-note">索引只覆盖记忆与消息正文，不含思考、工具输出、临时会话与疑似凭据内容。更换模型后必须重建索引，否则向量维度不一致。</p>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>语义模型</strong><p>{health.embeddingModel} · {health.embeddingDim} 维 · 本地 ONNX，不依赖 Python 或 Ollama。</p></div>
          <Pill status={health.embedding} />
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>索引状态</strong><p>{indexLabel}；重建在后台执行，失败原因会显示在下方。</p></div>
          <Pill status={indexTone} label={indexLabel} />
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>索引位置</strong><p>由服务端报告，路径不含数据库密码。</p><code className="memory-path">{stats.indexPath}</code></div>
          <span className="settings-section-note">本机</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>重建索引</strong><p>清空并重建全部搜索分块；期间语义检索自动回退关键词。</p></div>
          <button type="button" className="settings-button" disabled={reindexing} onClick={() => openDialog('reindex')}>{reindexing ? '提交中…' : '重建索引'}</button>
        </div>
      </div>
    </section>

    {/* S4 语义检索与混合权重 */}
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">语义检索与混合权重</h3>
        <p className="settings-section-note">关键词与向量两路结果按加权排名融合（RRF）。权重只影响排序，不改变可检索范围；语义关闭或模型不可用时自动回退关键词。</p>
      </div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text"><strong>启用语义检索</strong><p>关闭后只用关键词检索，历史搜索与自动上下文都不使用向量。</p></div>
          <button type="button" className="settings-switch" role="switch" aria-label="启用语义检索" aria-checked={semantic} disabled={!semantic && health.embedding !== 'ok'} onClick={() => setSemantic(value => !value)}><span /></button>
        </div>
        <div className="settings-weight">
          <div className="settings-weight-head">
            <strong>混合权重</strong>
            <span className="memory-weight-value">关键词 {(1 - weight).toFixed(2)} / 语义 {weight.toFixed(2)}</span>
          </div>
          <input className="memory-range" type="range" min="0" max="1" step="0.05" value={weight} aria-label="混合检索权重"
            onChange={event => setWeight(Number(event.target.value))} disabled={!semantic} />
          <div className="settings-weight-foot">
            <span>偏关键词</span>
            <button type="button" className="memory-link" onClick={() => setWeight(0.5)}>恢复均衡</button>
            <span>偏语义</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-text"><strong>通道状态</strong><p>{semantic ? '两路通道均可用。' : '语义检索已关闭，仅关键词通道生效。'}</p></div>
          <Pill status={semantic ? health.embedding : 'disabled'} label={semantic ? '两路可用' : '仅关键词'} />
        </div>
      </div>
    </section>

    {/* S5 记忆提取模式 */}
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">记忆提取模式</h3>
        <p className="settings-section-note">无论哪种模式，密码、密钥与令牌都会在写入前过滤；LLM 不可用时自动回退规则提取，不会写入伪造结果。总开关关闭时任何模式都不写入。</p>
      </div>
      <div className="settings-card" role="radiogroup" aria-label="记忆提取模式">
        {EXTRACT_MODES.map(mode => <button type="button" key={mode.value} className="settings-choice" role="radio" aria-checked={extractMode === mode.value}
          onClick={() => setExtractMode(mode.value)}>
          <span className="settings-choice-dot" data-checked={extractMode === mode.value} aria-hidden="true" />
          <span className="settings-choice-text"><strong>{mode.label}</strong><span>{mode.description}</span></span>
        </button>)}
      </div>
    </section>

    {/* S6 存储配额与服务状态 */}
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-section-title">存储配额与服务状态</h3>
        <p className="settings-section-note">大小由服务端统计，包含索引与临时文件，与磁盘实际占用略有差异；配额在写入前检查，0 表示不限制。</p>
      </div>
      <div className="settings-card">
        <dl className="memory-stats">
          <div><dt>数据库</dt><dd>{formatBytes(stats.databaseBytes)}</dd></div>
          <div><dt>附件与对象存储</dt><dd>{formatBytes(stats.attachmentBytes)}</dd></div>
          <div><dt>记忆</dt><dd>{stats.memories}</dd></div>
          <div><dt>会话</dt><dd>{stats.conversations}</dd></div>
          <div><dt>会话事件</dt><dd>{stats.events}</dd></div>
          <div><dt>队列</dt><dd>等待 {stats.queueWaiting} · 失败 {stats.queueFailed}</dd></div>
        </dl>
        {stats.quotaBytes > 0 && <div className="memory-quota">
          <div className="memory-quota-head">
            <span>已用 {formatBytes(stats.databaseBytes + stats.attachmentBytes)} / {formatBytes(stats.quotaBytes)}</span>
            <span data-tone={usedTone}>{Math.round(usedRatio * 100)}%</span>
          </div>
          <div className="memory-quota-bar" data-tone={usedTone}><span style={{ width: `${Math.max(2, usedRatio * 100)}%` }} /></div>
        </div>}
        <div className="settings-row">
          <div className="settings-row-text"><strong><label htmlFor={`${uid}-quota`}>配额上限（GB）</label></strong><p>0 表示不限制；超过上限后数据库与附件写入会被拒绝。</p></div>
          <div className="memory-actions">
            <input id={`${uid}-quota`} className="memory-number" type="number" min="0" max="1024" step="0.1" value={quota} onChange={event => setQuota(event.target.value)} />
            <button type="button" className="settings-button" onClick={() => setNotice(`配额上限已保存：${Number(quota) === 0 ? '不限制' : `${quota} GB`}。`)}>保存</button>
          </div>
        </div>
      </div>
      <p className="memory-muted">服务版只显示服务端实际报告的数据：未接入的接口显示「未检测」，不会显示成已连接。</p>
    </section>

    {/* 恢复备份 */}
    <SettingsDialog open={dialog?.type === 'restore'} onClose={closeDialog} title="恢复到这个备份？"
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>取消</button>
        <button type="button" className="settings-button danger-solid" disabled={confirmText !== '恢复'}
          onClick={() => { closeDialog(); setNotice(`已开始恢复 ${restoreTarget?.createdAt ?? ''} 的备份，期间请勿关闭应用。`); }}>确认恢复</button>
      </>}>
      <p>恢复会覆盖当前数据库中的会话与记忆，请先停止生成并关闭其他写入；失败时会保留现有数据。仅可选择状态为「已完成」的备份。</p>
      <p className="memory-detail-text">{restoreTarget ? `${restoreTarget.createdAt} · ${restoreTarget.kind}备份 · ${formatBytes(restoreTarget.size)}` : ''}</p>
      <label className="memory-confirm-field" htmlFor={`${uid}-restore`}>
        <span>输入 <strong className="memory-confirm-word">恢复</strong> 以确认</span>
        <input id={`${uid}-restore`} value={confirmText} autoComplete="off" onChange={event => setConfirmText(event.target.value)} />
      </label>
    </SettingsDialog>

    {/* 重建索引 */}
    <SettingsDialog open={dialog?.type === 'reindex'} onClose={closeDialog} title="重建全部索引？"
      footer={<>
        <button type="button" className="settings-button" onClick={closeDialog}>取消</button>
        <button type="button" className="settings-button" onClick={() => { closeDialog(); runReindex(); }}>重建索引</button>
      </>}>
      <p>将清空全部搜索分块并按当前模型重新生成向量，期间语义检索自动回退关键词；关键词语义不受影响，不会删除记忆与消息。</p>
    </SettingsDialog>
  </div>;
}

export default ServiceSettings;
