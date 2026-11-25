import React, { useEffect, useState } from 'react';
import { errorText } from './memory-bridge.js';
import { passphraseChangePayload } from './vault-payload.js';
import { confirmAction } from '../ui/confirm.js';

const KINDS = [
  ['password', '密码'],
  ['api-key', 'API Key'],
  ['token', 'Token'],
  ['note', '私密备注'],
];

function resultValue(result) {
  if (!result?.ok) throw new Error(errorText(result?.error));
  return result.value;
}

export function PrivacyVault({ bridge }) {
  const api = bridge?.vault;
  const [status, setStatus] = useState(null);
  const [entries, setEntries] = useState([]);
  const [passphrase, setPassphrase] = useState('');
  const [oldPassphrase, setOldPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    if (!api) return;
    try {
      const next = await api.status().then(resultValue);
      setStatus(next);
      setEntries(next?.unlocked ? await api.list().then(resultValue) : []);
    } catch (reason) { setError(errorText(reason)); }
  }

  useEffect(() => { void refresh(); }, [api]);

  async function run(operation, message) {
    if (!api || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await operation();
      if (message) setNotice(message);
      await refresh();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  if (!api) return null;

  const configured = status?.configured === true;
  const unlocked = status?.unlocked === true;

  return (
    <div className="settings-subsection" aria-labelledby="privacy-vault-title">
      <h4 className="memory-subtitle" id="privacy-vault-title">隐私保险库</h4>
      <p className="memory-muted">密码、API Key、Token 和私密备注使用 AES-256-GCM 加密后存入数据库；主密码只在本机内存中，不写入数据库、备份或日志。忘记主密码无法恢复。</p>
      {error && <div className="memory-error" role="alert">{error}</div>}
      {notice && <div className="memory-notice" role="status">{notice}</div>}

      {!configured ? <form className="settings-card memory-form" onSubmit={event => {
        event.preventDefault();
        void run(() => api.setup(passphrase).then(resultValue), '隐私保险库已创建并解锁。').then(() => setPassphrase(''));
      }}>
        <label htmlFor="vault-master">设置主密码（至少 8 位）</label>
        <input id="vault-master" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={8} autoComplete="new-password" required />
        <div className="memory-actions"><button className="settings-button primary" type="submit" disabled={busy || passphrase.length < 8}>创建保险库</button></div>
      </form> : !unlocked ? <form className="settings-card memory-form" onSubmit={event => {
        event.preventDefault();
        void run(() => api.unlock(passphrase).then(resultValue), '隐私保险库已解锁。').then(() => setPassphrase(''));
      }}>
        <label htmlFor="vault-unlock">主密码</label>
        <input id="vault-unlock" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="current-password" required />
        <div className="memory-actions"><button className="settings-button primary" type="submit" disabled={busy || !passphrase}>解锁</button></div>
      </form> : <>
        <div className="settings-card">
          <div className="settings-row"><div className="settings-row-text"><strong>保险库已解锁</strong><p>{entries.length} 条私密记录；列表只显示名称和末四位，不显示明文。</p></div><button type="button" className="settings-button" disabled={busy} onClick={() => void run(() => api.lock().then(resultValue), '已锁定。')}>锁定</button></div>
        </div>
        <form className="settings-card memory-form" onSubmit={event => {
          event.preventDefault();
          void run(() => api.put({ name, value, kind }).then(resultValue), '私密记录已保存。').then(() => { setName(''); setValue(''); });
        }}>
          <label htmlFor="vault-name">名称</label>
          <input id="vault-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="例如 openai_api_key" required />
          <label htmlFor="vault-value">内容</label>
          <textarea id="vault-value" value={value} onChange={event => setValue(event.target.value)} rows="3" maxLength={20000} autoComplete="off" required />
          <div className="memory-actions"><label className="memory-field-inline">类型<select className="settings-select" value={kind} onChange={event => setKind(event.target.value)}>{KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><button className="settings-button primary" type="submit" disabled={busy || !name.trim() || !value}>保存到保险库</button></div>
        </form>
        <div className="memory-list">{entries.map(entry => <article className="settings-card memory-entry" key={entry.name}>
          <div className="memory-heading"><span className="memory-muted">{KINDS.find(([id]) => id === entry.kind)?.[1] || entry.kind} · 末四位 {entry.preview || '****'}</span><span className="memory-muted">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''}</span></div>
          <p className="memory-content">{entry.name}</p>
          <div className="memory-actions"><button type="button" className="settings-button" disabled={busy} onClick={() => void run(async () => {
            const secret = await api.get(entry.name).then(resultValue);
            if (window.movaDesktop?.clipboard?.writeText) await window.movaDesktop.clipboard.writeText(secret);
            else await navigator.clipboard.writeText(secret);
          }, '已复制到剪贴板。')}>复制</button><button type="button" className="settings-button danger" disabled={busy} onClick={async () => { const confirmed = await confirmAction({ title: `删除保险库记录 ${entry.name}？`, body: '删除后无法恢复。保险库里的其它记录不受影响。', confirmLabel: '删除', tone: 'danger' }); if (confirmed) void run(() => api.remove(entry.name).then(resultValue), '已删除。'); }}>删除</button></div>
        </article>)}</div>
        <form className="settings-card memory-form" onSubmit={event => {
          event.preventDefault();
          void run(() => api.changePassphrase(passphraseChangePayload(oldPassphrase, newPassphrase)).then(resultValue), '主密码已更换。').then(() => { setOldPassphrase(''); setNewPassphrase(''); });
        }}>
          <label htmlFor="vault-old">更换主密码：当前主密码</label>
          <input id="vault-old" type="password" value={oldPassphrase} onChange={event => setOldPassphrase(event.target.value)} autoComplete="current-password" required />
          <label htmlFor="vault-new">新主密码（至少 8 位）</label>
          <input id="vault-new" type="password" value={newPassphrase} onChange={event => setNewPassphrase(event.target.value)} minLength={8} autoComplete="new-password" required />
          <div className="memory-actions"><button className="settings-button" type="submit" disabled={busy || !oldPassphrase || newPassphrase.length < 8}>更换主密码</button></div>
        </form>
      </>}
    </div>
  );
}
