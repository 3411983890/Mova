/**
 * antigravity CLI 的发现与探测（§7.2「检测」那一步）。
 *
 * 负责：拼候选路径（settings.cliPath → PATH → 平台常见位置）、判断哪个真能执行、
 *      探测版本号、给出兼容性结论与安装引导。
 * 不负责：启动任何会话/登录（见 acp 引擎与 login）、下载或升级 CLI、读写设置。
 * 被谁调用：主进程的 CLI 检测入口（设置页「检查 CLI」、聊天前的可用性自检）。
 *
 * 关键决策：
 * - 所有失败收敛成返回值，一条异常都不抛：调用方是 IPC / 流式 UI，抛错会把整次交互打断。
 * - 磁盘与进程全部注入（access/exec），本模块因此在测试里完全不碰真实环境。
 * - 「版本读不出来」≠「没装」：`found:true, version:null`，让上层提示版本未知而不是请用户重装。
 * - 路径拼接按注入的 platform 选 path.win32 / path.posix，避免在 Linux CI 上拼出反斜杠。
 */
import { posix, win32 } from 'node:path';

/** ACP 会话的启动参数（§11：`agy acp`，走 stdio）。 */
const ACP_ARGS = Object.freeze(['acp']);

/**
 * 最低可用版本。
 *
 * 原来是 2.0.0——那是凭「ACP 在 2.0 之后才稳定」的假设拍的，实际发版并没有 2.0：
 * 用户机器上跑的是 1.5.8，功能正常，却因为版本号低于门槛被判「过旧」而拒绝使用。
 * 版本门槛只该挡住真正跑不动的老版本，所以降到 1.0.0；要按版本拦，先得有实测依据。
 */
const MIN_VERSION = Object.freeze([1, 0, 0]);
/** 报错文案里用的版本串，省得每次临时拼。 */
const MIN_TEXT = MIN_VERSION.join('.');

/**
 * 各平台常见安装位置的模板（按可信度从高到低）。
 *
 * 用 `/` 分隔而不是写死 `\`：真正拼路径时交给 path.win32/path.posix，
 * 这样同一份模板既能覆盖 Windows 的反斜杠，也不会污染 posix 结果。
 * 是否适用于当前平台由 `platformOfTemplate` 判定（含 .exe/.cmd 或在 APPDATA 下的只给 Windows）。
 */
export const DEFAULT_CANDIDATES = Object.freeze([
  // —— Windows ——
  // 实测安装落点：`%LOCALAPPDATA%\agy\bin\agy.exe`（1.5.8）。**必须排在最前面**：
  // 同一台机器上还有桌面程序 `%LOCALAPPDATA%\Programs\antigravity\antigravity.exe`，
  // 排后面时探测会先撞上它，白等一次超时才轮到真 CLI。
  '{localappdata}/agy/bin/agy.exe',
  '{localappdata}/agy/bin/antigravity.exe',
  '{localappdata}/agy/agy.exe',
  '{localappdata}/Programs/antigravity/agy.exe',
  '{localappdata}/Programs/antigravity/antigravity.exe',
  '{localappdata}/Programs/Antigravity/agy.exe',
  '{localappdata}/antigravity/agy.exe',
  '{localappdata}/antigravity/bin/agy.exe',
  '{appdata}/npm/agy.cmd',
  '{appdata}/npm/antigravity.cmd',
  '{appdata}/npm/antigravity/agy.exe',
  '{programfiles}/Antigravity/agy.exe',
  // —— macOS / Linux 共用 ——
  '{home}/.antigravity/bin/agy',
  '{home}/.local/bin/agy',
  '{home}/.npm-global/bin/agy',
  '/usr/local/bin/agy',
  // —— macOS ——
  '/Applications/Antigravity.app/Contents/MacOS/agy',
  '/opt/homebrew/bin/agy',
  // —— Linux ——
  '/usr/bin/agy',
  '/opt/antigravity/agy',
  '/opt/antigravity/bin/agy',
]);

/** PATH 里会被当成 CLI 的可执行名。 */
const COMMAND_NAMES = Object.freeze(['agy', 'antigravity']);

/** Windows 上可执行的扩展名：npm 装的通常是 .cmd，原生安装的是 .exe。 */
const WIN_EXEC_EXT = Object.freeze(['.exe', '.cmd']);

/** 这些模板只对 macOS 有意义。 */
const DARWIN_PREFIXES = Object.freeze(['/Applications/', '/opt/homebrew/']);
/** 这些模板只对 Linux 有意义（/usr/local/bin 两边都试，所以不在此列）。 */
const LINUX_PREFIXES = Object.freeze(['/usr/bin/', '/opt/antigravity/']);

function envValue(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function pathFor(platform) {
  return platform === 'win32' ? win32 : posix;
}

/** 去重时统一大小写：Windows 文件系统不区分大小写。 */
function dedupe(list, platform) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length === 0) continue;
    const key = platform === 'win32' ? item.toLowerCase() : item;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isWindowsTemplate(template) {
  if (/\.(exe|cmd|bat|ps1)$/i.test(template)) return true;
  return /\{(localappdata|appdata|programfiles)\}/i.test(template);
}

/** 模板能不能用在当前平台上；不能就整条丢掉，而不是拼出一个不存在的怪路径。 */
function platformOfTemplate(template) {
  if (isWindowsTemplate(template)) return 'win32';
  if (DARWIN_PREFIXES.some(prefix => template.startsWith(prefix))) return 'darwin';
  if (LINUX_PREFIXES.some(prefix => template.startsWith(prefix))) return 'linux';
  return 'any';
}

/**
 * 把模板里的占位符换成真实路径片段；缺关键环境变量（比如 Linux 上没有 LOCALAPPDATA）返回 null。
 * 注意路径分隔一律走注入的 path 实现。
 */
function resolveTemplate(template, { env, home, pathImpl }) {
  const absolute = template.startsWith('/');
  const holders = {
    home: home || envValue(env, ['HOME', 'USERPROFILE']),
    appdata: envValue(env, ['APPDATA', 'AppData']),
    localappdata: envValue(env, ['LOCALAPPDATA', 'LocalAppData']),
    programfiles: envValue(env, ['ProgramFiles', 'PROGRAMFILES', 'ProgramW6432']),
  };
  const parts = template.split('/').filter(Boolean).map((part) => {
    const match = /^\{(\w+)\}$/.exec(part);
    if (!match) return part;
    const value = holders[match[1].toLowerCase()];
    return value ? value : null;
  });
  if (parts.some(part => part === null)) return null;
  // 模板以 / 开头说明是绝对路径，join 时要把分隔符带上，否则 /usr/bin/agy 会变成相对路径。
  if (absolute) return pathImpl.join(pathImpl.sep, ...parts);
  return pathImpl.join(...parts);
}

/** PATH 展开成绝对候选：access 只能看真实路径，裸命令名没法判定。 */
function pathCandidates({ env, pathImpl, platform }) {
  const raw = envValue(env, ['PATH', 'Path', 'path']);
  if (!raw) return [];
  const splitter = platform === 'win32' ? ';' : ':';
  const dirs = raw
    .split(splitter)
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const names = platform === 'win32'
    ? COMMAND_NAMES.flatMap(name => WIN_EXEC_EXT.map(ext => `${name}${ext}`))
    : [...COMMAND_NAMES];
  const out = [];
  for (const dir of dirs) {
    for (const name of names) out.push(pathImpl.join(dir, name));
  }
  return out;
}

function commonCandidates({ env, home, pathImpl, platform }) {
  const out = [];
  for (const template of DEFAULT_CANDIDATES) {
    const owner = platformOfTemplate(template);
    if (owner !== 'any' && owner !== platform) continue;
    const resolved = resolveTemplate(template, { env, home, pathImpl });
    if (resolved) out.push(resolved);
  }
  return out;
}

/**
 * 候选清单：PATH 里的 agy/antigravity 在前，平台常见目录在后（PATH 命中说明用户已经在用）。
 * settings.cliPath 不在这里拼——它优先级最高，由 locateCli 单独前置。
 */
export function candidatePaths({ platform = process.platform, env = {}, home = '' } = {}) {
  const pathImpl = pathFor(platform);
  const resolvedHome = home || envValue(env, ['HOME', 'USERPROFILE']);
  const ctx = { env, home: resolvedHome, pathImpl, platform };
  return dedupe([...pathCandidates(ctx), ...commonCandidates(ctx)], platform);
}

function isWholeVersion(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * 行打分：提到 antigravity/agy 的行最可信，其次是带 version 字样或 vX.Y 开头的行。
 * 真实输出里常混着 `node v20.11.0` 这类运行时版本，不能让它抢先命中。
 */
function versionLineRank(line) {
  if (/antigravity|\bagy\b/i.test(line)) return 0;
  if (/version/i.test(line)) return 1;
  if (/^v\d+\./i.test(line)) return 1;
  return 2;
}

/** 从 `agy 2.24.0` / `v2.24.0` / 多行输出里取三段式版本；取不到返回 null。 */
export function parseVersion(stdout) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return null;
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => ({ line, index, rank: versionLineRank(line) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const { line } of lines) {
    const match = /(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(line);
    if (!match) continue;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  }
  return null;
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** 版本是否达到下限；null（读不出版本）一律算不兼容，交给上层提示而不是放行。 */
export function isCompatible(version, { min = MIN_VERSION } = {}) {
  if (!version || typeof version !== 'object') return false;
  if (!isWholeVersion(version.major) || !isWholeVersion(version.minor) || !isWholeVersion(version.patch)) return false;
  const floor = Array.isArray(min) && min.length >= 3 ? min : MIN_VERSION;
  const target = { major: Number(floor[0]) || 0, minor: Number(floor[1]) || 0, patch: Number(floor[2]) || 0 };
  return compareVersions(version, target) >= 0;
}

/** 平台安装引导。文案要能照着做：装什么、装完做什么、还找不到怎么办。 */
export function installHint({ platform = process.platform } = {}) {
  const tail = '装完后重新打开 Mova（PATH 变更只在新进程生效）；若仍然找不到，在「设置 → CLI 模型」里点「选择 CLI 路径」手动指向可执行文件。';
  if (platform === 'win32') {
    return `没有找到 antigravity CLI。请从 antigravity 官方页面下载 Windows 安装程序并完成安装，安装时会自动把 agy.exe 放进 %LOCALAPPDATA%\\Programs\\antigravity。${tail}`;
  }
  if (platform === 'darwin') {
    return `没有找到 antigravity CLI。请从 antigravity 官方页面下载 macOS 版（.dmg）并拖进「应用程序」；也可以把解压出来的 agy 放到 /usr/local/bin 或 /opt/homebrew/bin。${tail}`;
  }
  if (platform === 'linux') {
    return `没有找到 antigravity CLI。请从 antigravity 官方页面下载 Linux 包（.deb/.rpm 或用 tar 包解压），解压后把 agy 放到 /usr/local/bin 并确认可执行（chmod +x）。${tail}`;
  }
  return `没有找到 antigravity CLI。请先在当前系统上安装人工确认来源的 antigravity 客户端，并确保 agy 在 PATH 里。${tail}`;
}

/** 显式路径可能没写扩展名（Windows），补出 .exe/.cmd 变体；已有扩展名就按原样。 */
function withExecutableVariants(command, platform) {
  if (platform !== 'win32') return [command];
  if (/\.(exe|cmd|bat|com|ps1)$/i.test(command)) return [command];
  return [...WIN_EXEC_EXT.map(ext => `${command}${ext}`), command];
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * 这个可执行文件到底会不会跑 ACP。
 *
 * 为什么需要它：`COMMAND_NAMES` 里同时搜 `agy` 和 `antigravity`，而 antigravity 的
 * **桌面程序**（Electron 打包的 GUI）就装在 `%LOCALAPPDATA%\Programs\antigravity\antigravity.exe`。
 * 它不响应 `--version`（GUI 不退出），也没有 `acp` 子命令。把它当成 CLI 收下的话，
 * 后面每一步都会失败：登录 2 秒就退出、额度探测读不到——用户看到的就是「找到 CLI 了但用不了」。
 * 所以名字可疑时必须有一条正面证据（帮助文本里出现 acp）才认。
 */
async function probeAcpSupport({ exec, command, timeoutMs }) {
  // 只试一次 --help：能跑 ACP 的 CLI 一定会在帮助里列出 acp 子命令，
  // 试更多变体只会让「命中的是桌面程序」这种情况白等好几秒。
  try {
    const result = await runWithTimeout(exec, command, ['--help'], timeoutMs);
    const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
    // 用词边界而不是裸 `acp`：GUI 的帮助文本里可能恰好含有 acp 作为别的单词的一部分。
    if (/\bacp\b|agent client protocol/i.test(text)) return { ok: true };
  } catch {
    /* 超时/起不来都算「没证据」 */
  }
  return { ok: false };
}

/** 路径末段（不引 node:path，保持这个模块零依赖、可注入、可在测试里跑 posix 规则）。 */
function fileNameOf(value) {
  const parts = String(value ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** 给 exec 套一层超时：CLI 卡在交互提示上时不能把主进程的检测一起拖住。 */
async function runWithTimeout(exec, command, args, timeoutMs) {
  const started = Promise.resolve().then(() => exec(command, args, { timeoutMs }));
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return started;
  // 超时后原 promise 无人接收，吞掉它的异常，避免未处理的 rejection。
  started.catch(() => {});
  let timer = null;
  try {
    return await Promise.race([
      started,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cli version probe timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 探测版本：先 `--version`，失败再试 `version` 子命令。
 * exec 抛异常说明进程根本起不来，换参数也没用，直接按「版本未知」收口。
 */
async function probeVersion({ exec, command, timeoutMs }) {
  for (const args of [['--version'], ['version']]) {
    let result;
    try {
      result = await runWithTimeout(exec, command, args, timeoutMs);
    } catch {
      return { version: null, reason: 'exec_failed' };
    }
    const text = `${toText(result?.stdout)}\n${toText(result?.stderr)}`;
    const code = Number.isFinite(result?.code) ? result.code : 0;
    // 退出码非 0 时输出通常是 usage/报错，别拿它当版本。
    if (code !== 0) continue;
    const version = parseVersion(text);
    if (version) return { version, reason: 'ok' };
  }
  return { version: null, reason: 'unparsed' };
}

/**
 * 找出可用的 antigravity CLI，并判断版本是否够用。
 *
 * @param {{
 *   settings?: { cliPath?: string },
 *   platform?: string,
 *   env?: Record<string, string>,
 *   home?: string,
 *   access: (path: string) => Promise<boolean>,
 *   exec: (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout?: string, stderr?: string, code?: number }>,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ found: true, command: string, args: string[], version: object|null, compatible: boolean, tried: string[], source: string, detail?: string }
 *   | { found: false, code: 'cli_missing', detail: string, tried: string[] }>}
 */
export async function locateCli(options = {}) {
  const {
    settings,
    platform = process.platform,
    env = {},
    home = '',
    access,
    exec,
    // 1.2s 就够：能答的 CLI 是毫秒级，答不上的（GUI 程序被问 --version 时不会退出）
    // 再多等几秒也还是答不上。最坏情况 = 版本两次 + 帮助一次 ≈ 3.6s，而且全程在后台，
    // 设置页的 list() 不等它（见 ipc.mjs 的 listAll）。
    timeoutMs = 1200,
  } = options;

  // 没有探针就没法判定可执行性；这属于接线错误，但也按「找不到」返回，不抛。
  if (typeof access !== 'function' || typeof exec !== 'function') {
    return { found: false, code: 'cli_missing', detail: '没有注入 access/exec 探针，无法探测 CLI', tried: [] };
  }

  const resolvedHome = home || envValue(env, ['HOME', 'USERPROFILE']);
  const explicit = typeof settings?.cliPath === 'string' ? settings.cliPath.trim() : '';
  const explicitCandidates = explicit ? withExecutableVariants(explicit, platform) : [];
  const autoCandidates = candidatePaths({ platform, env, home: resolvedHome });
  const ordered = dedupe([...explicitCandidates, ...autoCandidates], platform);

  const tried = [];
  const rejectedDesktopApps = [];
  let picked = null;
  let pickedFromSettings = false;
  let probe = null;
  /**
   * 逐个候选：先问版本；读不出版本时，名字像桌面程序（antigravity*）的必须拿出
   * 「帮助里有 acp」的证据，否则**继续试下一个候选**。
   *
   * 为什么必须继续而不是直接返回 found:false：`%LOCALAPPDATA%\Programs\antigravity\antigravity.exe`
   * 在候选顺序里排在 `%LOCALAPPDATA%\agy\bin\agy.exe` 前面。一旦第一枪就被判死，
   * 后面真正可用的 CLI 根本没机会被看到（实测：机器上装的是 agy 1.5.8，却报「没装」）。
   */
  for (const candidate of ordered) {
    tried.push(candidate);
    let executable;
    try {
      executable = (await access(candidate)) === true;
    } catch {
      executable = false;
    }
    if (!executable) continue;

    const candidateProbe = await probeVersion({ exec, command: candidate, timeoutMs });
    /**
     * 名字像桌面程序的（`antigravity*`）**一律**要正面证据，哪怕它吐出了一个「版本号」。
     * 实测：`antigravity.exe --version` 会把内部 Node 的 `v24.22.0` 打出来，
     * 冒名顶替成一个合格的 CLI 版本，于是被收下、后面每一步都失败。
     * 其余候选只在读不出版本时才要证据（读得出真版本说明它至少是个会退出的命令行程序）。
     */
    const looksLikeDesktop = /^antigravity/i.test(fileNameOf(candidate));
    if (looksLikeDesktop) {
      const support = await probeAcpSupport({ exec, command: candidate, timeoutMs });
      if (!support.ok) {
        rejectedDesktopApps.push(candidate);
        continue;
      }
    }
    picked = candidate;
    pickedFromSettings = explicitCandidates.includes(candidate);
    probe = candidateProbe;
    break;
  }

  // 显式路径写错时不能只说「没装」：要记下「你配的那条没用了，我改自动找」。
  const explicitMissing = explicit && !pickedFromSettings ? `已配置的 CLI 路径 ${explicit} 不可用` : '';

  if (!picked) {
    const desktopNote = rejectedDesktopApps.length > 0
      ? `找到 ${rejectedDesktopApps.join('、')}，但它既不响应 --version，帮助里也没有 acp 子命令：这是 antigravity 桌面程序，不是 agy CLI，请安装 antigravity CLI（agy）`
      : '';
    const detail = [explicitMissing, desktopNote, `已尝试 ${tried.length} 个位置`].filter(Boolean).join('；');
    return {
      found: false,
      code: 'cli_missing',
      detail,
      tried,
      ...(rejectedDesktopApps.length > 0 ? { foundPath: rejectedDesktopApps[0] } : {}),
    };
  }

  // 读不出版本号 ≠ 版本太旧。
  // 实测：antigravity.exe --version 在 Electron 主进程里被拉起时可能 5 秒都不退（GUI 程序），
  // execFile 超时后 probeVersion 只能报 exec_failed。这时把 compatible 判成 false 会让界面
  // 说「版本太旧」并把 Gemini 登录整个挡下来——所以「有版本号才算兼容性结论」，
  // 没有版本号时 compatible 留 undefined（未知）。
  const version = probe.version;

  const compatible = version ? isCompatible(version) : undefined;
  const result = {
    found: true,
    command: picked,
    args: [...ACP_ARGS],
    version,
    compatible,
    tried,
    source: pickedFromSettings ? 'settings' : 'auto',
  };

  const notes = [];
  if (explicitMissing) notes.push(`${explicitMissing}，已改为自动查找`);
  if (!version) {
    notes.push(probe.reason === 'exec_failed'
      ? `CLI 无法启动，版本未知（要求 ≥ ${MIN_TEXT}）`
      : `CLI 能启动但读不出版本号（要求 ≥ ${MIN_TEXT}）`);
  } else if (!compatible) {
    notes.push(`CLI 版本 ${formatVersion(version)} 低于要求的 ${MIN_TEXT}`);
  }
  if (notes.length > 0) result.detail = notes.join('；');
  return result;
}
