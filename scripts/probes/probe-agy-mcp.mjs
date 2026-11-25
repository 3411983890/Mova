/**
 * 一次性探针：`agy acp` 到底会不会连我们挂上去的 HTTP MCP server？
 *
 * 为什么必须实测：`initialize` 的 `agentCapabilities` 里**没有** `mcpCapabilities`，
 * 而 `chat-agent.mjs` 的挂载条件是 `mcpCapabilities.http === true` —— 如果 agy 其实
 * 支持 HTTP MCP 只是没声明，那我们就白白关掉了整条工具链；如果它真的不支持，那
 * 「让 Gemini 用 Mova 的浏览器/画板」就必须换机制。两种结论的后续动作完全相反，不能猜。
 *
 * 用法：node scripts/probes/probe-agy-mcp.mjs
 * 判定：日志里出现 `[MCP-IN]` 即「真的连了」；20s 内一次都没有即「没连」。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const AGY = `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe`;
const token = randomBytes(16).toString('hex');
const seen = [];
let rpcId = 100;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const authOk = req.headers.authorization === `Bearer ${token}`;
    seen.push({ method: req.method, url: req.url, authOk, bytes: raw.length });
    console.log('[MCP-IN]', req.method, req.url, 'authOk=', authOk, raw.slice(0, 300));
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let message = null;
    try { message = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    if (!('id' in message)) { res.writeHead(202).end(); return; }
    const reply = result => {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      reply({
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1.0.0' },
      });
      return;
    }
    if (message.method === 'tools/list') {
      reply({
        tools: [{
          name: 'mova_probe_ping',
          description: 'Probe tool. Call it with {} and report what it returned.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      });
      return;
    }
    if (message.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'PROBE-OK' }] });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } }));
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log('[PROBE] MCP on 127.0.0.1:' + port);

const child = spawn(AGY, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let sessionId = null;
let finished = false;

const finish = (label, code = 0) => {
  if (finished) return;
  finished = true;
  console.log(`\n[RESULT] ${label}`);
  console.log('[RESULT] mcp-requests =', seen.length, JSON.stringify(seen));
  try { child.stdin.end(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} ; process.exit(code); }, 300);
};

child.stderr.on('data', data => console.log('[AGY-ERR]', String(data).trim().slice(0, 300)));
const rl = createInterface({ input: child.stdout });
rl.on('line', line => {
  console.log('[ACP-OUT]', line.slice(0, 500));
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1 && message.result) {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: {
        cwd: process.cwd(),
        mcpServers: [{
          type: 'http',
          name: 'mova-tools',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        }],
      },
    }) + '\n');
    return;
  }
  if (message.id === 2 && message.result) {
    sessionId = message.result.sessionId;
    console.log('[PROBE] session/new ok, models =', (message.result.models?.availableModels || []).length);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [{ type: 'text', text: 'Call the tool mova_probe_ping with {} and tell me exactly what text it returned. Do not guess.' }],
      },
    }) + '\n');
    return;
  }
  if (message.id === 2 && message.error) {
    finish('session/new 失败：' + JSON.stringify(message.error), 1);
    return;
  }
  if (message.id === 3) {
    finish(seen.length ? '连上了（见 [MCP-IN]）' : '整轮结束但一次 MCP 请求都没有 → agy 不连我们挂的 HTTP MCP', 0);
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientInfo: { name: 'MovaProbe' } },
}) + '\n');

setTimeout(() => finish(`超时 60s：mcp-requests=${seen.length}`, 2), 60_000);
