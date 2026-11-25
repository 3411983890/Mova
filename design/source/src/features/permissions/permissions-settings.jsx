import React, { useMemo, useState } from 'react';
import { ChangesPanel } from '../changes/changes-panel.jsx';
import './permissions-settings.css';

/* 权限：按项目文件夹授权读取 / 修改 / 运行命令。
   原型不接触真实文件系统，开关只改本地示例数据。 */

const CAPABILITIES = [
  { id: 'read', label: '读取文件', detail: '列出目录、读取文本文件' },
  { id: 'write', label: '修改文件', detail: '新建、覆盖、精确替换文件内容' },
  { id: 'exec', label: '运行命令', detail: '在项目文件夹内执行构建、测试和 git' },
];

const TOOL_GROUPS = [
  {
    id: 'read',
    label: '读取',
    summary: '只能查看，不能改动任何内容。',
    tools: ['列出文件', '读取文件', '搜索内容', '项目树', '符号查找', 'Git 只读'],
  },
  {
    id: 'write',
    label: '修改',
    summary: '会写到磁盘；默认每次都要你确认，打开自动接受后不再逐次询问。',
    tools: ['写入', '替换', '删除', '移动', '批量修改', '撤销'],
    caution: '删除与移动不可靠撤销；批量修改要么全写要么全不写，崩溃时可能只写了一半。',
  },
  {
    id: 'exec',
    label: '执行',
    summary: '在项目文件夹内运行构建、测试和 git，命令本身可以访问整个系统。',
    tools: ['运行命令'],
    caution: '命令以你的用户权限运行，不是沙箱：可以访问项目以外的文件和网络。',
  },
];

const DEMO_ROOTS = [
  {
    id: 'root-mova',
    name: 'Mova',
    path: 'C:\\Users\\34119\\Documents\\Mova',
    capabilities: { read: true, write: true, exec: true },
    autoAccept: { write: false, exec: false },
  },
  {
    id: 'root-birdy',
    name: 'BirdyMall',
    path: 'C:\\Users\\34119\\Documents\\BirdyMall',
    capabilities: { read: true, write: false, exec: false },
    autoAccept: { write: false, exec: false },
  },
];

const DEMO_PENDING = [
  { id: 'pending-ue5', name: 'UE5MCP', path: 'D:\\Projects\\UE5MCP', project: 'UE5MCP' },
];

function summaryOf(root) {
  const parts = [];
  if (root.capabilities.read) parts.push('读取');
  if (root.capabilities.write) parts.push(root.autoAccept.write ? '修改（自动接受）' : '修改');
  if (root.capabilities.exec) parts.push(root.autoAccept.exec ? '命令（自动接受）' : '命令');
  return parts.length ? parts.join(' · ') : '未授权';
}

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

export function PermissionsSettings({ onToast }) {
  const [roots, setRoots] = useState(DEMO_ROOTS);
  const [pending, setPending] = useState(DEMO_PENDING);
  const [message, setMessage] = useState(null);
  const [historyRoot, setHistoryRoot] = useState(null);

  const registered = useMemo(() => roots, [roots]);

  function patchRoot(id, patch) {
    setRoots(current => current.map(root => (root.id === id ? { ...root, ...patch } : root)));
  }

  function toggleCapability(root, capability) {
    if (capability === 'write' && !root.capabilities.read) return;
    const next = !root.capabilities[capability];
    patchRoot(root.id, {
      capabilities: { ...root.capabilities, [capability]: next },
      autoAccept: next ? root.autoAccept : { ...root.autoAccept, [capability]: false },
    });
    setMessage({ tone: 'ok', text: next ? `已授予「${CAPABILITIES.find(item => item.id === capability).label}」。` : '已撤销这项权限。' });
  }

  function toggleAuto(root, capability) {
    const next = !root.autoAccept[capability];
    patchRoot(root.id, { autoAccept: { ...root.autoAccept, [capability]: next } });
    setMessage({ tone: 'ok', text: next ? '已打开自动接受，之后不再逐次确认。' : '已关闭自动接受，每次都会确认。' });
  }

  function revokeAll(root) {
    patchRoot(root.id, { capabilities: { read: false, write: false, exec: false }, autoAccept: { write: false, exec: false } });
    setMessage({ tone: 'ok', text: '已撤销这个文件夹的全部权限。' });
  }

  function forget(root) {
    setRoots(current => current.filter(item => item.id !== root.id));
    setMessage({ tone: 'ok', text: '已移除这个文件夹的登记；重新添加需要重新授权。' });
  }

  function register(folder) {
    setPending(current => current.filter(item => item.id !== folder.id));
    setRoots(current => [...current, {
      id: folder.id,
      name: folder.name,
      path: folder.path,
      capabilities: { read: false, write: false, exec: false },
      autoAccept: { write: false, exec: false },
    }]);
    setMessage({ tone: 'ok', text: '已登记文件夹，权限仍然全部关闭。' });
  }

  return (
    <div className="permissions-page">
      <section className="settings-section">
        <h3 className="settings-section-title">授权范围</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>按文件夹授权，模型只能在你打开的范围内操作</strong>
              <p>
                读取、修改文件和运行命令分别授权。授权范围固定在项目文件夹内：模型不能访问其他目录，也不能用
                <code>..</code> 跳出文件夹。扩大权限需要你在系统对话框里确认；修改文件和运行命令默认每次都要确认。
              </p>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>审计与撤销</strong>
              <p>每次允许、拒绝、授权和撤销都会写入 <code>permissions-audit.jsonl</code>。撤销立即生效，正在进行的下一轮工具调用就会被拦下。</p>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">每项权限启用的工具</h3>
        <div className="settings-card">
          {TOOL_GROUPS.map(group => (
            <div className="settings-row permissions-capability" key={group.id}>
              <div className="settings-row-text">
                <strong>{group.label}</strong>
                <p>{group.summary}</p>
                <ul className="permissions-tools" aria-label={`${group.label}能力启用的工具`}>
                  {group.tools.map(tool => <li key={tool}>{tool}</li>)}
                </ul>
                {group.caution && <p className={`permissions-caution is-${group.id}`} role="note">{group.caution}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {message && <p className={`permissions-message ${message.tone}`} role="status">{message.text}</p>}

      <section className="settings-section">
        <h3 className="settings-section-title">已登记的项目文件夹</h3>
        <div className="settings-card">
          {registered.length === 0 && (
            <div className="settings-row">
              <div className="settings-row-text">
                <strong>还没有登记任何文件夹</strong>
                <p>在 CodeMova 里新建项目并选择文件夹后，会出现在这里。登记本身不授予任何权限。</p>
              </div>
            </div>
          )}
          {registered.map(root => (
            <div className="settings-row permissions-root" key={root.id}>
              <div className="settings-row-text">
                <strong>{root.name}</strong>
                <p className="permissions-path" title={root.path}>{root.path}</p>
                <p className="permissions-summary">{summaryOf(root)}</p>
              </div>
              <div className="permissions-controls">
                {CAPABILITIES.map(capability => {
                  const needsRead = capability.id === 'write' && !root.capabilities.read;
                  return (
                    <label className="permissions-toggle" key={capability.id}>
                      <span>
                        <strong>{capability.label}</strong>
                        <small>{needsRead ? '需先开启「读取文件」' : capability.detail}</small>
                      </span>
                      <Switch
                        checked={root.capabilities[capability.id] === true}
                        label={`${root.name}：${capability.label}`}
                        disabled={needsRead}
                        onChange={() => toggleCapability(root, capability.id)}
                      />
                    </label>
                  );
                })}
                {root.capabilities.write && (
                  <label className="permissions-toggle permissions-toggle-sub">
                    <span>
                      <strong>修改文件不再逐次确认</strong>
                      <small>关闭时，每次写入都会弹出系统确认</small>
                    </span>
                    <Switch
                      checked={root.autoAccept.write === true}
                      label={`${root.name}：自动接受修改文件`}
                      onChange={() => toggleAuto(root, 'write')}
                    />
                  </label>
                )}
                {root.capabilities.exec && (
                  <label className="permissions-toggle permissions-toggle-sub">
                    <span>
                      <strong>运行命令不再逐次确认</strong>
                      <small>关闭时，每条命令都会弹出系统确认</small>
                    </span>
                    <Switch
                      checked={root.autoAccept.exec === true}
                      label={`${root.name}：自动接受运行命令`}
                      onChange={() => toggleAuto(root, 'exec')}
                    />
                  </label>
                )}
                <div className="permissions-actions">
                  <button type="button" className="settings-button" onClick={() => setHistoryRoot(root)}>改动历史</button>
                  <button type="button" className="settings-button danger" onClick={() => revokeAll(root)}>撤销全部权限</button>
                  <button type="button" className="settings-button" title="同时清除权限记录；重新添加这个文件夹时需要重新授权" onClick={() => forget(root)}>移除登记</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {pending.length > 0 && (
        <section className="settings-section">
          <h3 className="settings-section-title">尚未登记的项目文件夹</h3>
          <div className="settings-card">
            {pending.map(folder => (
              <div className="settings-row" key={folder.id}>
                <div className="settings-row-text">
                  <strong>{folder.name}</strong>
                  <p className="permissions-path" title={folder.path}>{folder.path}</p>
                  <p>项目「{folder.project}」的文件夹还没有登记权限。登记后才能单独授予读取、修改或运行命令。</p>
                </div>
                <button type="button" className="settings-button" onClick={() => register(folder)}>登记文件夹</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {historyRoot && (
        <ChangesPanel root={historyRoot} onClose={() => setHistoryRoot(null)} onToast={onToast} />
      )}
    </div>
  );
}
