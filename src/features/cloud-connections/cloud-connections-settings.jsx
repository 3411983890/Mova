/**
 * 负责：显示云端服务器、部署向导、连接检测和跨端能力状态。
 * 不负责：读取密钥、建立认证会话或生成设备配对码。
 * 被谁调用：app.js 的设置页挂载。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LOCAL_MOVA_ORIGIN, parseCloudOrigin } from '../../services/cloud-connection.mjs';
import { confirmAction } from '../ui/confirm.js';
import { notify } from '../ui/toast.js';
import { DEPLOYMENT_PROMPT, LOCAL_START_COMMAND } from './deployment-guide.mjs';
import { CloudDevices, CloudWorkspace } from './cloud-workspace.jsx';
import { CLOUD_ORIGIN_STORAGE_KEY as STORAGE_KEY, desktopCloudCall } from './workspace-location.mjs';
import './cloud-connections.css';

function readOrigin() {
  try { return parseCloudOrigin(localStorage.getItem(STORAGE_KEY)); } catch { return ''; }
}

function SettingsRow({ title, description, children }) {
  return <div className="settings-row">
    <div className="settings-row-text"><strong>{title}</strong><p>{description}</p></div>
    <div className="cloud-row-controls">{children}</div>
  </div>;
}

function DeploymentSettings({ onUseLocal, copy, busy }) {
  const [expanded, setExpanded] = useState(false);
  const guideId = useId();
  return <section className="settings-section" aria-label="部署到 Linux">
    <h3 className="settings-section-title">部署到 Linux</h3>
    <div className="settings-card">
      <SettingsRow title="AI 协助部署" description="把部署提示词交给能访问你云电脑的 AI，完成后将服务地址填回这里。">
        <button type="button" className="settings-button" aria-expanded={expanded} aria-controls={guideId} onClick={() => setExpanded(!expanded)}>{expanded ? '收起引导' : '查看引导'}</button>
      </SettingsRow>
      <div id={guideId} className="model-form cloud-expanded" hidden={!expanded}>
        <ol className="cloud-guide-steps">
          <li>复制部署提示词，交给有权访问目标 Linux 的 AI。</li>
          <li>让它安装 Mova CLI 和浏览器，并给出检测通过的服务地址。</li>
          <li>回到本页添加服务器。模型账号和设备配对分别验证。</li>
        </ol>
        <div className="model-form-actions">
          <button type="button" className="settings-button" onClick={() => copy(DEPLOYMENT_PROMPT, '已复制部署提示词')}>复制部署提示词</button>
        </div>
      </div>
      <SettingsRow title="本机 Linux" description="适合 WSL2 开发环境。先启动 Mova 服务，再在桌面检测。">
        <button type="button" className="settings-button" onClick={() => copy(LOCAL_START_COMMAND, '已复制 Linux 启动命令')}>复制命令</button>
        <button type="button" className="settings-button" disabled={busy} onClick={onUseLocal}>使用本机</button>
      </SettingsRow>
    </div>
  </section>;
}

export function CloudConnectionsSettings({ bridge, clipboard, onOpenNetwork, onAddHost }) {
  const [origin, setOrigin] = useState(readOrigin);
  const [draft, setDraft] = useState(null);
  const [check, setCheck] = useState(null);
  const [device, setDevice] = useState(null);
  const [hosts, setHosts] = useState([]);
  const [pairCode, setPairCode] = useState('');
  const [pairError, setPairError] = useState('');
  const [formError, setFormError] = useState('');
  const input = useRef(null);
  const editorTrigger = useRef(null);
  const editorOpen = draft !== null;
  const busy = check?.state === 'checking';
  const editorId = useId();

  useEffect(() => { if (editorOpen) input.current?.focus(); }, [editorOpen]);
  const call = useCallback((action, input) => desktopCloudCall(bridge, action, origin, input), [bridge, origin]);
  const refreshHosts = useCallback(() => {
    if (bridge?.device) return desktopCloudCall(bridge, 'hosts').then(setHosts).catch(() => {});
  }, [bridge]);

  useEffect(() => {
    void refreshHosts();
    const added = event => {
      void refreshHosts();
      if (!origin && event.detail?.origin) setOrigin(event.detail.origin);
    };
    document.addEventListener('mova-cloud-hosts-change', added);
    return () => document.removeEventListener('mova-cloud-hosts-change', added);
  }, [refreshHosts, origin]);

  useEffect(() => {
    if (!origin || !bridge?.device) return;
    let active = true;
    void call('session').then(value => { if (active) setDevice(value); }).catch(error => { if (active) setPairError(error.message); });
    return () => { active = false; };
  }, [origin, bridge, call]);

  function openEditor(value, trigger) {
    editorTrigger.current = trigger;
    setFormError('');
    setDraft(value);
  }

  function closeEditor() {
    setDraft(null);
    editorTrigger.current?.focus({ preventScroll: true });
  }

  async function testOrigin(address) {
    if (!bridge) return;
    setCheck({ state: 'checking' });
    try {
      const result = await bridge.probe(address);
      setCheck(result.ok
        ? { state: 'healthy', message: `Mova 服务可访问 · 协议 ${result.protocolVersion} · 待配对` }
        : { state: 'error', message: result.message });
    } catch {
      setCheck({ state: 'error', message: '检测失败，请重试。' });
    }
  }

  function saveOrigin(event) {
    event.preventDefault();
    try {
      const address = parseCloudOrigin(draft);
      selectOrigin(address);
      closeEditor();
      void testOrigin(address);
    } catch (error) {
      setFormError(error.message);
      input.current?.focus();
    }
  }

  function selectOrigin(address) {
    localStorage.setItem(STORAGE_KEY, address);
    if (address !== origin) { setDevice(null); setPairError(''); }
    setOrigin(address);
    setCheck(null);
  }

  async function removeOrigin() {
    const allowed = await confirmAction({
      title: '移除服务器', body: '移除本机保存的服务器地址。云端服务将继续运行。', confirmLabel: '移除', tone: 'danger',
    });
    if (!allowed) return;
    try { if (bridge?.device) await call('forget'); localStorage.removeItem(STORAGE_KEY); }
    catch (error) { setFormError(error.message); return; }
    setOrigin('');
    setDevice(null);
    await refreshHosts();
    setCheck(null);
    closeEditor();
    notify('已移除服务器地址', { tone: 'ok' });
  }

  async function pair(event) {
    event.preventDefault();
    setPairError('');
    try { setDevice(await call('pair', { code: pairCode })); setPairCode(''); await refreshHosts(); }
    catch (error) { setPairError(error.message); }
  }

  async function copy(value, message) {
    try {
      if (clipboard) {
        if (!await clipboard.writeText(value)) throw new Error('clipboard');
      } else await navigator.clipboard.writeText(value);
      notify(message, { tone: 'ok' });
    } catch { notify('无法访问剪贴板，请从桌面版重试。', { tone: 'error' }); }
  }

  const checkLabel = check?.state === 'checking' ? '正在检测…' : check?.state === 'error' ? check.message
    : device ? '桌面设备已配对' : check?.message || (origin ? '地址已保存，等待检测' : '');
  return <div className="cloud-connections-settings">
    <section className="settings-section" aria-label="云端服务器">
      <h3 className="settings-section-title">云端服务器</h3>
      <div className="settings-card">
        <SettingsRow title={origin ? 'Linux 服务器' : '连接 Linux 服务器'} description={origin || '添加运行 Mova CLI 的云电脑或本机 Linux。'}>
          {bridge?.device && onAddHost && <button className="settings-button" type="button" onClick={event => onAddHost(host => {
            if (host.origin === origin) void call('session').then(setDevice).catch(error => setPairError(error.message));
            selectOrigin(host.origin);
          }, event.currentTarget)}>添加远程主机</button>}
          {origin && <button type="button" className="settings-button" disabled={!bridge || busy || editorOpen} onClick={() => testOrigin(origin)}>检测连接</button>}
          <button type="button" className={`settings-button${!origin && !editorOpen ? ' primary' : ''}`} aria-expanded={editorOpen} aria-controls={editorId} disabled={busy}
            onClick={event => editorOpen ? closeEditor() : openEditor(origin, event.currentTarget)}>{editorOpen ? '收起' : origin ? '管理' : '添加服务器'}</button>
        </SettingsRow>
        {hosts.length > 0 && <SettingsRow title="已配对的远程主机">
          <select className="settings-select" aria-label="已配对的远程主机" value={origin} onChange={event => selectOrigin(event.target.value)}>
            {!hosts.some(host => host.origin === origin) && <option value={origin}>{origin ? '当前未配对' : '选择主机'}</option>}
            {hosts.map(host => <option key={host.origin} value={host.origin}>{host.label}</option>)}
          </select>
        </SettingsRow>}
        <form id={editorId} className="model-form cloud-expanded" hidden={!editorOpen} onSubmit={saveOrigin}>
          <label className="model-field"><span>Mova 服务地址</span>
            <input ref={input} value={draft ?? ''} type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://mova.example.com" required maxLength={2048} aria-invalid={Boolean(formError)} onChange={event => { setDraft(event.target.value); setFormError(''); }} />
          </label>
          <p className="settings-section-note">远端使用 HTTPS。本机 WSL 或 SSH 转发可使用回环地址。</p>
          <div className="model-form-actions">
            <button type="submit" className="settings-button primary">{bridge ? '保存并检测' : '保存地址'}</button>
            <button type="button" className="settings-button" onClick={closeEditor}>取消</button>
            {origin && <button type="button" className="settings-button danger cloud-remove" onClick={removeOrigin}>移除地址</button>}
          </div>
          {formError && <p className="model-form-status" data-tone="error" role="alert">{formError}</p>}
        </form>
      </div>
      {checkLabel && <div className="cloud-check-line">
        <p className="model-form-status" role="status" data-tone={check?.state === 'error' ? 'error' : check?.state === 'healthy' ? 'ok' : undefined}>{checkLabel}</p>
        {check?.state === 'error' && <button type="button" className="settings-button" onClick={() => copy(`Mova 连接检测\n地址 ${origin}\n${check.message}`, '已复制连接诊断')}>复制诊断</button>}
      </div>}
      {!bridge && <p className="settings-section-note">连接检测在桌面版提供。</p>}
    </section>

    <DeploymentSettings onUseLocal={event => openEditor(LOCAL_MOVA_ORIGIN, event.currentTarget)} copy={copy} busy={busy} />

    {origin && bridge?.device && !device && <section className="settings-section" aria-label="配对桌面">
      <h3 className="settings-section-title">配对桌面</h3>
      <form className="settings-card model-form" onSubmit={pair}>
        <p className="settings-section-note">在 Linux 运行 <code>mova pair code</code>，把一次性配对码填到这里。</p>
        <label className="model-field"><span>一次性配对码</span><input required type="password" autoComplete="off" maxLength={48} value={pairCode} onChange={event => setPairCode(event.target.value)} /></label>
        <div className="model-form-actions"><button type="submit" className="settings-button" disabled={!pairCode.trim()}>配对桌面</button></div>
        {pairError && <p className="model-form-status" data-tone="error" role="alert">{pairError}</p>}
      </form>
    </section>}

    <section className="settings-section" aria-label="设备与同步">
      <h3 className="settings-section-title">设备与同步</h3>
      <div className="settings-card">
        {device ? <CloudDevices key={origin} device={device} host={hosts.find(item => item.origin === origin)} call={call} copy={copy}
          onPreferences={refreshHosts} onForget={async () => { await call('forget'); setDevice(null); await refreshHosts(); }} />
          : <SettingsRow title="配对与同步" description="先配对桌面，再连接手机并管理同一工作区。"><span className="cloud-state">待配对</span></SettingsRow>}
        <SettingsRow title="模型 VPN 线路" description="在「网络与线路」配置各模型的出口。">
          <button type="button" className="settings-button" onClick={onOpenNetwork}>配置线路</button>
        </SettingsRow>
      </div>
    </section>
    {device && <CloudWorkspace key={origin} call={call} defaultProvider={hosts.find(item => item.origin === origin)?.provider} />}
  </div>;
}
