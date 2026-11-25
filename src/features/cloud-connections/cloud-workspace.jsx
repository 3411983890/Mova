/**
 * 负责：管理已配对设备，显示共享任务与会话，并提交新的云端任务。
 * 不负责：保存设备凭证、传输 VPN 明文或执行后台任务。
 * 被谁调用：cloud-connections-settings.jsx。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { confirmAction } from '../ui/confirm.js';
import { notify } from '../ui/toast.js';
import { CLOUD_PROVIDERS, cloudProviderLabel, cloudTaskError } from './workspace-location.mjs';

const PROGRESS = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消', blocked: '等待处理' };

export function CloudDevices({ device, host, call, copy, onForget, onPreferences }) {
  const [code, setCode] = useState(null);
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState([]);
  const [vpn, setVpn] = useState(null);
  const [syncError, setSyncError] = useState('');
  async function run(action) {
    setBusy(true); setError('');
    try { await action(); } catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  async function checkSubscriptions() {
    setSyncError('');
    if (host?.autoVpn) await call('vpn-refresh').catch(error => setSyncError(error.message));
    const results = await Promise.all([
      call('vpn-status').catch(error => ({ error: error.message })),
      ...['codex', 'gemini'].map(provider => call('model-status', { provider }).catch(error => ({ provider, message: error.message }))),
    ]);
    setVpn(results[0]);
    setModels(results.slice(1));
  }
  return <>
    <div className="settings-row">
      <div className="settings-row-text"><strong>配对 iPhone</strong><p>{code ? '在手机填写同一服务地址及 5 分钟内有效的配对码。' : '生成一次性配对码，把 iPhone 加到这个工作区。'}</p></div>
      <div className="cloud-row-controls">
        {code && <button type="button" className="settings-button" onClick={() => copy(code.code, '已复制手机配对码')}>复制配对码</button>}
        <button type="button" className="settings-button" disabled={busy || device.role !== 'owner'} onClick={() => run(async () => setCode(await call('invite')))}>生成配对码</button>
      </div>
    </div>
    <div className="settings-row">
      <div className="settings-row-text"><strong>已配对设备</strong><p>撤销后，设备无法再访问云端数据。</p></div>
      <div className="cloud-row-controls">
        <button type="button" className="settings-button" disabled={busy || device.role !== 'owner'} onClick={() => run(async () => setDevices(await call('devices')))}>查看设备</button>
        <button type="button" className="settings-button danger" disabled={busy} onClick={() => run(onForget)}>断开本机</button>
      </div>
    </div>
    {devices?.map(row => <div className="settings-row" key={row.id}>
      <div className="settings-row-text"><strong>{row.name}</strong><p>{row.id === device.id ? '此设备' : row.role === 'owner' ? '管理员' : '已配对设备'}</p></div>
      {row.id !== device.id && <button type="button" className="settings-button danger" disabled={busy} onClick={() => run(async () => {
        if (!await confirmAction({ title: '撤销设备', body: `撤销 ${row.name} 对此工作区的访问。`, confirmLabel: '撤销', tone: 'danger' })) return;
        await call('revoke', { id: row.id }); setDevices(await call('devices'));
      })}>撤销</button>}
    </div>)}
    <div className="settings-row">
      <div className="settings-row-text"><strong>同步模型 VPN 线路</strong><p>同步 Windows 为 GPT 和 Gemini 选定的代理。节点凭据仅发送到此配对服务。</p>
        {vpn && <p role="status">{vpn.running ? 'Linux 线路已启动' : vpn.error || 'Linux 线路尚未启动'}</p>}
        {syncError && <p role="alert">自动同步失败 · {syncError}</p>}
      </div>
      <button type="button" className="settings-button" disabled={busy || device.role !== 'owner'} onClick={() => run(async () => {
        if (!await confirmAction({ title: '同步 VPN 线路', body: '将选定线路和必要的节点凭据发送到当前配对的 Linux 服务。', confirmLabel: '同步线路' })) return;
        const result = await call('vpn'); setVpn(result); setSyncError(''); notify(`已同步线路 · ${result.revision}`, { tone: 'ok' });
      })}>同步线路</button>
    </div>
    <div className="settings-row">
      <div className="settings-row-text"><strong>自动同步线路</strong><p>提交订阅任务或检查订阅时，同步 Windows 上有变化的线路。</p></div>
      <button type="button" role="switch" aria-checked={Boolean(host?.autoVpn)} aria-label="自动同步线路" className="settings-button"
        disabled={busy || device.role !== 'owner'} onClick={() => run(async () => {
          const enable = !host?.autoVpn;
          if (enable && !await confirmAction({ title: '开启自动同步', body: '允许将当前和以后选中的线路及必要节点凭据同步到这台已配对主机。', confirmLabel: '开启' })) return;
          await call('preferences', { autoVpn: enable });
          await onPreferences();
          if (enable) setVpn(await call('vpn-status'));
        })}>{host?.autoVpn ? '已开启' : '已关闭'}</button>
    </div>
    <div className="settings-row">
      <div className="settings-row-text"><strong>项目与 Bot 默认云端模型</strong><p>使用选择此主机的项目或群聊发任务时生效。</p></div>
      <select className="settings-select" aria-label="默认云端模型" disabled={busy} value={host?.provider || 'codex'}
        onChange={event => { const provider = event.target.value; void run(async () => { await call('preferences', { provider }); await onPreferences(); }); }}>
        {Object.entries(CLOUD_PROVIDERS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </div>
    <div className="settings-row">
      <div className="settings-row-text"><strong>Linux 订阅授权</strong><p>同步线路后，在运行 Mova 服务的 Linux 用户终端执行登录命令。按终端提示在浏览器授权，再回来检查。Windows 登录会话保存在本机。</p>
        {host?.origin === 'http://127.0.0.1:17642' && <p>本机验证可在 PowerShell 输入 <code>wsl -d Ubuntu-24.04 -u mova</code> 打开 Linux。</p>}
      </div>
      <button type="button" className="settings-button" disabled={busy || device.role !== 'owner'} onClick={() => run(checkSubscriptions)}>检查订阅</button>
    </div>
    {['codex', 'gemini'].map(provider => {
      const status = models.find(row => row.provider === provider);
      const command = `mova model login ${provider}`;
      return <div className="settings-row" key={provider}>
        <div className="settings-row-text">
          <strong>{CLOUD_PROVIDERS[provider]} · {status?.authorized === true ? '已授权' : status?.authorized === false ? '未授权' : status ? '检查失败' : '待检查'}</strong>
          {status?.authorized === true ? <p>{status.models.length} 个模型 · {status.usage ? '已读取额度' : '额度未知'}</p> :
            <><p><code>{command}</code></p>
              <p>{provider === 'codex' ? '打开终端显示的网址，在浏览器填入设备码并用 ChatGPT 账号授权。' :
                '在终端选择 Google 登录，打开授权链接，按提示把浏览器返回的验证码填回终端。'}</p>
              {status?.authorized !== false && status?.message && <p>{status.message}</p>}</>}
        </div>
        {status?.authorized !== true && <button type="button" className="settings-button" onClick={() => copy(command, '已复制登录命令')}>复制命令</button>}
      </div>;
    })}
    {error && <div className="settings-row"><p className="model-form-status" data-tone="error" role="alert">{error}</p></div>}
  </>;
}

export function CloudWorkspace({ call, defaultProvider }) {
  const [snapshot, setSnapshot] = useState(null);
  const [providerOverride, setProvider] = useState(null);
  const provider = providerOverride ?? defaultProvider ?? 'research';
  const [model, setModel] = useState('');
  const [research, setResearch] = useState(false);
  const [conversationId, setConversation] = useState('');
  const [botId, setBot] = useState('mova');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);
  const cursor = useRef();
  const receipt = useRef(null);
  const retryReceipts = useRef(new Map());
  const refresh = useCallback(async () => {
    const next = await call('snapshot', { after: cursor.current });
    if (!next.unchanged && (cursor.current === undefined || next.cursor >= cursor.current)) {
      cursor.current = next.cursor;
      setSnapshot(next);
    }
  }, [call]);
  useEffect(() => {
    let stopped = false;
    let polling = false;
    const tick = async () => {
      if (polling || stopped || document.hidden || panel.current?.closest('[hidden]')) return;
      polling = true;
      try { await refresh(); if (!stopped) setConnectionError(''); }
      catch (error) { if (!stopped) setConnectionError(error.message); }
      finally { polling = false; }
    };
    void tick();
    const timer = setInterval(tick, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [refresh]);
  async function run(action) {
    setBusy(true); setError('');
    try { await action(); await refresh(); } catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  async function retryWithSelectedProvider(task) {
    const key = `${task.id}:${provider}`;
    const replacementId = retryReceipts.current.get(key) || globalThis.crypto.randomUUID();
    retryReceipts.current.set(key, replacementId);
    await call('retry', { id: task.id, provider, replacementId });
    retryReceipts.current.delete(key);
  }
  const tasks = snapshot?.tasks.filter(task => !conversationId || task.conversationId === conversationId).slice(0, 12);
  return <section ref={panel} className="settings-section" aria-label="云端工作区">
    <h3 className="settings-section-title">云端工作区</h3>
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text"><strong>Bot、对话和任务</strong><p>{snapshot ? `${snapshot.bots.length} 个 Bot · ${snapshot.conversations.length} 个近期会话` : '正在读取云端记录…'}</p></div>
        <button type="button" className="settings-button" disabled={busy} onClick={() => run(async () => {})}>刷新</button>
      </div>
      <form className="model-form cloud-expanded" onSubmit={event => { event.preventDefault(); void run(async () => {
        const input = { provider, model: provider === 'research' ? undefined : model, research, prompt, botId, conversationId: conversationId || undefined };
        const signature = JSON.stringify(input);
        if (receipt.current?.signature !== signature) receipt.current = { signature, id: globalThis.crypto.randomUUID() };
        const task = await call('submit', { ...input, id: receipt.current.id });
        receipt.current = null;
        setPrompt(''); setConversation(task.conversationId);
      }); }}>
        <div className="model-form-grid">
          <label className="model-field"><span>会话</span><select className="settings-select" value={conversationId} onChange={event => setConversation(event.target.value)}>
            <option value="">新建会话</option>{snapshot?.conversations.map(row => <option value={row.id} key={row.id}>{row.title}</option>)}
          </select></label>
          <label className="model-field"><span>模型或搜索</span><select className="settings-select" value={provider} onChange={event => { setProvider(event.target.value); setModel(''); }}>
            <option value="research">联网研究</option><option value="codex">GPT 订阅</option><option value="gemini">Gemini 订阅</option><option value="api">API 模型</option>
          </select></label>
          {provider !== 'research' && <label className="model-field"><span>模型标识（可选）</span><input value={model} onChange={event => setModel(event.target.value)} maxLength={200} /></label>}
          {provider !== 'research' && <label><input type="checkbox" checked={research} onChange={event => setResearch(event.target.checked)} /> 先联网检索</label>}
          {!conversationId && <label className="model-field"><span>Bot</span><select className="settings-select" value={botId} onChange={event => setBot(event.target.value)}>
            {(snapshot?.bots || [{ id: 'mova', name: 'Mova' }]).map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
          </select></label>}
          <label className="model-field"><span>从本地导入 Bot 档案</span><input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (file) void run(async () => {
              if (file.size > 256 * 1024) throw new Error('Bot 档案过大');
              const payload = JSON.parse(await file.text());
              const bot = payload.bot || payload;
              await call('import', { name: bot.name, instructions: bot.instructions || [bot.personaConfig?.instructions, bot.personaConfig?.prompt, bot.description].filter(Boolean).join('\n') });
            });
          }} /></label>
        </div>
        <label className="model-field"><span>任务内容</span><input value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={12000} placeholder="例如：查找 Ubuntu 官方发行说明" /></label>
        <div className="model-form-actions"><button type="submit" className="settings-button primary" disabled={busy || !prompt.trim()}>提交任务</button></div>
      </form>
      {tasks?.map(task => <div className="settings-row" key={task.id}>
        <div className="settings-row-text"><strong>{[PROGRESS[task.status] || task.status, cloudProviderLabel(task.provider)].filter(Boolean).join(' · ')}</strong><p>{task.prompt}</p>
          {task.error && <p>{cloudTaskError(task.provider, task.error)}</p>}{task.result && <details className="cloud-task-result"><summary>查看结果</summary><pre>{task.result}</pre></details>}
        </div>
        {['queued', 'running'].includes(task.status) && <button type="button" className="settings-button" disabled={busy} onClick={() => run(() => call('cancel', { id: task.id }))}>取消</button>}
        {['blocked', 'failed', 'cancelled'].includes(task.status) && <div className="cloud-row-controls">
          {task.provider !== provider && <button type="button" className="settings-button" disabled={busy} onClick={() => run(() => retryWithSelectedProvider(task))}>改用{cloudProviderLabel(provider)}重试</button>}
          <button type="button" className="settings-button" disabled={busy} onClick={() => run(() => call('retry', { id: task.id }))}>原模型重试</button>
        </div>}
      </div>)}
    </div>
    {(error || connectionError) && <p className="model-form-status" data-tone="error" role="alert">{error || connectionError}</p>}
  </section>;
}
