import React, { useEffect, useState } from 'react';
import './mcp-settings.css';
import { confirmAction } from '../ui/confirm.js';

export function McpSettings({ bridge }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('{}');
  async function load() { const result = await bridge?.list(); if (result?.ok) setRows(result.value); else setError(result?.error || '无法读取 MCP 配置'); }
  useEffect(() => { void load(); }, []);
  async function run(action) {
    setBusy(true); setError('');
    try { const result = await action(); if (!result?.ok) throw new Error(result?.error || '操作失败'); await load(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function add(event) {
    event.preventDefault();
    let parsedArgs, parsedEnv;
    try {
      parsedArgs = JSON.parse(args || '[]'); parsedEnv = JSON.parse(env || '{}');
      if (!Array.isArray(parsedArgs) || parsedArgs.some(arg => typeof arg !== 'string')) throw new Error('启动参数必须是字符串数组');
    } catch (cause) { setError(cause.message); return; }
    await run(() => bridge.add({ name, command, args: parsedArgs, env: parsedEnv }));
    setName(''); setCommand(''); setArgs(''); setEnv('{}');
  }
  if (!bridge) return <p>请在桌面版管理 MCP。</p>;
  return <div className="mcp-settings">
    <section className="settings-section"><h3 className="settings-section-title">已添加的 MCP</h3>
      <p className="mcp-note">启用后刷新工具列表，聊天中的 AI 可以搜索这些工具；每次调用仍需你确认。</p>
      {rows.length === 0 && <p className="mcp-note">还没有 MCP Server。</p>}
      {rows.map(row => <div className="settings-card mcp-server" key={row.id}>
        <div className="mcp-row"><div><strong>{row.name}</strong><p>{row.status} · {row.tools.length} 个工具 · {row.command}</p></div>
          <label><input type="checkbox" checked={row.enabled} disabled={busy} onChange={event => run(() => bridge.toggle(row.id, event.target.checked))} /> 启用</label></div>
        <div className="mcp-actions"><button disabled={busy} onClick={() => run(() => bridge.refresh(row.id))}>连接并刷新工具</button>
          <button disabled={busy} onClick={async () => { const confirmed = await confirmAction({ title: `移除 ${row.name}？`, body: '这个 MCP 服务器会从列表里移除，它提供的工具随即不可用。', detail: '已保存的连接信息会一起删除；重新添加后可再次连接。', confirmLabel: '移除', tone: 'danger' }); if (confirmed) void run(() => bridge.remove(row.id)); }}>移除</button></div>
        {row.tools.map(tool => <label className="mcp-tool" key={tool.name}><input type="checkbox" disabled={busy} checked={!row.disabledTools.includes(tool.name)} onChange={event => run(() => bridge.tool(row.id, tool.name, event.target.checked))} />
          <span><strong>{tool.name}</strong><small>{tool.description}</small></span></label>)}
      </div>)}
    </section>
    <section className="settings-section"><h3 className="settings-section-title">添加本地 MCP</h3>
      <form className="settings-card mcp-form" onSubmit={add}>
        <label>名称<input required value={name} onChange={event => setName(event.target.value)} placeholder="例如 GitHub" /></label>
        <label>启动命令<input required value={command} onChange={event => setCommand(event.target.value)} placeholder="npx 或绝对路径" /></label>
        <label>启动参数（JSON 数组）<input value={args} onChange={event => setArgs(event.target.value)} placeholder={'["-y", "@example/mcp"]'} /></label>
        <label>环境变量（JSON 对象）<textarea value={env} onChange={event => setEnv(event.target.value)} rows="3" /></label>
        <p className="mcp-note">本地 MCP 以当前用户权限运行。仅添加你信任的命令；敏感信息暂不建议填在这里。</p>
        <button disabled={busy} type="submit">添加 MCP</button>
      </form>
    </section>
    {error && <p role="alert" className="mcp-error">{error}</p>}
  </div>;
}
