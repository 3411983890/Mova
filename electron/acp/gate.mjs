/**
 * ACP 反向请求闸门：CLI 请求，Mova 执行。
 *
 * 负责：把 fs/read_text_file、fs/write_text_file、terminal/*、session/request_permission、
 * elicitation/create 翻译成「能力检查 → 审批 → 审计 → 真正执行」。
 * 不负责：JSON-RPC 成帧（client.mjs）与 ACP 事件映射（chat-agent.mjs）。
 * 被 client.onRequest(gate.handle) 挂进 ACP 客户端；
 *   技能层（electron/skills/host-adapters.mjs）复用返回值里的 `resolveInRoots`，不复制路径算法。
 *
 * 依赖注入（简报 §2.6）：permissions/approvals/elicitation/audit/fs/realpath/spawnProcess。
 * - permissions：能力层，`{ check(input)|has(input)|authorize(input) }` 或直接函数，
 *   返回 boolean 或 `{ ok } / { allowed }`；未注入 = 只靠审批层拦。
 * - approvals.ask(request, signal) 返回 'once'|'session'|'deny'|true|false 或 `{ optionId }`。
 * - audit.record(entry)（也接受直接是函数，兼容 permissions.cjs 的 createAuditLog）。
 */
import { isAbsolute, dirname, resolve as resolvePath, sep } from 'node:path';
import { readFile as hostReadFile, writeFile as hostWriteFile, realpath as hostRealpath } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { SubscriptionError } from '../subscription/contract.mjs';
import { isMovaMcpTool } from './mcp-mount.mjs';

/** 单次 terminal/output 的字节上限（§11.1「输出限流」）。 */
const OUTPUT_LIMIT = 8 * 1024;
/** 累积缓冲的字符上限；超出的头部丢掉，只保留尾部上下文。 */
const OUTPUT_BUFFER = 64 * 1024;
const DIFF_LINES = 20;
const PRESETS = ['default', 'auto', 'full'];
const ALLOW_WORDS = ['once', 'session', 'allow', 'allowed', 'approve', 'approved', 'accept', 'yes', 'allow_once', 'allow_always'];
const DENY_WORDS = ['deny', 'denied', 'reject', 'rejected', 'cancel', 'cancelled', 'decline', 'no', 'dismiss'];
const ELICIT_ACTIONS = ['accept', 'decline', 'cancel'];

export function createGate({
  permissions, approvals, elicitation, projectRoots, preset, audit,
  fs, realpath, now = Date.now, spawnProcess = nodeSpawn,
} = {}) {
  const roots = Array.isArray(projectRoots)
    ? projectRoots.filter(item => typeof item === 'string' && item.trim()).map(item => resolvePath(item))
    : [];
  // 未知 preset 一律当 default：宁可多问一次，也不要静默升级成免审批。
  const mode = PRESETS.includes(preset) ? preset : 'default';
  const hostFs = fs && typeof fs.readFile === 'function' && typeof fs.writeFile === 'function' ? fs : { readFile: hostReadFile, writeFile: hostWriteFile };
  const resolveReal = typeof realpath === 'function' ? realpath : hostRealpath;
  const terminals = new Map();
  let terminalSeq = 0;

  function refuse(method, detail) {
    // 错误文案必须带 method：上层要能一眼判断是哪个通道被拒（detail 会被 UI 展示）。
    const error = new SubscriptionError('request', { detail: `${method}: ${detail}`.slice(0, 400) });
    error.method = method;
    return error;
  }

  function protocol(method, detail) {
    const error = new SubscriptionError('acp_protocol', { detail: `${method}: ${detail}`.slice(0, 400) });
    error.method = method;
    return error;
  }

  function fold(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value;
  }

  function inside(parent, child) {
    const base = fold(resolvePath(parent));
    const target = fold(resolvePath(child));
    return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  }

  async function realpathOrNull(target) {
    try {
      return await resolveReal(target);
    } catch {
      return null;
    }
  }

  async function insideRealRoots(canonical) {
    for (const root of roots) {
      const realRoot = (await realpathOrNull(root)) ?? root;
      if (inside(realRoot, canonical)) return true;
    }
    return false;
  }

  /**
   * 把 CLI 给的路径收敛成根内的真实路径。
   * 1) 字面校验：`..` 已在 resolve 里折叠，绝对越界路径直接拒（不去摸根外的 realpath）；
   * 2) 沿最近的已存在祖先 realpath，拼回剩余段——目标可能还不存在（写新文件），
   *    但任何一段符号链接/junction 都会被祖先 realpath 暴露出来；
   * 3) 真实路径再判一次归属，防「根内链接指向根外」。
   */
  async function resolveInRoots(rawPath, method) {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) throw refuse(method, '缺少合法路径');
    if (!roots.length) throw refuse(method, '没有可用的项目根目录（projectRoots 为空）');
    const base = isAbsolute(rawPath) ? resolvePath(rawPath) : resolvePath(roots[0], rawPath);
    if (!roots.some(root => inside(root, base))) throw refuse(method, `路径越界：${base}`);
    let probe = base;
    let real = await realpathOrNull(probe);
    while (!real) {
      const parent = dirname(probe);
      if (parent === probe) throw refuse(method, `无法解析路径：${base}`);
      probe = parent;
      real = await realpathOrNull(probe);
    }
    const rest = probe === base ? '' : base.slice(probe.length).replace(/^[\\/]+/, '');
    const canonical = rest ? resolvePath(real, rest) : resolvePath(real);
    if (!(await insideRealRoots(canonical))) throw refuse(method, `路径越界（符号链接）：${canonical}`);
    return canonical;
  }

  function verdictAllows(verdict) {
    if (verdict === true) return true;
    if (verdict && typeof verdict === 'object') return verdict.ok === true || verdict.allowed === true;
    return false;
  }

  async function assertCapability(capability, target, method) {
    if (!permissions) return;
    let verdict;
    try {
      if (typeof permissions === 'function') verdict = await permissions({ capability, path: target, method });
      else if (typeof permissions.check === 'function') verdict = await permissions.check({ capability, path: target, method });
      else if (typeof permissions.has === 'function') verdict = await permissions.has({ capability, path: target, method });
      else if (typeof permissions.authorize === 'function') verdict = await permissions.authorize({ capability, path: target, method });
      else return; // 注入的对象形状不认识：不猜，交给审批层
    } catch (error) {
      throw refuse(method, `能力检查失败（${capability}）：${error?.message ?? error}`);
    }
    if (!verdictAllows(verdict)) throw refuse(method, `能力未授权：${capability}`);
  }

  function normalizeDecision(value) {
    if (typeof value === 'string') {
      const word = value.toLowerCase();
      if (ALLOW_WORDS.includes(word)) return 'allow';
      if (DENY_WORDS.includes(word)) return 'deny';
      return 'unknown';
    }
    if (value && typeof value === 'object') {
      if (value.allowed === true || value.ok === true) return 'allow';
      if (typeof value.decision === 'string') return normalizeDecision(value.decision);
    }
    return 'unknown';
  }

  /** 取审批层的原始答复（request_permission 需要 optionId，不能先压成布尔）。 */
  async function askRaw(request, signal, method) {
    if (!approvals || typeof approvals.ask !== 'function') throw refuse(method, '审批通道未注入（approvals.ask）');
    try {
      return await approvals.ask(request, signal);
    } catch (error) {
      if (error instanceof SubscriptionError) throw error;
      throw refuse(method, `审批失败：${error?.message ?? error}`);
    }
  }

  async function recordAudit(entry) {
    if (!audit) return;
    const write = typeof audit.record === 'function' ? audit.record : (typeof audit === 'function' ? audit : null);
    if (!write) return;
    try {
      await write({ at: now(), ...entry });
    } catch { /* 审计失败不能影响已经发生/已被拒的操作 */ }
  }

  function throwIfAborted(signal, method) {
    if (signal?.aborted) throw refuse(method, '请求已取消');
  }

  function buildDiffPreview(path, before, after) {
    const beforeLines = before ? before.split('\n') : [];
    const afterLines = after.split('\n');
    let head = 0;
    while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;
    let tail = 0;
    while (tail < beforeLines.length - head && tail < afterLines.length - head
      && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]) tail += 1;
    const removed = beforeLines.slice(head, beforeLines.length - tail);
    const added = afterLines.slice(head, afterLines.length - tail);
    // 审批卡只要「改了哪里」，不需要完整 patch：截断到变化窗口的头 20 行。
    const lines = [`--- ${path}`, `+++ ${path}`, `@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`];
    for (const line of removed.slice(0, DIFF_LINES)) lines.push(`-${line}`);
    if (removed.length > DIFF_LINES) lines.push(`-…（另有 ${removed.length - DIFF_LINES} 行删除）`);
    for (const line of added.slice(0, DIFF_LINES)) lines.push(`+${line}`);
    if (added.length > DIFF_LINES) lines.push(`+…（另有 ${added.length - DIFF_LINES} 行新增）`);
    return lines.join('\n');
  }

  async function readIfExists(target) {
    try {
      return String(await hostFs.readFile(target, 'utf8'));
    } catch {
      return '';
    }
  }

  async function readTextFile(params, signal, method) {
    throwIfAborted(signal, method);
    const target = await resolveInRoots(params.path, method);
    await assertCapability('read', target, method);
    let text;
    try {
      text = String(await hostFs.readFile(target, 'utf8'));
    } catch (error) {
      throw refuse(method, `读取失败：${error?.code || error?.message || 'unknown'}`);
    }
    const line = Number(params.line);
    const limit = Number(params.limit);
    if (Number.isFinite(limit) && limit > 0) {
      const start = Number.isFinite(line) && line > 0 ? line - 1 : 0;
      return { content: text.split('\n').slice(start, start + limit).join('\n') };
    }
    if (Number.isFinite(line) && line > 0) return { content: text.split('\n').slice(line - 1).join('\n') };
    return { content: text };
  }

  async function writeTextFile(params, signal, method) {
    throwIfAborted(signal, method);
    const target = await resolveInRoots(params.path, method);
    if (typeof params.content !== 'string') throw refuse(method, '缺少 content');
    const content = params.content;
    await assertCapability('write', target, method);
    // 写入前再校验一次路径：审批期间根可能被撤销/替换（文档 §11.1）。
    const canonical = await resolveInRoots(target, method);
    if (mode !== 'full') {
      const before = await readIfExists(canonical);
      const allowed = normalizeDecision(await askRaw({
        capability: 'write',
        path: canonical,
        diff: buildDiffPreview(canonical, before, content),
        method,
        message: `允许修改 ${canonical}？`,
      }, signal, method)) === 'allow';
      if (!allowed) {
        await recordAudit({ action: 'fs/write_text_file', method, path: canonical, preset: mode, decision: 'denied' });
        throw refuse(method, `写入被拒绝：${canonical}`);
      }
    }
    try {
      await hostFs.writeFile(canonical, content, 'utf8');
    } catch (error) {
      throw refuse(method, `写入失败：${error?.code || error?.message || 'unknown'}`);
    }
    await recordAudit({
      action: 'fs/write_text_file',
      method,
      path: canonical,
      preset: mode,
      decision: mode === 'full' ? 'auto' : 'approved',
      bytes: Buffer.byteLength(content, 'utf8'),
    });
    return null;
  }

  function appendOutput(entry, chunk) {
    entry.output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    // 按字符数粗估字节上限即可：这里只防无界增长，精确截断在 terminalOutput 里做。
    if (entry.output.length > OUTPUT_BUFFER) {
      const cut = entry.output.length - OUTPUT_BUFFER;
      entry.output = entry.output.slice(cut);
      entry.dropped += cut;
    }
  }

  function truncateUtf8(text, limit) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= limit) return text;
    let sliced = bytes.subarray(0, limit).toString('utf8');
    if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
    return sliced;
  }

  function terminalOutput(entry) {
    const truncated = entry.dropped > 0 || Buffer.byteLength(entry.output, 'utf8') > OUTPUT_LIMIT;
    const payload = { output: truncated ? truncateUtf8(entry.output, OUTPUT_LIMIT) : entry.output, truncated };
    if (entry.exit) payload.exitStatus = entry.exit;
    return payload;
  }

  function waitForExit(entry, method, signal) {
    if (entry.exit) return Promise.resolve(entry.exit);
    if (typeof entry.child.once !== 'function') throw protocol(method, '终端进程不支持退出监听');
    return new Promise((resolve, reject) => {
      const finish = () => {
        entry.exit = entry.exit ?? { exitCode: null, signal: null };
        resolve(entry.exit);
      };
      entry.child.once('exit', finish);
      entry.child.once('error', finish);
      // 会话被取消时不能把 CLI 永远挂在这里。
      signal?.addEventListener?.('abort', () => reject(refuse(method, '请求已取消')), { once: true });
      if (entry.exit) finish(); // 注册监听前就已退出
    });
  }

  /** ACP 的 env 是 [{name,value}]，spawn 要的是对象；形状不对就当没给（继承父进程）。 */
  function normalizeEnv(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (!Array.isArray(value)) return value;
    const env = {};
    for (const row of value) {
      if (row && typeof row.name === 'string' && row.name) env[row.name] = String(row.value ?? '');
    }
    return Object.keys(env).length ? env : undefined;
  }

  async function createTerminal(params, signal, method) {
    throwIfAborted(signal, method);
    const command = typeof params.command === 'string' ? params.command.trim() : '';
    if (!command) throw refuse(method, '缺少 command');
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    if (!roots.length) throw refuse(method, '没有可用的项目根目录（projectRoots 为空）');
    const cwd = params.cwd ? await resolveInRoots(params.cwd, method) : roots[0];
    await assertCapability('exec', cwd, method);
    const commandLine = [command, ...args].join(' ');
    if (mode !== 'full') {
      const allowed = normalizeDecision(await askRaw({
        capability: 'exec',
        command: commandLine,
        path: cwd,
        method,
        message: `允许执行命令：${commandLine}`,
      }, signal, method)) === 'allow';
      if (!allowed) {
        await recordAudit({ action: 'terminal/create', method, command: commandLine, cwd, preset: mode, decision: 'denied' });
        throw refuse(method, `命令执行被拒绝：${commandLine}`);
      }
    }
    let spawned;
    try {
      spawned = spawnProcess(command, args, { cwd, env: normalizeEnv(params.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      throw refuse(method, `启动失败：${error?.code || error?.message || 'unknown'}`);
    }
    if (!spawned || typeof spawned !== 'object') throw protocol(method, 'spawnProcess 返回了空进程');
    terminalSeq += 1;
    const entry = { id: `acp-term-${terminalSeq}`, child: spawned, output: '', dropped: 0, exit: null, startedAt: now() };
    spawned.stdout?.on?.('data', chunk => appendOutput(entry, chunk));
    spawned.stderr?.on?.('data', chunk => appendOutput(entry, chunk));
    spawned.on?.('exit', (code, sig) => { entry.exit = { exitCode: code ?? null, signal: sig ?? null }; });
    spawned.on?.('error', error => {
      entry.exit = { exitCode: null, signal: null };
      appendOutput(entry, `\n[启动失败] ${error?.message ?? 'unknown'}`);
    });
    signal?.addEventListener?.('abort', () => { try { entry.child.kill?.(); } catch { /* ignore */ } }, { once: true });
    terminals.set(entry.id, entry);
    await recordAudit({ action: 'terminal/create', method, command: commandLine, cwd, preset: mode, decision: mode === 'full' ? 'auto' : 'approved' });
    return { terminalId: entry.id };
  }

  async function terminal(method, params, signal) {
    if (method === 'terminal/create') return createTerminal(params, signal, method);
    const id = typeof params.terminalId === 'string' ? params.terminalId : '';
    const entry = terminals.get(id);
    if (!entry) throw refuse(method, `未知的 terminalId：${id || '(空)'}`);
    throwIfAborted(signal, method);
    if (method === 'terminal/output') return terminalOutput(entry);
    if (method === 'terminal/wait_for_exit') return waitForExit(entry, method, signal);
    if (method === 'terminal/kill') {
      try { entry.child.kill?.(); } catch { /* ignore */ }
      await recordAudit({ action: method, terminalId: id });
      return null;
    }
    if (method === 'terminal/release') {
      try { entry.child.kill?.(); } catch { /* ignore */ }
      terminals.delete(id);
      await recordAudit({ action: method, terminalId: id });
      return null;
    }
    throw protocol(method, '不支持的 terminal 子命令');
  }

  function pickOptionId(decision, options, method) {
    const ids = options.map(item => item.optionId).filter(id => typeof id === 'string' && id);
    if (decision && typeof decision === 'object' && typeof decision.optionId === 'string') {
      // 审批层直接指定了选项：必须在 CLI 给的里面，否则是接线错误，不能瞎回一个。
      if (!ids.length || ids.includes(decision.optionId)) return decision.optionId;
      throw refuse(method, `审批返回了 options 之外的 optionId：${decision.optionId}`);
    }
    if (typeof decision === 'string' && ids.includes(decision)) return decision;
    if (normalizeDecision(decision) !== 'allow') return '';
    const preferred = options.find(item => typeof item.optionId === 'string' && /allow|approve|accept/i.test(String(item.kind ?? '')));
    return preferred?.optionId ?? ids[0] ?? '';
  }

  async function requestPermission(params, signal, method) {
    throwIfAborted(signal, method);
    const options = Array.isArray(params.options) ? params.options.filter(item => item && typeof item === 'object') : [];
    const toolCall = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {};
    const title = String(toolCall.title ?? toolCall.kind ?? '这个操作').slice(0, 200);
    // Mova 自己的 MCP 工具（`mcp_mova-tools_*`）：CLI 会为每一次调用发 request_permission，
    // 但它的权限已经由技能层的 approval-bridge 判过（那才是唯一审批入口）。这里若再问一次，
    // 用户每个工具动作都要点两张卡。所以对自家的 MCP 工具直接选「允许」，把门交给技能层。
    const toolName = String(toolCall.name ?? toolCall.title ?? '');
    if (isMovaMcpTool(toolName)) {
      const autoOption = pickOptionId('allow', options, method);
      if (autoOption) {
        await recordAudit({ action: method, decision: 'auto-mcp', optionId: autoOption, toolCallId: toolCall.toolCallId, toolName });
        return { outcome: { outcome: 'selected', optionId: autoOption } };
      }
      // 对面没给可选项时只能按取消处理（不能编造一个不存在的 optionId）。
      await recordAudit({ action: method, decision: 'cancelled', toolCallId: toolCall.toolCallId, toolName });
      return { outcome: { outcome: 'cancelled' } };
    }
    const decision = await askRaw({
      capability: 'permission',
      method,
      sessionId: params.sessionId,
      toolCall,
      options,
      message: `允许${title}？`,
      detail: typeof toolCall.rawInput === 'string' ? toolCall.rawInput.slice(0, 2000) : undefined,
    }, signal, method);
    const optionId = pickOptionId(decision, options, method);
    if (!optionId) {
      await recordAudit({ action: method, decision: 'cancelled', toolCallId: toolCall.toolCallId });
      return { outcome: { outcome: 'cancelled' } };
    }
    await recordAudit({ action: method, decision: 'selected', optionId, toolCallId: toolCall.toolCallId });
    return { outcome: { outcome: 'selected', optionId } };
  }

  function normalizeElicitation(answer) {
    if (answer === true) return { action: 'accept' };
    if (typeof answer === 'string') return ELICIT_ACTIONS.includes(answer) ? { action: answer } : { action: 'cancel' };
    if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
      if (ELICIT_ACTIONS.includes(answer.action)) {
        if (answer.action !== 'accept') return { action: answer.action };
        const content = answer.content && typeof answer.content === 'object' ? answer.content : undefined;
        return content ? { action: 'accept', content } : { action: 'accept' };
      }
      // 没有 action 的对象当作「用户填好的内容」。
      return { action: 'accept', content: answer };
    }
    return { action: 'cancel' };
  }

  async function elicitationCreate(params, signal, method) {
    throwIfAborted(signal, method);
    if (!elicitation || typeof elicitation.ask !== 'function') throw refuse(method, '表单通道未注入（elicitation.ask）');
    const schema = params.requestedSchema && typeof params.requestedSchema === 'object' ? params.requestedSchema : null;
    if (!schema) throw refuse(method, '缺少 requestedSchema');
    let answer;
    try {
      answer = await elicitation.ask(schema, { message: params.message, method, signal });
    } catch (error) {
      throw refuse(method, `表单填写失败：${error?.message ?? error}`);
    }
    const result = normalizeElicitation(answer);
    await recordAudit({ action: method, decision: result.action });
    return result;
  }

  const handlers = {
    'fs/read_text_file': readTextFile,
    'fs/write_text_file': writeTextFile,
    'session/request_permission': requestPermission,
    'elicitation/create': elicitationCreate,
  };

  async function handle(method, params, signal) {
    if (typeof method !== 'string' || !method) throw protocol('acp/unknown', '反向请求缺少 method');
    const input = params && typeof params === 'object' ? params : {};
    if (method.startsWith('terminal/')) return terminal(method, input, signal);
    const handler = handlers[method];
    if (!handler) throw protocol(method, '未实现的反向请求');
    return handler(input, signal, method);
  }

  // `resolveInRoots` 只是把内部已有的路径闸门暴露给技能层复用（approval-bridge / host-adapters），
  // 是纯新增键：`handle` 与既有行为一字未改。抽出去一份实现，避免技能侧再写一遍 symlink 逐级校验。
  return { handle, resolveInRoots };
}
