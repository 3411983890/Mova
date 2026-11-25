#!/usr/bin/env node
/**
 * 日志收集脚本：用户关掉 Mova 之后，用它把「刚才到底发生了什么」捞出来。
 *
 * 定位是「给用户/客服用的手电筒」，不是开发工具：
 * - 不需要知道日志目录在哪（脚本自己按 Electron 的规则找，找不到就明确说清楚找过哪些地方）；
 * - 输出是人类可读的一行一条，而不是原始 JSONL（但坏行原样打印，绝不让脚本崩）；
 * - `--copy` 把最新日志复制出去，方便用户把文件发过来。
 *
 * 目录规则必须和主进程一致：MOVA_LOG_DIR → %APPDATA%\<productName>\logs。
 * %APPDATA% 下同时存在 `Mova`（productName）和 `mova-ui-prototype`（package name）两种可能，
 * 两个都试，并且把「实际有日志的那几个」都列出来，而不是猜一个然后静默失败。
 *
 * 纯函数（目录候选、行解析、格式化、过滤、参数解析）全部导出，供 tests/logging-collect.test.mjs 覆盖。
 */
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LATEST_FILE_NAME, isLogFileName } from '../electron/logging/rotate.mjs';

/** %APPDATA% 下可能出现的应用目录名：productName 优先，package name 兜底。 */
const APP_DIR_NAMES = Object.freeze(['Mova', 'mova-ui-prototype']);

const DEFAULT_TAIL = 80;

/**
 * 候选日志目录（按优先级）。第一个就是「默认目录」。
 * 显式 MOVA_LOG_DIR 永远排第一：用户设过就说明他知道日志在哪。
 */
export function candidateDirs({ env = process.env, platform = process.platform } = {}) {
  const list = [];
  const explicit = typeof env?.MOVA_LOG_DIR === 'string' ? env.MOVA_LOG_DIR.trim() : '';
  if (explicit) list.push(resolve(explicit));

  const home = env?.HOME || env?.USERPROFILE || safeHomedir();
  if (platform === 'win32') {
    const roaming = env?.APPDATA || env?.AppData || '';
    const local = env?.LOCALAPPDATA || '';
    for (const name of APP_DIR_NAMES) if (roaming) list.push(join(roaming, name, 'logs'));
    for (const name of APP_DIR_NAMES) if (local) list.push(join(local, name, 'logs'));
  } else if (platform === 'darwin') {
    for (const name of APP_DIR_NAMES) if (home) list.push(join(home, 'Library', 'Application Support', name, 'logs'));
  } else {
    const configRoot = env?.XDG_CONFIG_HOME || (home ? join(home, '.config') : '');
    for (const name of APP_DIR_NAMES) if (configRoot) list.push(join(configRoot, name, 'logs'));
  }
  return [...new Set(list)];
}

function safeHomedir() {
  try {
    return homedir();
  } catch {
    return '';
  }
}

/** 默认日志目录 = 候选里的第一个。 */
export function resolveLogDir(options = {}) {
  return candidateDirs(options)[0] ?? '';
}

/** 人类可读的大小。 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss`。 */
export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 一行 JSONL → `{ ok, record }` 或 `{ ok: false, raw }`。坏行不抛，交给调用方原样打印。 */
export function parseLine(line) {
  const text = typeof line === 'string' ? line : String(line ?? '');
  if (text.trim().length === 0) return { ok: false, raw: text };
  try {
    const record = JSON.parse(text);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, raw: text };
    return { ok: true, record };
  } catch {
    return { ok: false, raw: text };
  }
}

/** `HH:mm:ss.SSS`：直接从带偏移的 ISO 串里切，避免再解析一次时区。 */
export function timeOf(record) {
  const stamp = typeof record?.t === 'string' ? record.t : '';
  const match = /T(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(stamp);
  return match ? match[1] : '--:--:--.---';
}

/**
 * 一条记录 → `HH:mm:ss.SSS LEVEL scope  msg  {json}`。
 * 多余字段（durationMs、channel…）合成一段 JSON 放在最后，方便扫一眼就知道上下文。
 */
export function formatRecord(record) {
  const level = String(record?.level ?? 'info').toUpperCase().padEnd(5);
  const scope = String(record?.scope ?? '');
  const msg = String(record?.msg ?? '');
  const extra = { ...record };
  delete extra.t;
  delete extra.level;
  delete extra.scope;
  delete extra.msg;
  const keys = Object.keys(extra);
  const tail = keys.length > 0 ? `  ${safeStringify(extra)}` : '';
  return `${timeOf(record)} ${level} ${scope}  ${msg}${tail}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"detail":"[unserializable]"}';
  }
}

/** 一条日志行 → 人类可读文本（坏行原样）。 */
export function formatEntry(entry) {
  if (!entry) return '';
  return entry.ok ? formatRecord(entry.record) : String(entry.raw ?? '');
}

/** 文本 → entry 数组（跳过空行）。 */
export function parseLogText(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(parseLine);
}

/** 这条记录算不算「要关注的」：warn 以上，或卡顿/慢 IPC 这类专门标记过的事件。 */
export function isErrorRecord(record) {
  const level = String(record?.level ?? '').toLowerCase();
  if (level === 'warn' || level === 'error' || level === 'fatal') return true;
  const msg = String(record?.msg ?? '');
  return msg === 'event-loop-hang' || msg === 'event-loop-lag' || msg === 'slow-ipc';
}

/** 过滤（--errors）+ 截尾（--tail），顺序固定：先筛后截，否则筛完可能不足 tail 条。 */
export function selectEntries(entries, { errors = false, tail = DEFAULT_TAIL } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const filtered = errors ? list.filter(entry => entry?.ok && isErrorRecord(entry.record)) : list;
  const limit = Number.isFinite(Number(tail)) && Number(tail) > 0 ? Math.floor(Number(tail)) : DEFAULT_TAIL;
  return filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
}

/** 参数解析：返回 { options, errors }，错误由调用方打印，本函数不抛。 */
export function parseArgs(argv = []) {
  const options = { errors: false, list: false, tail: DEFAULT_TAIL, copy: null, dir: null, help: false };
  const errors = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    switch (arg) {
      case '--errors':
        options.errors = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--tail': {
        const value = list[index + 1];
        index += 1;
        const count = Number(value);
        if (!Number.isFinite(count) || count <= 0) errors.push(`--tail 需要一个正整数，收到 ${value ?? '(空)'}`);
        else options.tail = Math.floor(count);
        break;
      }
      case '--copy': {
        const value = list[index + 1];
        index += 1;
        if (!value || value.startsWith('--')) errors.push('--copy 需要一个目标目录');
        else options.copy = value;
        break;
      }
      case '--dir': {
        const value = list[index + 1];
        index += 1;
        if (!value || value.startsWith('--')) errors.push('--dir 需要一个日志目录');
        else options.dir = value;
        break;
      }
      default:
        if (arg.startsWith('--')) errors.push(`未知参数 ${arg}`);
        else errors.push(`多余的参数 ${arg}（本脚本不接受位置参数）`);
    }
  }
  return { options, errors };
}

/** 目录里所有日志文件，按修改时间倒序。目录不存在返回空数组，由调用方给提示。 */
export async function listLogFiles(dir) {
  if (!dir) return [];
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!isLogFileName(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      /* 正好被删掉，忽略 */
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 找本次运行的日志：优先 latest.txt（主进程每次启动都会写），
 * 回落成「目录里最新的 mova-*.log」——latest.txt 丢了也还能用。
 */
export async function pickLatest(dir, files = []) {
  const candidates = files.length > 0 ? files : await listLogFiles(dir);
  if (candidates.length === 0) return null;
  try {
    const text = await readFile(join(dir, LATEST_FILE_NAME), 'utf8');
    const name = String(text).split(/\r?\n/)[0].trim();
    const found = candidates.find(file => file.name === name);
    if (found) return found;
  } catch {
    /* latest.txt 不存在就回落 */
  }
  return candidates[0];
}

/** 同一次运行的其它分段（`-2`、`-3`…）：轮转后老分段不该被忽略。 */
export function siblingParts(files, latestName) {
  if (!latestName) return [];
  const base = latestName.replace(/-\d+(?=\.log$)/, '');
  return (Array.isArray(files) ? files : []).filter(file => file.name !== latestName && file.name.replace(/-\d+(?=\.log$)/, '') === base);
}

/** 在候选目录里找「真的有日志」的那些（默认目录不存在时用来给建议）。 */
export async function findExistingLogDirs(dirs) {
  const found = [];
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    const files = await listLogFiles(dir);
    if (files.length > 0) found.push({ dir, count: files.length, latest: files[0] });
  }
  return found;
}

function printUsage(stream) {
  stream.write([
    '用法：node scripts/collect-logs.mjs [选项]',
    '',
    '  （无参数）        打印日志目录、最新日志文件和最后 80 行',
    '  --errors          只打印 warn/error/fatal 以及卡顿（event-loop-hang/lag）、慢 IPC',
    '  --tail <n>        改打印行数，默认 80',
    '  --list            列出所有日志文件（大小、修改时间）',
    '  --copy <目录>     把最新日志复制到指定目录（方便发给别人）',
    '  --dir <目录>      手动指定日志目录（默认自动查找）',
    '  -h, --help        显示本帮助',
    '',
  ].join('\n'));
}

function describeMissing(dir, candidateInfo, dirs) {
  const lines = [];
  lines.push(`没有找到日志目录：${dir || '(无法确定)'}`);
  lines.push('可能原因：还没在这个账号下运行过 Mova（跑一次再关掉就会生成日志），或者日志被清理/目录被改过。');
  if (candidateInfo.length > 0) {
    lines.push('');
    lines.push('在下列位置发现了日志，可以用 --dir 指定其中一个：');
    for (const item of candidateInfo) {
      lines.push(`  ${item.dir}（${item.count} 个文件，最新 ${item.latest?.name ?? '未知'}）`);
    }
  } else {
    lines.push('');
    lines.push('所有候选目录都没有日志：');
    for (const candidate of dirs) lines.push(`  ${candidate}`);
    lines.push('如果设置了 MOVA_LOG_DIR，请确认它指向的目录确实存在。');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 这台机器上真实存在的盘符（`C:\`、`D:\`…）。只在 Windows 上有意义。
 * 用来把「D 盘不存在」翻译成人话，而不是让用户对着 `mkdir '\\?'` 发愣。
 */
export function availableWindowsRoots() {
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch {
      /* 光驱/网络盘偶尔会抛，忽略 */
    }
  }
  return roots;
}

/**
 * 脚本主体。返回退出码（0 成功 / 1 参数或目录问题），便于测试和 CI 判断。
 *
 * @param {{ argv?: string[], stdout?: { write(s: string): void }, stderr?: { write(s: string): void }, env?: object, platform?: string }} [io]
 */
export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, env = process.env, platform = process.platform } = {}) {
  const { options, errors } = parseArgs(argv);
  if (errors.length > 0) {
    for (const message of errors) stderr.write(`参数错误：${message}\n`);
    printUsage(stderr);
    return 1;
  }
  if (options.help) {
    printUsage(stdout);
    return 0;
  }

  const dirs = candidateDirs({ env, platform });
  const dir = options.dir ? resolve(options.dir) : dirs[0] ?? '';
  const files = await listLogFiles(dir);

  if (options.list) {
    if (files.length === 0) {
      stderr.write(describeMissing(dir, await findExistingLogDirs(dirs), dirs));
      return 1;
    }
    stdout.write(`日志目录：${dir}\n`);
    stdout.write(`共 ${files.length} 个日志文件（新的在前）：\n`);
    for (const file of files) {
      stdout.write(`  ${file.name}  ${formatBytes(file.size).padStart(9)}  ${formatTime(file.mtimeMs)}\n`);
    }
    return 0;
  }

  const latest = await pickLatest(dir, files);
  if (!latest) {
    stderr.write(describeMissing(dir, await findExistingLogDirs(dirs), dirs));
    return 1;
  }

  if (options.copy) {
    const targetDir = resolve(options.copy);
    // 先看目标盘在不在：Windows 上往一个不存在的盘 mkdir，Node 只会丢出
    // `ENOENT ... mkdir '\\?'`（长路径名空间被截断后的残骸），完全看不出是「D 盘没有」。
    const root = parse(targetDir).root;
    if (platform === 'win32' && root && !existsSync(root)) {
      const drives = availableWindowsRoots();
      stderr.write(`目标盘不存在：${root}\n`);
      if (drives.length > 0) stderr.write(`这台电脑现有的盘：${drives.join('、')}\n`);
      stderr.write(`换一个位置，例如：npm run logs -- --copy .\\mova-logs\n`);
      return 1;
    }
    try {
      await mkdir(targetDir, { recursive: true });
      // 同一次运行可能分成多个段（-2、-3）：整段一起复制，只给最后一段会丢前面的事故现场。
      const parts = [latest, ...siblingParts(files, latest.name)];
      const copied = [];
      for (const file of parts) {
        const destination = join(targetDir, basename(file.path));
        await copyFile(file.path, destination);
        copied.push(destination);
      }
      stdout.write(`已复制 ${copied.length} 个文件到：${targetDir}\n`);
      for (const file of copied) stdout.write(`  ${file}\n`);
      return 0;
    } catch (error) {
      stderr.write(`复制失败：${targetDir}（${error?.code ?? ''} ${error?.message ?? error}）\n`);
      stderr.write('换一个可写目录再试，例如：npm run logs -- --copy .\\mova-logs\n');
      return 1;
    }
  }

  let text;
  try {
    text = await readFile(latest.path, 'utf8');
  } catch (error) {
    stderr.write(`读取日志失败：${latest.path}（${error?.message ?? error}）\n`);
    return 1;
  }

  const entries = parseLogText(text);
  const selected = selectEntries(entries, { errors: options.errors, tail: options.tail });
  const parts = siblingParts(files, latest.name);
  const others = parts.slice().sort((a, b) => a.name.localeCompare(b.name));

  stdout.write(`日志目录：${dir}\n`);
  stdout.write(`最新日志：${latest.name}（${formatBytes(latest.size)}，修改于 ${formatTime(latest.mtimeMs)}）\n`);
  if (others.length > 0) {
    stdout.write(`同一次运行的其它分段（更早）：${others.map(file => file.name).join('、')}\n`);
  }
  const header = options.errors
    ? `---- 告警与错误（共 ${selected.length} 条）----`
    : `---- 最后 ${selected.length} 条 ----`;
  stdout.write(`${header}\n`);

  if (selected.length === 0) {
    stdout.write(options.errors ? '这份日志里没有 warn/error 级别的记录。\n' : '（日志文件是空的）\n');
    return 0;
  }
  for (const entry of selected) stdout.write(`${formatEntry(entry)}\n`);
  return 0;
}

// 只有被直接执行时才跑 main；被测试 import 时保持安静。
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(`收集日志时出错：${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
