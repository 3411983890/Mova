/**
 * 负责：项目和 Bot 共用的工作位置选择器与远程主机配对表单。
 * 不负责：保存桌面令牌或执行云任务。
 * 被谁调用：app.js 与 Bot 群聊表单。
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, Folder, FolderPlus, Laptop, Plus } from '@keyline-icons/react';
import { LOCAL_MOVA_ORIGIN, parseCloudOrigin } from '../../services/cloud-connection.mjs';
import { CLOUD_PROVIDERS, desktopCloudCall } from './workspace-location.mjs';
import './workspace-location.css';

export function WorkspaceLocation({ cloud, value, projects, onChange, onAddHost, onPickFolders, embedded = false }) {
  const [open, setOpen] = useState(false);
  const [hosts, setHosts] = useState([]);
  const [status, setStatus] = useState('');
  const area = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const folder = useRef(null);
  const menuId = useId();
  const cloudSelected = value?.kind === 'cloud';
  function apply(place) {
    setOpen(false);
    onChange(place);
    trigger.current?.focus();
  }
  async function list() {
    if (!cloud?.device) return;
    setStatus('正在读取远程主机…');
    try { setHosts(await desktopCloudCall(cloud, 'hosts')); setStatus(''); }
    catch (error) { setStatus(error.message); }
  }
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!area.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const chooseHost = host => apply({ id: host.origin, kind: 'cloud', origin: host.origin, name: host.label });
  const label = value?.name || '在此电脑上添加文件夹';
  return <div className={embedded ? 'workspace-location' : 'project-source workspace-location'} ref={area}
    onKeyDown={event => {
      if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    }}>
    <div className="project-device-wrap">
      <button ref={trigger} className="project-device-toggle" type="button" aria-expanded={open} aria-controls={menuId}
        onClick={() => { if (!open) void list(); setOpen(!open); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) { setOpen(true); void list(); }
            globalThis.requestAnimationFrame(() => menu.current?.querySelector('button')?.focus());
          }
        }}><span>{label}</span><i className="keyline-icon" aria-hidden="true"><ChevronDown /></i></button>
      <div ref={menu} className="project-device-menu" id={menuId} hidden={!open}>
        <button className="project-device-local" type="button" aria-pressed={!value || value.kind === 'folder'} onClick={() => apply(null)}>
          <i className="keyline-icon" aria-hidden="true"><Laptop /></i><span>此电脑</span>{(!value || value.kind === 'folder') && <i className="keyline-icon" aria-hidden="true"><Check /></i>}
        </button>
        <p className="project-device-caption">远程设备</p>
        {hosts.map(host => <button type="button" key={host.origin} aria-pressed={value?.origin === host.origin} title={host.origin} onClick={() => chooseHost(host)}>
          <i className="keyline-icon" aria-hidden="true"><Cloud /></i><span>{host.label}</span>
          {value?.origin === host.origin && <i className="keyline-icon" aria-hidden="true"><Check /></i>}
        </button>)}
        {!hosts.length && <p className="project-device-empty" role="status">{status || (cloud?.device ? '未连接任何远程主机' : '请在 Mova 桌面版配对主机')}</p>}
        {cloud?.device && <button className="project-add-remote" type="button" onClick={() => {
          setOpen(false);
          onAddHost(chooseHost, trigger.current);
        }}><i className="keyline-icon" aria-hidden="true"><Plus /></i><span>添加远程主机</span></button>}
        {projects?.length > 0 && <>
          <p className="project-device-caption">项目</p>
          {projects.map(project => <button type="button" key={project.id} aria-pressed={value?.id === project.id} onClick={() => apply(project)}>
            <i className="keyline-icon" aria-hidden="true"><Folder /></i><span>{project.name}</span>
            {value?.id === project.id && <i className="keyline-icon" aria-hidden="true"><Check /></i>}
          </button>)}
        </>}
      </div>
    </div>
    {(cloudSelected || value?.origin) && <p className="workspace-location-hint">在此主机执行聊天和研究任务</p>}
    {!embedded && !value?.origin && <button className="project-folder-button" type="button" onClick={onPickFolders || (() => folder.current?.click())}>
      <i className="keyline-icon" aria-hidden="true"><FolderPlus /></i><span>{value?.kind === 'folder' ? '更换文件夹' : '添加'}</span>
    </button>}
    {!embedded && !onPickFolders && <input ref={node => { folder.current = node; node?.setAttribute('webkitdirectory', ''); }} type="file" hidden onChange={event => {
      const file = event.target.files?.[0];
      if (!file) return;
      const name = file.webkitRelativePath?.split('/')[0] || file.name;
      event.target.value = '';
      apply({ id: `folder:${name}`, kind: 'folder', name });
    }} />}
  </div>;
}

export function RemoteHostForm({ cloud, initialOrigin, onPair, onCancel }) {
  const [origin, setOrigin] = useState(initialOrigin || '');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [provider, setProvider] = useState('codex');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const address = parseCloudOrigin(origin);
      const known = (await desktopCloudCall(cloud, 'hosts')).find(host => host.origin === address);
      if (known) {
        const session = await desktopCloudCall(cloud, 'session', address).catch(err => {
          if (err.status !== 401) throw err;
          return null;
        });
        if (session) { onPair(known); return; }
      }
      const probe = await cloud.probe(address);
      if (!probe.ok) throw new Error(probe.message);
      if (!code.trim()) throw new Error('请填入 Linux 终端生成的一次性配对码');
      if (known) await desktopCloudCall(cloud, 'forget', address, { localOnly: true });
      await desktopCloudCall(cloud, 'pair', address, { code, label, provider });
      const added = (await desktopCloudCall(cloud, 'hosts')).find(host => host.origin === address);
      onPair(added);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <form className="remote-host-form" onSubmit={submit}>
    <h2 id="remote-host-title">添加远程主机</h2>
    <label>主机名称<input value={label} maxLength={60} placeholder="例如：我的 Linux" onChange={event => setLabel(event.target.value)} /></label>
    <label>Mova 服务地址<input autoFocus required value={origin} inputMode="url" placeholder="https://mova.example.com" onChange={event => setOrigin(event.target.value)} /></label>
    <button type="button" className="remote-host-local" onClick={() => setOrigin(LOCAL_MOVA_ORIGIN)}>使用本机 WSL 地址</button>
    <label>一次性配对码<input type="password" autoComplete="off" maxLength={48} value={code} onChange={event => setCode(event.target.value)} /></label>
    <p>在目标 Linux 终端运行 <code>mova pair code</code>。</p>
    <label>默认云端模型<select value={provider} onChange={event => setProvider(event.target.value)}>
      {Object.entries(CLOUD_PROVIDERS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></label>
    {error && <p className="remote-host-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" disabled={busy}>{busy ? '正在连接…' : '连接主机'}</button></footer>
  </form>;
}
