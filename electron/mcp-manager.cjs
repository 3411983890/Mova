'use strict';
const { app, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFile, writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { StringDecoder } = require('node:string_decoder');

function createMcpManager({ authorize, approvals }) {
  const file = join(app.getPath('userData'), 'mcp-servers.json');
  const connections = new Map();
  let queue = Promise.resolve();
  async function read() {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function mutate(fn) {
    const work = queue.then(async () => {
      const rows = await read();
      const result = fn(rows);
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(rows, null, 2), { mode: 0o600 });
      await rename(temp, file);
      return result;
    });
    queue = work.catch(() => {});
    return work;
  }
  function publicRow(row) {
    return { ...row, env: Object.keys(row.env || {}), status: connections.has(row.id) ? 'connected' : 'disconnected' };
  }
  async function connect(row) {
    if (connections.has(row.id)) return connections.get(row.id);
    const child = spawn(row.command, row.args, { cwd: app.getPath('userData'), env: { ...process.env, ...row.env }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    const conn = { child, pending, buffer: '', decoder: new StringDecoder('utf8'), next: 1 };
    connections.set(row.id, conn);
    function close(error) {
      if (connections.get(row.id) === conn) connections.delete(row.id);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
      pending.clear();
    }
    child.on('error', close);
    child.on('exit', () => close(new Error('MCP server exited')));
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      conn.buffer += conn.decoder.write(chunk);
      if (conn.buffer.length > 8_000_000) { child.kill(); return; }
      while (conn.buffer.includes('\n')) {
        const end = conn.buffer.indexOf('\n');
        const payload = conn.buffer.slice(0, end);
        conn.buffer = conn.buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(payload); } catch { continue; }
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message || 'MCP error'));
        else item.resolve(message.result);
      }
    });
    try {
      await rpc(conn, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Mova', version: app.getVersion() } });
      send(conn, { jsonrpc: '2.0', method: 'notifications/initialized' });
      return conn;
    } catch (error) { child.kill(); connections.delete(row.id); throw error; }
  }
  function send(conn, message) {
    conn.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function rpc(conn, method, params, signal) {
    return new Promise((resolve, reject) => {
      const id = conn.next++;
      if (signal?.aborted) { reject(new Error('Cancelled')); return; }
      const timer = setTimeout(() => { conn.pending.delete(id); reject(new Error('MCP timeout')); }, 20000);
      conn.pending.set(id, { resolve, reject, timer });
      try { send(conn, { jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); conn.pending.delete(id); reject(error); }
    });
  }
  async function refresh(id) {
    const row = (await read()).find(item => item.id === id);
    if (!row) throw new Error('MCP not found');
    const result = await rpc(await connect(row), 'tools/list', {});
    const tools = (result.tools || []).slice(0, 300).map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema }));
    await mutate(rows => { const current = rows.find(item => item.id === id); if (current) current.tools = tools; });
    return tools;
  }
  async function call(id, name, args, sender, signal, { skipApproval = false } = {}) {
    const row = (await read()).find(item => item.id === id && item.enabled);
    if (!row || row.disabledTools?.includes(name)) throw new Error('MCP tool disabled');
    const actual = await rpc(await connect(row), 'tools/list', {}, signal);
    if (!actual.tools?.some(tool => tool.name === name)) throw new Error('MCP tool changed; refresh it in settings');
    const decision = skipApproval ? 'once' : await approvals.ask(sender, { capability: 'exec', allowSession: false, message: `调用 ${row.name}：${name}`, command: `${row.name} / ${name}`, detail: JSON.stringify(args).slice(0, 2000) }, signal);
    if (decision === 'deny') throw new Error('MCP call denied');
    return rpc(await connect(row), 'tools/call', { name, arguments: args }, signal);
  }
  function stop(id) { const conn = connections.get(id); if (conn) { connections.delete(id); conn.child.kill(); } }
  function handler(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      try { const win = authorize(event); return { ok: true, value: await fn(...args, win) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
  }
  handler('mcp:list', async () => (await read()).map(publicRow));
  handler('mcp:add', async input => {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || typeof input.command !== 'string' || !input.command.trim() ||
        !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string') || input.args.length > 30 ||
        typeof input.env !== 'object' || input.env === null || Array.isArray(input.env) ||
        Object.entries(input.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string')) throw new Error('Invalid MCP configuration');
    const row = { id: randomUUID(), name: input.name.trim().slice(0, 80), command: input.command.trim(), args: input.args, env: input.env, enabled: false, tools: [], disabledTools: [] };
    await mutate(rows => rows.push(row)); return publicRow(row);
  });
  handler('mcp:remove', async id => { stop(id); return mutate(rows => { const index = rows.findIndex(row => row.id === id); if (index < 0) throw new Error('MCP not found'); rows.splice(index, 1); }); });
  handler('mcp:toggle', async (id, enabled) => { if (!enabled) stop(id); return mutate(rows => { const row = rows.find(item => item.id === id); if (!row) throw new Error('MCP not found'); row.enabled = enabled === true; }); });
  handler('mcp:tool', async (id, name, enabled) => mutate(rows => { const row = rows.find(item => item.id === id); if (!row?.tools.some(tool => tool.name === name)) throw new Error('Tool not found'); row.disabledTools = row.disabledTools.filter(item => item !== name); if (!enabled) row.disabledTools.push(name); }));
  handler('mcp:refresh', refresh);
  return { read, call, stopAll: () => { for (const id of connections.keys()) stop(id); } };
}
module.exports = { createMcpManager };
