/**
 * Mova 本地 MCP server（JSON-RPC 2.0 over HTTP POST）。
 *
 * 负责：鉴权（Bearer token）、1MB 请求体上限、initialize / tools/list / tools/call 的最小可用子集、
 *   以及 close() 的优雅收尾。工具语义全部来自传入的 toolTable（electron/mcp/tools.mjs）。
 * 不负责：ACP 接线、审批（permissions.cjs）、审计落盘 —— 那些在 handler 注入方和统筹者那边。
 * 被谁调用：接线层在 session/new 之前起服务，把 { type:'http', name, url, headers } 塞进 mcpServers。
 *
 * 只监听 127.0.0.1：这个 server 直接代表用户本机的文件与记忆能力，出网卡口一次都不留。
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const DEFAULT_PORT = 0;
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * 超限后仍把剩余字节读掉再回 413：提前 destroy 会让多数 HTTP 客户端只看到连接重置，
 * 拿不到「请求太大」这个结论。这里丢弃内容但继续读，超过这个硬上限才真的掐断。
 */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;
const CLOSE_GRACE_MS = 1_000;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = Object.freeze({ name: 'mova-tools', version: '1.0.0' });
const MCP_PATH = '/mcp';

const RPC = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendRpcError(res, id, code, message) {
  // 错误文案里绝不带 token：它可能被 CLI 原样写进日志或模型上下文。
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function sendRpcResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function unauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'www-authenticate': 'Bearer',
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

/** 定长比较，避免按字节早退泄露出 token 前缀。 */
function tokenMatches(header, token) {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header, 'utf8');
  const expected = Buffer.from(`Bearer ${token}`, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** @returns {Promise<string|null>} null 表示超限（已丢弃内容）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_DRAIN_BYTES) {
        req.destroy(Object.assign(new Error('body too large'), { code: 'body-too-large' }));
        return;
      }
      if (total > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', error => reject(error));
    req.on('aborted', () => reject(Object.assign(new Error('request aborted'), { code: 'aborted' })));
  });
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function versionOf(params) {
  const asked = params?.protocolVersion;
  return typeof asked === 'string' && asked ? asked : DEFAULT_PROTOCOL_VERSION;
}

/**
 * 每次 `tools/call` 的调用上下文：`transport:'http'` 是本层的事实，
 * `context` 由接线层提供（本轮的 `signal`、可选 `callId`），用于取消与前端同一行更新。
 * 不传 `context` 时行为与改造前完全一致（只带 transport）。
 * @param {object|Function|null|undefined} context
 * @param {{ name: string, args: object }} info
 * @returns {object}
 */
function callContext(context, info) {
  const base = { transport: 'http' };
  let extra = null;
  try {
    extra = typeof context === 'function' ? context(info) : context;
  } catch {
    extra = null; // 接线层取上下文失败不该让工具调用变成协议错误
  }
  const fields = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : null;
  return fields ? { ...base, ...fields } : base;
}

function createHandler({ toolTable, context }) {
  return async function handle(req, res) {
    let path;
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      path = '/'; // 畸形 URL 按根路径处理，交给后面的方法/鉴权判断
    }
    if (path !== MCP_PATH && path !== '/') return notFound(res);
    // MCP 客户端会先 GET 探测 SSE 端点；这里只做 POST，明确回 405 比挂住连接好。
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 413, { error: 'payload_too_large' });
    }
    if (body === null) return sendJson(res, 413, { error: 'payload_too_large' });

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return sendRpcError(res, null, RPC.PARSE, 'Parse error');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return sendRpcError(res, null, RPC.INVALID_REQUEST, 'Invalid Request');
    }

    const method = typeof message.method === 'string' ? message.method : '';
    // 没有 id = 通知（例如 notifications/initialized）；回了错误反而会被当成非法帧。
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      res.writeHead(202, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const id = message.id ?? null;
    const params = message.params && typeof message.params === 'object' ? message.params : {};

    if (method === 'initialize') {
      return sendRpcResult(res, id, {
        protocolVersion: versionOf(params),
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    if (method === 'tools/list') {
      return sendRpcResult(res, id, { tools: toolTable.list() });
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return sendRpcError(res, id, RPC.INVALID_PARAMS, 'tools/call 需要 name');
      try {
        // toolTable.call 自己收敛异常；这里兜的只是「注入的不是工具表」这类接线错误。
        const args = params.arguments ?? {};
        const result = await toolTable.call(name, args, callContext(context, { name, args }));
        return sendRpcResult(res, id, result);
      } catch (error) {
        return sendRpcError(res, id, RPC.INTERNAL, `工具执行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sendRpcError(res, id, RPC.METHOD_NOT_FOUND, `Method not found: ${method || '(empty)'}`);
  };
}

/**
 * @param {{ toolTable: { list(): Array, call(name: string, args: object, ctx?: object): Promise<object> },
 *           token: string, host?: string, port?: number,
 *           context?: object|((info: { name: string, args: object }) => object) }} options
 *   `context` 由接线层提供本轮调用上下文（`{ transport:'http', signal, callId }`）；
 *   省略时每次 `tools/call` 的 ctx 与改造前一致（只有 `transport:'http'`）。
 * @returns {Promise<{ url: string, port: number, token: string, close(): Promise<void> }>}
 */
export async function startMovaToolServer({ toolTable, token, context = null, host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
  if (!toolTable || typeof toolTable.list !== 'function' || typeof toolTable.call !== 'function') {
    throw new Error('startMovaToolServer: 需要 { list, call } 形状的 toolTable');
  }
  // token 由调用方生成（随机串），这里只做形状校验：空 token 等于没有鉴权。
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('startMovaToolServer: token 必须是由调用方生成的随机串（≥8 字符）');
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('startMovaToolServer: 只允许监听 127.0.0.1');
  }

  const handle = createHandler({ toolTable, context });
  const server = createServer((req, res) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      unauthorized(res);
      return;
    }
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  let closing = null;
  return {
    url: `http://${host}:${actualPort}${MCP_PATH}`,
    port: actualPort,
    token,
    close() {
      if (closing) return closing;
      closing = new Promise(resolve => {
        if (!server.listening) {
          resolve();
          return;
        }
        // fetch 等客户端默认 keep-alive，不主动收掉空闲连接 server.close() 会一直等。
        // 正在进行中的请求再给 1s 收尾，超时才硬断（不能把工具调用截在半路）。
        const timer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections?.();
      });
      return closing;
    },
  };
}
