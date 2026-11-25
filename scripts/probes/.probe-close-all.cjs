// 机制验证：res.end() 之后立刻 closeAllConnections()，客户端能不能完整收到响应？
// 这是「127.0.0.1 拒绝连接」的根因证明，不涉及本仓代码。
const http = require('node:http');

const HTML = `<!doctype html><meta charset="utf-8"><title>probe</title><body>${'x'.repeat(2000)}可以关闭这个页面了</body></html>`;

function serve(closeImmediately) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      if (closeImmediately) {
        // 这就是旧代码 finishFlow() 里的做法
        server.close();
        server.closeAllConnections?.();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function probe(closeImmediately) {
  const { server, port } = await serve(closeImmediately);
  const result = { closeImmediately };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback`, { signal: AbortSignal.timeout(4000) });
    const body = await response.text();
    result.status = response.status;
    result.bodyLength = body.length;
    result.complete = body.includes('可以关闭这个页面了') && /<\/body>/.test(body);
  } catch (error) {
    result.error = `${error.cause?.code || error.code || ''} ${error.message}`.trim().slice(0, 90);
    result.complete = false;
  }
  try { server.close(); } catch {}
  try { server.closeAllConnections?.(); } catch {}
  return result;
}

(async () => {
  const withKill = await probe(true);
  const withoutKill = await probe(false);
  console.log(JSON.stringify({ withKill, withoutKill }, null, 2));
  console.log(withKill.complete === false && withoutKill.complete === true
    ? '结论：确认 closeAllConnections() 会掐断响应 —— 这就是根因'
    : '结论：本次未复现（时序相关），但移除 closeAllConnections 仍是正确做法');
})();
