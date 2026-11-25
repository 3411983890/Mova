'use strict';
const { createServer } = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { basename } = require('node:path');
const { createEdgeFiles, MAX_TRANSFER } = require('./edge-files.cjs');
const { createBrowserTools } = require('./browser/tools.cjs');
const { runBatch } = require('./browser/batch.cjs');
const { classifyAction, handoffLabelOf } = require('./browser/policy.cjs');
const { mergeSessions } = require('./session-sync.cjs');
const { projectPlan, diffObserved } = require('./edge-receipts.cjs');
const { createTimingLedger, classifyFailure } = require('./browser/timing.cjs');
const { createObservationCache, observationKeyOf } = require('./edge-observation.cjs');

const PORT = 43729;
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const testPageHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Mova 浏览器测试页</title>
<style>body{font:16px system-ui;margin:32px}label,output{display:block;margin:16px 0}canvas{border:1px solid #888;touch-action:none}</style>
<h1>Mova 浏览器测试页</h1>
<label>方案 <select id="plan"><option value="10">10M</option><option value="20">20M</option></select></label>
<label>数量 <input id="quantity" type="number" value="1" min="1"></label>
<output id="price" aria-live="polite">总价 ￥10</output>
<button id="save" type="button">记录测试</button> <button type="button" disabled>禁用按钮</button>
<p id="status" role="status">等待操作</p>
<canvas id="board" width="420" height="160" aria-label="鼠标拖动测试区"></canvas>
<script>
const plan = document.getElementById('plan'), quantity = document.getElementById('quantity');
const price = document.getElementById('price'), status = document.getElementById('status');
document.addEventListener('input', () => { price.textContent = '总价 ￥' + plan.value * quantity.value; });
document.getElementById('save').addEventListener('click', () => { status.textContent = '已记录测试'; });
const board = document.getElementById('board'), ctx = board.getContext('2d');
board.addEventListener('pointerdown', e => { board.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); });
board.addEventListener('pointermove', e => { if (e.buttons === 1) { ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); } });
board.addEventListener('pointerup', () => { status.textContent = '已收到鼠标操作'; });
</script></html>`;
const allowedTools = new Set(['browser_snapshot', 'browser_read', 'browser_act', 'browser_wait', 'browser_batch', 'browser_handoff', 'browser_screenshot', 'browser_pointer']);

function chatSessions(snapshot) {
  const chat = row => typeof row?.[0] === 'string' && row[0].startsWith('["ChatMova",');
  return {
    version: 1,
    projects: snapshot.projects.flatMap(project => {
      const chats = project.chats.filter(item => item.mode === 'ChatMova');
      return chats.length ? [{ name: project.name, chats }] : [];
    }),
    conversations: snapshot.conversations.filter(chat),
    aims: (snapshot.aims || []).filter(chat),
    usage: (snapshot.usage || []).filter(chat),
    permissionPresets: (snapshot.permissionPresets || []).filter(chat),
    modelSelections: (snapshot.modelSelections || []).filter(chat),
  };
}

function startEdgeBridge({ handlers, memory, sync, approvals, asks, fileDirectory }) {
  if (typeof approvals?.ask !== 'function' || typeof approvals?.respond !== 'function' ||
      typeof approvals?.cancelSender !== 'function') {
    throw new TypeError('Mova Edge bridge requires the desktop approval broker.');
  }
  let pairing;
  let client;
  const runs = new Map();
  const commands = new Map();
  const chatRepository = {
    loadSessions: async () => chatSessions(await memory.loadSessions()),
    saveSessions: async snapshot => {
      const full = await memory.loadSessions();
      return memory.saveSessions(mergeSessions(full, chatSessions(full), chatSessions(snapshot)));
    },
  };
  const cancelClient = () => {
    if (!client) return;
    for (const { controller } of runs.values()) controller.abort();
    approvals.cancelSender(client.token);
    sync.forget(client.token);
    client = undefined;
  };
  const server = createServer(async (req, res) => {
    if (req.headers.host === `127.0.0.1:${PORT}` && req.method === 'GET' && req.url === '/edge-test') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(testPageHtml);
      return;
    }
    const origin = req.headers.origin;
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.host !== `127.0.0.1:${PORT}` || !extensionOrigin.test(origin || '') || req.url !== '/edge') {
      return reply(403, { ok: false, error: 'unauthorized' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      return res.end();
    }
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') return reply(405, { ok: false });
    const pairingRequest = !req.headers.authorization && pairing?.expires > Date.now();
    const authenticated = client && client.origin === origin && req.headers.authorization === `Bearer ${client.token}`;
    if (!pairingRequest && !authenticated) return reply(401, { ok: false, error: 'edge-not-paired' });
    const connection = client;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (authenticated ? 32_000_000 : 1024)) return reply(413, { ok: false, error: 'request-limit' });
        chunks.push(chunk);
      }
      const { op, args = [] } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (pairingRequest) {
        if (op !== 'pair' || !pairing || pairing.expires <= Date.now() || args[0] !== pairing.code) {
          return reply(401, { ok: false, error: 'invalid-pairing-code' });
        }
        pairing = undefined;
        cancelClient();
        client = { origin, token: randomBytes(32).toString('hex') };
        return reply(200, { ok: true, value: client.token });
      }
      if (client !== connection) return reply(401, { ok: false, error: 'edge-not-paired' });
      const id = connection.token + ':' + String(args[0]);
      let value;
      switch (op) {
        case 'providers:list':
        case 'providers:active':
          value = await handlers[op](null, ...args);
          break;
        case 'sessions:read':
          value = await sync.read(connection.token, chatRepository, args[0]);
          break;
        case 'sessions:save':
          value = await sync.save(connection.token, chatRepository, args[0], args[1]);
          break;
        case 'memory:settings':
          value = await memory.settings();
          break;
        case 'memory:ingest': {
          const { conversationId, messageId, text } = args[0] || {};
          if (typeof conversationId !== 'string' || !conversationId.startsWith('["ChatMova",')) throw new Error('invalid-chat');
          value = await memory.ingest({ conversationId, messageId, text, projectId: null, role: 'user' });
          break;
        }
        case 'approval:respond':
          if (!approvals.respond(args[0], args[1], connection.token)) throw new Error('expired');
          break;
        case 'ask:respond': {
          const run = [...runs.values()].find(item => item.askId === args[0] && item.sender?.id === connection.token);
          if (!run || !asks.respond(run.sender, args[0], args[1])) throw new Error('expired');
          break;
        }
        case 'model:cancel':
          runs.get(id)?.controller.abort();
          break;
        case 'model:permission-preset': {
          const run = runs.get(id);
          const next = args[1];
          if (!run || !['default', 'auto', 'full'].includes(next)) throw new Error('invalid-run-preset');
          run.setPreset(next);
          break;
        }
        case 'browser:result': {
          const command = commands.get(args[0]);
          if (!command || command.client !== connection) throw new Error('expired');
          command.finish(args[1]);
          break;
        }
        case 'model:complete':
          if (runs.has(id) || runs.size >= 4 || !/^[a-f0-9-]{36}$/i.test(args[0])) throw new Error('busy');
          await streamModel(res, connection, args, id);
          return;
        default:
          return reply(404, { ok: false, error: 'unknown-operation' });
      }
      reply(200, { ok: true, value });
    } catch (error) {
      if (!res.headersSent) reply(400, { ok: false, error: error.code || 'edge-request', message: error.message });
      else res.end();
    }
  });

  async function streamModel(res, connection, [runId, input, target, preset], id) {
    let permissionPreset = ['default', 'auto', 'full'].includes(input?.permissionPreset)
      ? input.permissionPreset : ['auto', 'full'].includes(preset) ? preset : 'default';
    const runApprovals = {
      ask: async (sender, request, signal) => permissionPreset === 'full'
        ? (signal?.aborted ? 'deny' : 'once')
        : approvals.ask(sender, request, signal),
    };
    const controller = new AbortController();
    const approvalIds = new Set();
    // 每轮一份账本：扩展通信、工具、模型、人工等待都记在同一份 summary 里。
    const timing = createTimingLedger({ label: 'edge' });
    // 观察结果去重：同一个页面版本只采一次（见 edge-observation.cjs）。
    const observations = createObservationCache();
    let baselineReady = false;
    let lastObservation = null;
    const run = {
      controller,
      setPreset(next) {
        permissionPreset = next;
        if (next !== 'full' || controller.signal.aborted) return;
        for (const approvalId of approvalIds) {
          if (approvals.respond(approvalId, 'once', connection.token)) {
            send('approval:close', { id: approvalId });
          }
        }
        approvalIds.clear();
      },
    };
    runs.set(id, run);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const send = (type, value) => {
      if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify({ type, value }) + '\n');
    };
    const sender = {
      id: connection.token,
      isDestroyed: () => res.destroyed,
      send: (event, ...args) => {
        if (event === 'ask:request') run.askId = args[0].id;
        if (event === 'approval:request' && !args[0].explicitPlan) approvalIds.add(args[0].id);
        if (event === 'approval:close') approvalIds.delete(args[0].id);
        send(event, event === 'model:delta' ? args[1] : args[0]);
      },
    };
    run.sender = sender;
    // The existing model adapter owns cancellation and all model credentials.
    const abort = () => { void handlers['model:cancel'](sender, runId); };
    controller.signal.addEventListener('abort', abort, { once: true });
    res.once('close', () => controller.abort());
    const dispatch = (operation, input) => new Promise((resolve, reject) => {
      const signal = controller.signal;
      signal.throwIfAborted();
      const startedAt = Date.now();
      const commandId = randomUUID();
      const mayHaveWritten = ['act', 'visual_pointer', 'upload_file', 'plan'].includes(operation);
      const finish = result => {
        clearTimeout(timer);
        commands.delete(commandId);
        signal.removeEventListener('abort', cancel);
        const ms = Date.now() - startedAt;
        if (result?.ok) {
          timing.span('edge', operation, ms, { ok: true });
          resolve(result.value);
          return;
        }
        const error = Object.assign(new Error(result?.error || 'Edge 网页操作已中断'), {
          code: result?.code || 'edge-command-failed', suggestion: result?.suggestion, detail: result?.detail,
        });
        // 写操作超时 = 结果未确定，语义和「确定失败」分开（见 timing.classifyFailure）。
        timing.fail('edge', operation, ms, error, { mayHaveWritten });
        reject(error);
      };
      const cancel = () => finish();
      const waitsForAccess = operation === 'request_tab_access' ||
        (permissionPreset === 'full' && ['open_tab', 'snapshot', 'read', 'visual_screenshot'].includes(operation));
      const seconds = waitsForAccess ? 120 : 35;
      const timer = setTimeout(() => finish({
        error: `Edge did not answer ${operation} within ${seconds} seconds.`,
        code: mayHaveWritten ? 'action-result-unknown' : 'edge-command-timeout',
        suggestion: mayHaveWritten ? '先读取页面状态。动作可能已执行，避免重复提交。' : '检查侧栏是否仍打开，再重试。',
      }), seconds * 1000);
      commands.set(commandId, { finish, client: connection });
      signal.addEventListener('abort', cancel, { once: true });
      send('browser:command', { id: commandId, operation, input });
    });
    let handedOff = false;
    const page = async (operation, args) => {
      if (handedOff) throw new Error('用户已接管网页');
      return dispatch(operation, args);
    };
    const files = fileDirectory && createEdgeFiles({ directory: fileDirectory, approvals: runApprovals, sender, signal: controller.signal });
    function makeTool(emit) {
      const tool = (name, label, description, properties, required, execute) => ({
        name, label, description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        async execute(id, args) {
          emit?.({ type: 'tool', id, name, label, status: 'running' });
          const startedAt = Date.now();
          try {
            const result = await execute(args);
            timing.span('tool', name, Date.now() - startedAt, { ok: true });
            emit?.({ type: 'tool', id, name, label, status: 'done' });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (error) {
            timing.fail('tool', name, Date.now() - startedAt, error);
            emit?.({ type: 'tool', id, name, label, status: 'error', detail: error.message });
            const verdict = classifyFailure(error, error?.detail);
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({
              ok: false, code: verdict.code, outcome: verdict.outcome,
              ...(verdict.indeterminate ? { indeterminate: true } : {}),
              message: error.message,
              suggestion: error.suggestion || verdict.advice || undefined,
              detail: error.detail,
            }) }] };
          }
        },
      });
      return tool;
    }
    function fileTools(emit) {
      if (!files) return [];
      const tool = makeTool(emit);
      const pathArg = { type: 'string', description: 'Relative to the Edge workspace, or an absolute local path requiring approval outside the workspace.' };
      const refArg = { type: 'string', description: 'Element reference from the latest browser_snapshot.' };
      return [
        tool('edge_files', 'Edge 文件', 'List folders, read or write UTF-8 files, create a folder, move a file, or delete a file or empty folder. Outside paths require per-operation approval.', {
          action: { type: 'string', enum: ['list', 'read', 'write', 'mkdir', 'move', 'delete'] },
          path: pathArg, destination: pathArg, text: { type: 'string' },
        }, ['action', 'path'], args => files.execute(args)),
        tool('browser_download', '下载网页文件', 'Download a same-origin link from the authorized Edge page into a file. Existing files are never overwritten. Limit 8 MiB.', {
          target: refArg, path: pathArg,
        }, ['target', 'path'], async args => {
          const [file] = await files.authorize('下载到', [args.path]);
          const downloaded = await page('download_file', { target: args.target });
          if (typeof downloaded.data !== 'string' || downloaded.data.length > Math.ceil(MAX_TRANSFER / 3) * 4) {
            throw new Error('Invalid or oversized download.');
          }
          const bytes = Buffer.from(downloaded.data, 'base64');
          if (bytes.length > MAX_TRANSFER) throw new Error('Download exceeds 8 MiB.');
          await files.write(file, bytes);
          return { ok: true, path: args.path, bytes: bytes.length };
        }),
        tool('browser_upload', '上传网页文件', 'Select one file for a file input on the authorized Edge page. The page may upload it immediately. This requires approval for the web action. Limit 8 MiB.', {
          target: refArg, path: pathArg,
        }, ['target', 'path'], async args => {
          const preview = await page('preview_upload', { target: args.target });
          const [file] = await files.authorize('读取上传文件', [args.path]);
          const decision = await runApprovals.ask(sender, {
            capability: 'exec', allowSession: false, message: `向 ${preview.origin} 提供文件`,
            detail: [file, preview.label, preview.formAction].filter(Boolean).join('\n').slice(0, 2000),
          }, controller.signal);
          if (decision !== 'once') throw new Error('Upload was denied or expired.');
          const bytes = await files.read(file, MAX_TRANSFER);
          const result = await page('upload_file', {
            target: args.target, ticket: preview.ticket, name: basename(file), data: bytes.toString('base64'),
          });
          const snapshot = await page('snapshot', { mode: 'diff' }).catch(error => ({ mode: 'unavailable', message: error.message }));
          const summary = await page('form_summary', {}).catch(error => ({ unavailable: true, code: error.code, message: error.message }));
          return { ok: true, selected: result.selected, bytes: bytes.length, snapshot, summary: { ...summary, phase: 'after' } };
        }),
      ];
    }
    const receipt = async ({ summary = true } = {}) => {
      // 一次 diff 就能同时得到「页面版本」和「改了什么」，所以这一步不能省；
      // 但表单摘要在同一版本下只取一次（它要扫全页表单，是这里最贵的一项）。
      const snapshot = await page('snapshot', { mode: 'diff' }).catch(error => ({
        mode: 'unavailable', code: error.code, message: error.message,
      }));
      baselineReady = true;
      const key = observationKeyOf(snapshot);
      const cached = summary ? observations.lookup(key) : null;
      if (!summary) return { snapshot };
      const form = cached?.summary || await page('form_summary', {}).catch(error => ({ unavailable: true, code: error.code, message: error.message }));
      const value = { snapshot, summary: { ...form, phase: 'after' }, ...(cached ? { reused: true } : {}) };
      observations.remember({ ...key, snapshot, summary: { ...form, phase: 'after' } });
      // 只有真的读到了快照才允许「复用最新观察」：采集失败时不能让批处理把错误当成页面结果。
      if (snapshot.mode !== 'unavailable' && typeof snapshot.text === 'string') {
        lastObservation = { at: Date.now(), snapshot };
      }
      return value;
    };
    async function observedState(phase) {
      const snapshot = await page('snapshot', { mode: 'full' });
      const summary = await page('form_summary', {});
      baselineReady = true;
      const key = observationKeyOf(snapshot);
      observations.remember({ ...key, snapshot, summary: { ...summary, phase } });
      return { snapshot, summary: { ...summary, phase } };
    }
    /** 动作前只需要一次基线：page.js 自己记得上一份快照，重复全量快照纯属浪费。 */
    async function ensureBaseline() {
      if (baselineReady) return;
      await page('snapshot', { mode: 'full' });
      baselineReady = true;
    }
    async function refreshViewport(error) {
      try {
        const { data, mimeType, ...screenshot } = await page('visual_screenshot', {});
        error.detail = { screenshot };
        if (data) error.image = { type: 'image', data, mimeType };
      } catch (refreshError) {
        error.detail = { refreshError: refreshError.message };
      }
    }
    // 只有「必须本人完成」的目标才停手（银行卡、扫码支付、密码/验证码）；
    // 购买、下单、支付按钮属于正常购物流程，仍然由审批与权限档位控制。
    const riskOf = (args, preview) => classifyAction({
      action: args.action, target: preview.label, url: preview.origin,
    });
    /**
     * @param {object} args
     * @param {object} [approvedStep]
     * @param {{observe?: 'step'|'none', summary?: boolean}} [options]
     *   observe:'none' 用于批处理中间步骤——动作照做，但把观察推迟到最后一步，
     *   一次批处理因此从「每步 3 次采集」降到「整批 2 次」。
     */
    const act = async (args, approvedStep, options = {}) => {
      const preview = await page('preview', args);
      const risk = riskOf(args, preview);
      if (risk.handoff) {
        return {
          ok: false,
          status: 'requires-handoff',
          reason: risk.handoffReason,
          message: `${handoffLabelOf(risk.handoffReason)}；请调用 browser_handoff 交给用户完成这一步。`,
        };
      }
      if (approvedStep && (approvedStep.label !== preview.label || approvedStep.origin !== preview.origin ||
          approvedStep.documentId !== preview.documentId || approvedStep.displayValue !== preview.proposedValue ||
          approvedStep.resolvedValue !== preview.resolvedValue)) {
        throw Object.assign(new Error('Approved target changed. No action was performed.'), { code: 'preview-changed', suggestion: '重新预演和确认。' });
      }
      // 自动档位：普通交互（等级 ≤2，且不是「必须本人完成」）不再逐次打断，
      // 买/下单/支付按钮就在这一档；不可逆动作（等级 3）仍然询问。
      const autoOrdinary = permissionPreset === 'auto' && risk.level <= 2;
      if (!autoOrdinary && !approvedStep) {
        const decision = await runApprovals.ask(sender, {
          capability: 'exec', allowSession: false, message: `在 ${preview.origin} 操作网页`,
          detail: [args.action, preview.label, args.value].filter(Boolean).join(' · ').slice(0, 800),
        }, controller.signal);
        if (decision !== 'once') throw new Error('用户拒绝了此网页操作');
      }
      await ensureBaseline();
      let performed;
      if (args.action === 'click' && preview.nativePoint) {
        // Canvas needs a native click. Route before any DOM click is dispatched.
        const view = await page('visual_screenshot', {});
        const coordinates = { action: 'click', viewId: view.viewId, ...preview.nativePoint };
        const visual = await page('visual_preview', coordinates);
        if (visual.blocked || visual.labels[0] !== preview.label) {
          throw Object.assign(new Error('The canvas target changed before clicking.'), { code: 'preview-changed', suggestion: '重新截图后定位目标。' });
        }
        performed = await page('visual_pointer', { ...coordinates, labels: visual.labels });
      } else {
        performed = await page('act', { ...args, ticket: preview.ticket });
      }
      let verification;
      if (args.expect) {
        const condition = args.expect;
        const check = condition.selector ? 'selector' : condition.text ? 'text' : condition.url ? 'url' : null;
        if (check) {
          try {
            verification = await page('wait', { ...condition, for: check });
          } catch (error) {
            verification = { matched: false, message: error.message };
          }
        }
      }
      if (options.observe === 'none') {
        return { ...performed, verification, deferred: true };
      }
      return { ...performed, verification, ...await receipt({ summary: options.summary !== false }) };
    };
    let preparedPlan;
    function workflowTools(emit) {
      const tool = makeTool(emit);
      const fields = {
        action: { type: 'string', enum: ['click', 'fill', 'type', 'select', 'check'] },
        target: { type: 'string', description: 'Element reference from browser_snapshot.' },
        value: { type: 'string' },
      };
      const probe = async args => {
        const preview = await page('preview', { ...args, preflight: true });
        const risk = riskOf(args, preview);
        const handoff = risk.handoff === true;
        return {
          ...preview,
          summary: { ...preview.summary, phase: 'before' },
          writable: !handoff,
          requiresHandoff: handoff,
          requiresApproval: !handoff && permissionPreset !== 'full' &&
            !(permissionPreset === 'auto' && risk.level <= 2),
        };
      };
      return [
        tool('browser_test_page', '隔离网页测试', 'Open or close Mova’s local test fixture in a separate Edge window. No external site is opened. The window is cleaned up at the end of the run.', {
          action: { type: 'string', enum: ['open', 'close'] },
        }, ['action'], args => {
          if (!['open', 'close'].includes(args.action)) throw new Error('Choose open or close.');
          return page(args.action === 'open' ? 'test_page_open' : 'test_page_close', {});
        }),
        tool('browser_preflight', '探测网页写入', 'Check whether a particular write action is possible without changing the page. Read and scroll success do not imply write access.', fields, ['action', 'target'], probe),
        tool('browser_plan', '预演网页操作', 'Preview a sequence of form edits before changing anything. Commit the returned planId to request one approval for the sequence. Sensitive actions stop for manual handoff.', {
          mode: { type: 'string', enum: ['preview', 'commit'] },
          planId: { type: 'string' },
          steps: {
            type: 'array', minItems: 1, maxItems: 12,
            items: { type: 'object', properties: fields, required: ['action', 'target'], additionalProperties: false },
          },
        }, ['mode'], async args => {
          if (args.mode === 'preview') {
            if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 12) throw new Error('Provide 1–12 steps.');
            const steps = [];
            let before;
            let fixture = false;
            for (const [index, step] of args.steps.entries()) {
              const preview = await probe(step);
              before ??= preview.summary;
              fixture = preview.fixture === true;
              steps.push({
                index, action: step.action, target: step.target, value: step.value,
                label: preview.label, displayValue: preview.proposedValue, resolvedValue: preview.resolvedValue,
                fieldKey: preview.fieldKey, elementId: preview.elementId, origin: preview.origin,
                documentId: preview.documentId, requiresHandoff: preview.requiresHandoff,
              });
            }
            const projected = projectPlan(before, steps, fixture);
            preparedPlan = { id: randomUUID(), steps, before, projected, expires: Date.now() + 120_000 };
            return { planId: preparedPlan.id, steps, before, projected, summary: before };
          }
          if (args.mode !== 'commit' || !preparedPlan || preparedPlan.id !== args.planId || preparedPlan.expires < Date.now()) {
            throw Object.assign(new Error('Plan is missing or expired.'), { code: 'plan-stale', suggestion: '重新预演。' });
          }
          const plan = preparedPlan;
          preparedPlan = undefined;
          const detail = plan.steps.map(step =>
            `${step.index + 1}. ${step.action} ${step.label}${step.value === undefined ? '' : ` → ${step.displayValue ?? step.value}`}${step.requiresHandoff ? '（人工操作）' : ''}`).join('\n');
          if (detail.length > 6000) throw new Error('Split the plan into shorter sequences so every step is visible for approval.');
          const decision = await approvals.ask(sender, {
            capability: 'exec', allowSession: false, explicitPlan: true, message: '确认执行已预演的网页操作',
            detail: [plan.steps[0].origin, detail,
              `当前价格：${plan.before.prices?.join(' / ') || '未检测到'}`,
              `预计价格：${plan.projected.prices?.join(' / ') || '页面更新后才能确认'}`,
            ].join('\n'),
          }, controller.signal);
          if (decision !== 'once') return { ok: false, code: 'approval-denied', applied: [] };
          const baseline = await observedState('before');
          if (diffObserved({ summary: plan.before }, { summary: baseline.summary }).snapshot.changed) {
            throw Object.assign(new Error('确认期间页面状态已变化，计划未执行。'), { code: 'preview-changed', suggestion: '重新预演并确认当前字段与价格。' });
          }
          const applied = [];
          async function finalState(requireChange = false) {
            let after;
            let diff;
            try {
              for (let attempt = 0; attempt < 4; attempt += 1) {
                // 固定 120 ms 换成条件等待：等页面稳定再观察，动画没停也不会白等。
                if (attempt) await page('wait', { for: 'settle', quietMs: 120, timeout: 800 }).catch(() => ({ matched: false }));
                after = await observedState('after');
                diff = diffObserved(baseline, after);
                if (diff.snapshot.changed || !requireChange) break;
              }
            } catch (error) {
              if (!requireChange) return { before: baseline.summary, ...await receipt() };
              throw Object.assign(new Error('动作已发送，但无法读取执行后的页面状态。'), {
                code: 'commit-state-unavailable', suggestion: '先核对网页，不要重新提交。',
                detail: { applied, before: baseline.summary, underlyingCode: error.code },
              });
            }
            if (requireChange && !diff.snapshot.changed) {
              throw Object.assign(new Error('页面收到操作，但实际前后状态没有可验证变化。'), {
                code: 'commit-no-observable-change', suggestion: '核对页面真实状态，不要盲目重复提交。',
                detail: { applied, before: baseline.summary, after: after.summary },
              });
            }
            if (!diff.snapshot.changed) diff.snapshot.text = '未观察到状态变化。';
            return { before: baseline.summary, after: after.summary, summary: after.summary, ...diff };
          }
          for (const step of plan.steps) {
            if (step.requiresHandoff) return { ok: false, code: 'requires-handoff', applied, next: step, ...await finalState() };
            try {
              // 中间步骤不逐个观察：整段执行完由 finalState 统一观察一次。
              const outcome = await act(step, step, { observe: 'none' });
              if (outcome.ok === false) return { ...outcome, applied, next: step, ...await finalState() };
              applied.push({ index: step.index, action: step.action, label: step.label, noOp: outcome.noOp === true });
            } catch (error) {
              return { ok: false, code: error.code || 'plan-step-failed', message: error.message, suggestion: error.suggestion,
                applied, next: step, ...await finalState() };
            }
          }
          return { ok: true, applied, ...await finalState(applied.some(step => !step.noOp)) };
        }),
      ];
    }
    /** 批处理收尾快照：最后一步刚观察过就直接复用，避免同一页面再采一遍。 */
    async function batchSnapshot(args = {}) {
      if (lastObservation && Date.now() - lastObservation.at < 1500 && args.mode !== 'full' &&
          typeof lastObservation.snapshot.text === 'string') {
        timing.span('edge', 'snapshot-reused', 0, { ok: true });
        return { mode: lastObservation.snapshot.mode || 'diff', text: lastObservation.snapshot.text };
      }
      return page('snapshot', args);
    }
    /** Edge 的内容脚本不支持 action.submit（回车提交由页面自己决定），参数里去掉它。 */
    function withoutSubmit(properties = {}) {
      const { submit, ...rest } = properties;
      void submit;
      return rest;
    }
    /**
     * 授权 / 打开标签后顺手带回页面结构：这两步之后模型通常立刻要「看一眼」，
     * 合并进同一个结果就少一次完整往返（P1）。失败不影响主结果。
     */
    async function observationFor(reason) {
      try {
        await page('wait', { for: 'settle', quietMs: 150, timeout: 3000 }).catch(() => ({ matched: false }));
        const snapshot = await page('snapshot', { mode: 'full' });
        baselineReady = true;
        const key = observationKeyOf(snapshot);
        observations.remember({ ...key, snapshot });
        if (typeof snapshot.text === 'string') lastObservation = { at: Date.now(), snapshot };
        return {
          observation: {
            mode: snapshot.mode,
            text: snapshot.text,
            chars: typeof snapshot.text === 'string' ? snapshot.text.length : 0,
            ...(Array.isArray(snapshot.frames) && snapshot.frames.length ? { frames: snapshot.frames } : {}),
          },
        };
      } catch (error) {
        timing.fail('edge', `observe:${reason}`, 0, error);
        return { observation: { mode: 'unavailable', code: error?.code || 'snapshot-failed', message: error.message } };
      }
    }
    const edgeBrowser = {
      tools: ({ emit }) => [...fileTools(emit), ...workflowTools(emit), {
        name: 'browser_open_tab',
        label: '打开分组标签页',
        description: 'Open an HTTP(S) URL in a new tab in the Mova Agent group. Use the returned tabId with browser_group_tabs action=authorize to request page access in this turn.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
        async execute(id, args) {
          const name = 'browser_open_tab';
          const label = '打开分组标签页';
          emit?.({ type: 'tool', id, name, label, status: 'running' });
          let code = 'invalid-url';
          try {
            const url = new URL(args.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
              throw new Error('Only HTTP and HTTPS pages without embedded credentials can be opened.');
            }
            code = 'approval-failed';
            const decision = await runApprovals.ask(sender, {
              capability: 'exec', allowSession: false,
              message: '在 Mova Agent 分组中打开标签页',
              detail: url.href.slice(0, 800),
            }, controller.signal);
            code = 'approval-denied-or-expired';
            if (decision !== 'once') throw new Error('Tab opening was declined, cancelled, or the approval expired.');
            code = 'edge-open-tab-failed';
            const result = await page('open_tab', { url: url.href });
            // 已经是 full 档并自动绑定成功时，顺手带回页面结构：省掉模型单独一次快照往返。
            if (result && result.requiresAuthorization === false) {
              Object.assign(result, await observationFor('open_tab'));
            }
            emit?.({ type: 'tool', id, name, label, status: 'done' });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          } catch (error) {
            emit?.({ type: 'tool', id, name, label, status: 'error', detail: error.message });
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message: error.message }) }] };
          }
        },
      }, {
        name: 'browser_group_tabs',
        label: '分组标签页',
        description: 'List, select or authorize Agent-created tabs in the Mova group. Use authorize with a grouped tabId or omit tabId to authorize the current ungrouped page. After Edge grants access the page is bound to this turn and its structure is returned as observation, so no extra browser_snapshot is needed to start.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'select', 'authorize'] },
            tabId: { type: 'integer' },
            observe: { type: 'boolean', description: 'Default true for select/authorize: include the page snapshot. false skips it.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        async execute(_id, args) {
          if ((args.action === 'select' || args.tabId !== undefined) && !Number.isInteger(args.tabId)) throw new Error('Use a numeric tabId.');
          const operation = new Map([
            ['list', 'group_tabs'], ['select', 'select_group_tab'], ['authorize', 'request_tab_access'],
          ]).get(args.action);
          if (!operation) throw new Error('Choose list, select, or authorize.');
          const result = await page(operation, args);
          if (args.action !== 'list' && args.observe !== false && result?.authorized !== false) {
            Object.assign(result, await observationFor(args.action));
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        },
      }, {
        name: 'browser_close_tab',
        label: '关闭分组标签页',
        description: 'Close an Agent-created tab in this window’s Mova Agent group. Page authorization is unnecessary.',
        parameters: {
          type: 'object',
          properties: { tabId: { type: 'integer' } },
          required: ['tabId'],
          additionalProperties: false,
        },
        async execute(_id, args) {
          const result = await page('close_tab', args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        },
      }, ...createBrowserTools({
        emit,
        snapshot: args => page('snapshot', args),
        screenshot: args => args.mode === 'none' ? { skipped: true } : page('visual_screenshot', {}),
        pointer: async args => {
          let preview;
          try {
            preview = await page('visual_preview', args);
          } catch (error) {
            if (error.code === 'viewport-stale') await refreshViewport(error);
            throw error;
          }
          const labels = preview.labels.join(' → ');
          if (preview.blockedCode && preview.blockedCode !== 'requires-handoff') {
            const suggestion = preview.blockedCode === 'element-in-iframe' ? '打开该 iframe 对应页面或交给用户。'
              : preview.blockedCode === 'element-disabled' ? '先满足表单前置条件。'
              : preview.blockedCode === 'element-ref-available'
                ? `请用 browser_act 点击${preview.ref ? `元素引用 ${preview.ref}` : '快照中的元素引用'}。`
                : '重新截图并定位可见控件。';
            throw Object.assign(new Error(preview.blockedCode === 'element-ref-available' ? '该控件可用元素引用，请改用 ref 点击。' : '坐标下的目标不可交互。'), {
              code: preview.blockedCode, suggestion, detail: preview.ref ? { ref: preview.ref } : undefined,
            });
          }
          const labelRisk = classifyAction({ action: args.action, target: labels, url: preview.origin });
          if (preview.blocked || labelRisk.handoff) {
            if (labelRisk.handoff) {
              return {
                ok: false, status: 'requires-handoff', reason: labelRisk.handoffReason,
                message: `${handoffLabelOf(labelRisk.handoffReason)}；请调用 browser_handoff 交给用户完成这一步。`,
              };
            }
            return { ok: false, status: 'requires-handoff', message: 'This target requires manual control.' };
          }
          const decision = await runApprovals.ask(sender, {
            capability: 'exec', allowSession: false, message: `在 ${preview.origin} 执行网页鼠标操作`,
            detail: [args.action, labels, `(${args.x}, ${args.y})`, args.action === 'drag' ? `→ (${args.endX}, ${args.endY})` : ''].filter(Boolean).join(' · ').slice(0, 800),
          }, controller.signal);
          if (decision !== 'once') throw new Error('Pointer action was denied or expired.');
          await ensureBaseline();
          try {
            const outcome = await page('visual_pointer', { ...args, labels: preview.labels });
            return { ...outcome, ...await receipt() };
          } catch (error) {
            if (error.code === 'viewport-stale') await refreshViewport(error);
            throw error;
          }
        },
        read: args => page('read', args),
        wait: args => page('wait', args),
        handoff: async args => {
          const result = await dispatch('handoff', { tabId: args.tabId });
          handedOff = true;
          return { ok: true, ...result };
        },
        getUrl: () => target?.origin,
        getPrefs: () => ({ tier: 'read' }),
        approve: async () => 'once',
        act,
        batch: (steps, options) => {
          if (options.recipe || steps.some(step => step.op === 'navigate')) throw new Error('Edge 批处理只支持当前页面内的步骤');
          // 中间步骤不逐个观察：一次批处理只需要「一次基线 + 一次结果」，
          // 而不是每一步都「全量快照 + diff + 表单摘要」。
          const prepared = steps.map((step, index) => ({
            ...step, _observe: index === steps.length - 1 ? 'step' : 'none',
          }));
          return runBatch({
            act: args => act(args, null, { observe: args._observe === 'none' ? 'none' : 'step' }),
            snapshot: batchSnapshot,
            wait: args => page('wait', args),
          }, prepared, options);
        },
        timing,
      }).filter(tool => allowedTools.has(tool.name)).map(tool => ({
        ...tool,
        parameters: tool.name === 'browser_screenshot' ? {
          type: 'object',
          properties: {
            includeInResult: { type: 'boolean', description: 'Attach the screenshot to the tool result. Defaults to true.' },
          },
          additionalProperties: false,
        } : tool.name === 'browser_act' ? {
          ...tool.parameters,
          properties: {
            ...withoutSubmit(tool.parameters.properties),
            action: { type: 'string', enum: ['click', 'fill', 'type', 'select', 'check', 'scroll', 'press'] },
            target: { type: 'string', description: 'Snapshot reference. Omit only for document scroll.' },
          },
        } : tool.name === 'browser_snapshot' ? {
          ...tool.parameters,
          properties: {
            ...tool.parameters.properties,
            frames: { type: 'string', enum: ['none', 'index', 'all'], description: 'index (default) lists iframes only, all inlines them, none skips frames.' },
            frame: { type: 'string', description: 'Frame id from a previous snapshot (f1, f2, ...) to read that iframe only. Cross-origin frames are reported, not read.' },
            ref: { type: 'string', description: 'Only return the subtree of this @e ref when the page is too large.' },
          },
        } : tool.name === 'browser_wait' ? {
          ...tool.parameters,
          properties: {
            ...tool.parameters.properties,
            for: { type: 'string', enum: ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame'] },
          },
        } : tool.name === 'browser_handoff' ? {
          ...tool.parameters,
          properties: {
            ...tool.parameters.properties,
            reason: { type: 'string', enum: [...tool.parameters.properties.reason.enum, 'authorization'] },
            tabId: { type: 'integer', description: 'Optional tab from browser_group_tabs. Omit to hand off the current page.' },
          },
        } : tool.parameters,
        description: tool.name === 'browser_screenshot'
          ? 'Capture a JPEG of the authorized Edge viewport for a vision model. Use its viewId with browser_pointer for canvas or other elements without useful semantic refs.'
          : tool.name === 'browser_act'
          ? 'Click, fill, type, select, check, scroll or dispatch a limited key on the authorized Edge page. Use an @e ref from browser_snapshot. For document scrolling omit target and pass signed pixels as value. There is no submit flag here: click the page\'s own confirm/buy button instead. The result already contains the diff and form summary, so do not call browser_snapshot again just to verify. Never send credentials.'
          : tool.name === 'browser_batch'
            ? 'Run up to 30 steps on the authorized Edge page in one call. Use click, fill, type, select, check and wait with refs from browser_snapshot. Intermediate steps are observed once at the end, so the result carries the diff of the whole sequence. Approval applies to each write unless the current permission preset already allows it.'
            : tool.name === 'browser_handoff'
              ? 'Give the user control of the current ungrouped page or an Agent-created grouped tab and stop browser operations for this turn. For authorization with same-turn continuation, use browser_group_tabs with action=authorize.'
              : tool.description,
      }))],
      // 让 chat-agent 复用这一轮的账本（模型耗时也记进同一份 summary）。
      timing,
      observations,
    };
    try {
      const request = {
        mode: 'ChatMova', permissionPreset, temporary: input.temporary === true, memoryScope: { projectId: null, includeGlobal: true },
        provider: input.provider, model: input.model, thinking: input.thinking, messages: input.messages,
        attachments: input.attachments, requireCurrentImages: input.requireCurrentImages === true, search: input.search === true,
      };
      await handlers['model:complete'](sender, runId, request, { webContents: sender }, edgeBrowser, controller.signal, runApprovals);
      send('result', { ok: true });
    } catch (error) {
      send('result', { ok: false, error: error.code || 'network', message: error.message });
    } finally {
      runs.delete(id);
      controller.abort();
      res.end();
    }
  }

  server.on('error', error => console.warn('Mova Edge bridge:', error.message));
  server.listen(PORT, '127.0.0.1');
  return {
    pair() {
      pairing = { code: randomBytes(12).toString('hex'), expires: Date.now() + 300_000 };
      return pairing.code;
    },
    close() {
      cancelClient();
      server.close();
    },
  };
}

module.exports = { startEdgeBridge };
