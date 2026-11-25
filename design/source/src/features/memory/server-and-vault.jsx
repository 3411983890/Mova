import React, { useId, useState } from 'react';
import './server-vault.css';

/* 服务版设置 + 隐私保险库：父项目把这两块并进了「记忆与存储」页。
   原型使用演示状态，开关与按钮只改本地示例数据。 */

const HEALTH = [
  { id: 'db', label: '数据库', detail: 'PostgreSQL 16 · 本地容器', state: 'ok', value: '连接正常' },
  { id: 'index', label: '向量索引', detail: 'pgvector · text-embedding-3-small', state: 'ok', value: '已索引 12,480 条' },
  { id: 'worker', label: '后台任务', detail: '记忆提取与索引队列', state: 'warn', value: '排队 3 个' },
  { id: 'backup', label: '备份', detail: '每日增量 + 每周全量', state: 'ok', value: '今天 03:12 完成' },
];

const STATE_LABEL = { ok: '正常', warn: '需注意', error: '失败' };

function Switch({ checked, label, disabled, onChange }) {
  return (
    <button
      type="button"
      className="settings-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

export function ServicePanel() {
  const uid = useId();
  const [embedModel, setEmbedModel] = useState('text-embedding-3-small');
  const [autoBackup, setAutoBackup] = useState(true);
  const [retention, setRetention] = useState('30');
  const [quota, setQuota] = useState('5');
  const [rebuilding, setRebuilding] = useState(false);

  return (
    <section className="settings-section" aria-labelledby={`${uid}-service`}>
      <div className="settings-section-head">
        <h3 className="settings-section-title" id={`${uid}-service`}>服务版设置</h3>
        <p className="settings-section-note">桌面端可以把记忆与会话交给本地 PostgreSQL 服务；以下为当前连接与任务概况。</p>
      </div>
      <div className="settings-card">
        {HEALTH.map(item => (
          <div className="settings-row health-row" key={item.id}>
            <div className="settings-row-text">
              <span className={`health-dot is-${item.state}`} aria-hidden="true" />
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
            <span className="health-value">{item.value}</span>
          </div>
        ))}

        <div className="settings-row">
          <div className="settings-row-text">
            <strong>嵌入模型</strong>
            <p>更换嵌入模型后必须重建索引，否则新旧向量维度不一致，检索结果会失真。</p>
          </div>
          <div className="settings-row-control">
            <select className="settings-select" value={embedModel} aria-label="嵌入模型" onChange={event => setEmbedModel(event.target.value)}>
              <option value="text-embedding-3-small">text-embedding-3-small</option>
              <option value="bge-m3">bge-m3（本地）</option>
              <option value="nomic-embed">nomic-embed-text</option>
            </select>
            <button
              type="button"
              className="settings-button"
              disabled={rebuilding}
              onClick={() => { setRebuilding(true); setTimeout(() => setRebuilding(false), 1600); }}
            >
              {rebuilding ? '正在重建…' : '重建索引'}
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <strong>自动备份</strong>
            <p>每日增量、每周全量；备份写入本地服务数据目录，可整库恢复到指定时间点。</p>
          </div>
          <Switch checked={autoBackup} label="自动备份" onChange={() => setAutoBackup(!autoBackup)} />
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <strong>备份保留天数</strong>
            <p>超过保留期的备份会被自动清理；配额按未压缩大小计算。</p>
          </div>
          <div className="settings-row-control">
            <input
              className="settings-input settings-input-short"
              type="number"
              min="1"
              max="365"
              value={retention}
              aria-label="备份保留天数"
              onChange={event => setRetention(event.target.value)}
            />
            <span className="settings-section-note">天</span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-text">
            <strong>存储配额</strong>
            <p>达到上限后新的记忆写入与索引任务会暂停，已有数据不受影响。</p>
            <div className="quota-meter" role="meter" aria-label="存储配额已用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={63}>
              <span style={{ width: '63%' }} />
            </div>
            <p className="settings-section-note">已用 3.1 GB / 5 GB</p>
          </div>
          <div className="settings-row-control">
            <input
              className="settings-input settings-input-short"
              type="number"
              min="1"
              max="512"
              value={quota}
              aria-label="存储配额（GB）"
              onChange={event => setQuota(event.target.value)}
            />
            <span className="settings-section-note">GB</span>
          </div>
        </div>
      </div>
      <p className="settings-section-note server-footnote">服务版接口与迁移脚本见 <code>electron/store</code>；切换到服务版后，本机 JSON 仓库只作为只读备份。</p>
    </section>
  );
}

export function PrivacyVaultPanel() {
  const uid = useId();
  const [enabled, setEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [autoLock, setAutoLock] = useState(true);
  const [recovery, setRecovery] = useState('');
  const [message, setMessage] = useState('');

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;
  const canEnable = password.length >= 8 && password === confirm;

  function enable() {
    const code = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 6).toUpperCase()).join('-');
    setRecovery(code);
    setEnabled(true);
    setPassword('');
    setConfirm('');
    setMessage('保险库已启用。请把恢复码抄到离线位置，丢失后无法解密备份。');
  }

  function disable() {
    setEnabled(false);
    setRecovery('');
    setMessage('保险库已关闭，备份恢复为未加密状态。');
  }

  return (
    <section className="settings-section" aria-labelledby={`${uid}-vault`}>
      <h3 className="settings-section-title" id={`${uid}-vault`}>隐私保险库</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-text">
            <strong>保险库状态</strong>
            <p>启用后，导出的备份与会话快照会用你的主密码加密；主密码只保存在本机内存，不会上传。</p>
          </div>
          <span className={`vault-state ${enabled ? 'is-on' : ''}`}>{enabled ? '已启用' : '未启用'}</span>
        </div>

        {!enabled && (
          <>
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>设置主密码</strong>
                <p>至少 8 位；忘记后只能用恢复码重置，无法从备份反推。</p>
                {tooShort && <p className="vault-hint is-error">密码至少 8 位。</p>}
                {mismatch && <p className="vault-hint is-error">两次输入不一致。</p>}
              </div>
              <div className="settings-row-control vault-fields">
                <input
                  className="settings-input"
                  type="password"
                  placeholder="主密码"
                  aria-label="主密码"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                />
                <input
                  className="settings-input"
                  type="password"
                  placeholder="再次输入"
                  aria-label="再次输入主密码"
                  value={confirm}
                  onChange={event => setConfirm(event.target.value)}
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>启用保险库</strong>
                <p>启用时会生成一次性恢复码，请立即抄写保存。</p>
              </div>
              <button type="button" className="settings-button primary" disabled={!canEnable} onClick={enable}>启用保险库</button>
            </div>
          </>
        )}

        {enabled && (
          <>
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>恢复码</strong>
                <p>只显示一次。请离线保存；任何人都能用它重置主密码。</p>
                <code className="vault-recovery">{recovery}</code>
              </div>
              <button type="button" className="settings-button" onClick={() => setMessage('恢复码已复制到剪贴板（演示）。')}>复制</button>
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>闲置自动锁定</strong>
                <p>离开应用 10 分钟后需要重新输入主密码才能导出加密备份。</p>
              </div>
              <Switch checked={autoLock} label="闲置自动锁定" onChange={() => setAutoLock(!autoLock)} />
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>关闭保险库</strong>
                <p>关闭后已导出的加密备份仍然保留，但新备份不再加密。</p>
              </div>
              <button type="button" className="settings-button danger" onClick={disable}>关闭保险库</button>
            </div>
          </>
        )}
      </div>
      {message && <p className="vault-message" role="status">{message}</p>}
    </section>
  );
}
