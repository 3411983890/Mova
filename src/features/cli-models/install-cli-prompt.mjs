/**
 * antigravity CLI 安装引导的纯逻辑。
 *
 * 负责：判定 CLI 状态（ready / missing / outdated / unknown）、把「平台 + 探测结果」拼成
 * 一段可直接粘贴给任意 AI Agent 的安装提示词，以及弹窗文案。
 * 不负责：React / DOM / 剪贴板、IPC 探测本身（electron/subscription/cli.mjs）。
 *
 * 为什么提示词要单独成文件：它是本次交付的核心产物，必须能脱离 Electron 与 DOM
 * 单独跑测试（tests/install-cli-prompt.test.mjs），也方便以后换文案而不动组件。
 *
 * 被谁调用：cli-models-install-dialog.jsx、use-subscription.js、cli-models-settings.jsx
 *
 * @see Mova-CLI模型-开发文档.md §9.4
 */

/**
 * Mova 能正常驱动 ACP 的最低 CLI 版本；与 electron/subscription/cli.mjs 的 MIN_VERSION 对齐。
 * 必须是 1.0.0：实测可用的 CLI 是 1.5.8，写 2.0.0 会把正常安装判成「版本过旧」。
 */
export const MIN_VERSION = '1.0.0';

/** 每个平台的常见安装方式 + 落点（只挑几个，列全了用户也不会看）。 */
const PLATFORM_GUIDE = Object.freeze({
  win32: {
    label: 'Windows',
    install: '安装方式一般是官方安装包（Antigravity 桌面安装器）；如果官方文档还给了包管理器命令，就照文档执行。',
    locations: [
      '%LOCALAPPDATA%\\Programs\\antigravity\\agy.exe',
      '%APPDATA%\\npm\\agy.cmd',
      '%ProgramFiles%\\Antigravity\\agy.exe',
    ],
    find: 'where agy',
  },
  darwin: {
    label: 'macOS',
    install: '安装方式一般是官方 .dmg / .pkg 安装包；如果官方文档给了 Homebrew 命令，就照文档执行。',
    locations: [
      '/Applications/Antigravity.app/Contents/MacOS/agy',
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    ],
    find: 'which agy',
  },
  linux: {
    label: 'Linux',
    install: '安装方式一般是官方 .deb / .rpm 包或压缩包；如果官方文档给了别的命令，就照文档执行。',
    locations: ['/usr/local/bin/agy', '/usr/bin/agy', '/opt/antigravity/bin/agy'],
    find: 'which agy',
  },
});

// 顺序有意义：`darwin` 里含 `win`，macOS 必须先判，否则 process.platform 的 darwin 会被认成 Windows。
const PLATFORM_ALIASES = Object.freeze([
  [/darwin|macintosh|mac\s?os|os\s?x|iphone|ipad/i, 'darwin'],
  [/\bwin(?:32|64|dows)\b|windows/i, 'win32'],
  [/linux|ubuntu|debian|fedora|x11/i, 'linux'],
]);

/**
 * 把 `process.platform` / `navigator.platform` / `navigator.userAgent` 之类收敛成三种取值。
 * 认不出来时返回空串——这时提示词不猜平台，改成让 Agent 自己问。
 */
export function normalizePlatform(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  for (const [pattern, platform] of PLATFORM_ALIASES) {
    if (pattern.test(value)) return platform;
  }
  return '';
}

/** 版本对象 → `2.1.0`；读不出来时返回空串（调用方负责说「版本未知」）。
 *  字段名以 electron/subscription/cli.mjs 的 `{major, minor, patch}` 为准，
 *  同时容忍老实现的 `step`。 */
export function formatCliVersion(version) {
  if (!version || typeof version !== 'object') return '';
  const parts = [version.major, version.minor, version.patch ?? version.step];
  if (!parts.every(part => Number.isFinite(Number(part)))) return '';
  return parts.map(part => String(Number(part))).join('.');
}

/** CLI 的版本是否已被确认为够新。注意：这是「严格就绪」，
 *  「能不能拿它登录」请用 isCliUsableState（present 也算可用）。 */
export function isCliReady(cli) {
  return Boolean(cli) && cli.found === true && cli.compatible === true;
}

/**
 * 判定 CLI 状态。四种「确定」+ 一种「不确定」：
 *
 * - `ready`：找到且版本够新。
 * - `present`：找到了二进制，但版本号没读出来（GUI 程序被 `--version` 拉起来时可能卡到超时）。
 *   这个状态**允许继续登录**：明明装好了却不让用，比版本号未知更糟；真不兼容会在 ACP 握手时报错。
 * - `outdated`：读到版本号且确实低于要求——这时才该劝用户升级。
 * - `missing`：一个候选位置都没有。
 * - `unknown`：根本没探测过（首屏还没拿到结果）。
 */
export function cliStateOf(cli) {
  if (!cli || typeof cli !== 'object') return 'unknown';
  if (cli.found === true && cli.compatible === true) return 'ready';
  if (cli.found === true && cli.compatible === false) return 'outdated';
  if (cli.found === true) return 'present';
  if (cli.found === false) return 'missing';
  return 'unknown';
}

/** 状态层面的「可用」：ready（版本够新）与 present（找到了但版本号未知）都允许登录。 */
export function isCliUsableState(state) {
  return state === 'ready' || state === 'present';
}

function stateLine(state, version) {
  if (state === 'ready') return `Mova 已经检测到可用的 agy${version ? `（v${version}）` : ''}，仍请按下面的步骤复核一遍`;
  if (state === 'present') return 'Mova 找到了 agy，但没能读出它的版本号。下面按「已安装」处理：登录能用就用，报版本错误再回来看这一步';
  if (state === 'outdated') return 'Mova 检测到 agy 已经装着，但版本太旧';
  if (state === 'missing') return 'Mova 在这台电脑上还没有找到 agy';
  return 'Mova 没能确认 agy 是否已经装好';
}

/** 旧版本单独一段：说清「升级而不是重装」，并带上当前版本号。 */
function outdatedParagraph(version, command) {
  const current = version ? `当前检测到 ${version}` : '当前检测到的版本号读不出来';
  const where = command ? `\nMova 命中的文件是 ${command}，可以直接对这一份做升级或检查。` : '';
  return `版本要求：${current}，需要 ≥ ${MIN_VERSION}。请升级现有安装，而不是卸载重装`
    + `（重装容易丢掉已登录的订阅状态）；升级方式优先用官方文档给出的方式。${where}`;
}

/**
 * 生成给任意 AI Agent 的安装提示词。
 *
 * 刻意不写任何下载 URL：模型的记忆里常有过期甚至不存在的地址，宁可让 Agent 现场查
 * 官方文档，也不要让它照抄一段编造的命令。
 *
 * @param {{ platform?: string, status?: object|null, appName?: string }} input
 * @returns {string} 纯文本（无 Markdown 表格、无链接），≤ 1800 字符
 */
export function buildAgentInstallPrompt({ platform = '', status = null, appName = 'Mova' } = {}) {
  const state = cliStateOf(status);
  const version = formatCliVersion(status?.version);
  const command = typeof status?.command === 'string' ? status.command : '';
  const guide = PLATFORM_GUIDE[normalizePlatform(platform)] ?? null;

  const where = guide
    ? `${guide.label}。${guide.install}\n装完 agy 通常落在这几处，可以按顺序检查：\n${guide.locations.map(item => `- ${item}`).join('\n')}`
    : '我不确定自己的系统是 Windows、macOS 还是 Linux，请先确认平台，再按官方文档对应的方式安装。';

  const lines = [
    `请帮我在本机装好 antigravity CLI。`,
    '',
    `目标：装好官方 antigravity CLI（提供 agy 可执行文件），让 ${appName} 能通过它的 ACP 协议使用我自己的 Gemini 订阅额度。`
      + `现状：${stateLine(state, version)}。`,
    '',
    '第一步：先查官方文档或官网，确认当前的官方安装方式。不要凭记忆编造安装命令或下载地址；'
      + '如果你不确定某个来源是不是官方的，先向用户确认，不要直接执行。',
    '',
    where,
  ];

  if (state === 'outdated') {
    lines.push('', outdatedParagraph(version, command));
  }

  lines.push(
    '',
    '验证（前两步必须做，缺一不可）：',
    `1. 运行 agy --version，输出的版本必须 ≥ ${MIN_VERSION}；`,
    `2. 运行 ${guide?.find ?? 'where agy（Windows）或 which agy（macOS / Linux）'}，确认 agy 已经在本机 PATH 里；`,
    '3. 运行 agy --help，确认它支持 acp 子命令（Mova 走的就是 ACP）。',
    '',
    `PATH 提醒：装完请告诉我完全退出 ${appName}，再重新打开 ${appName} —— PATH 的改动只对新启动的进程生效。`,
    `兜底：如果 PATH 里始终找不到 agy，告诉我可以在 ${appName} 里手动指定可执行文件：设置 → CLI 模型 → CLI 路径。`,
    '',
    '安全约束：',
    '- 需要 sudo 或管理员权限时，先说清要执行什么，等我明确同意；',
    '- 不要打印、上传或写入任何令牌、密钥、凭据；',
    '- 除了这次安装本身需要新增的 PATH 项，不要改动我的其它系统配置。',
    '',
    '完成后请回报：1) 用了哪种安装方式；2) agy --version 的输出；3) agy 的绝对路径；4) 你执行过的验证命令与输出。',
  );

  return lines.join('\n');
}

/**
 * 弹窗文案。与提示词分开，这样改文案不会把测试里的字符数上限带着一起改。
 * @returns {{ title: string, description: string, hint: string, primary: string, secondary: string, tone: string }}
 */
export function buildDialogCopy({ platform = '', status = null, appName = 'Mova' } = {}) {
  const state = cliStateOf(status);
  const version = formatCliVersion(status?.version);
  const platformLabel = PLATFORM_GUIDE[normalizePlatform(platform)]?.label ?? '这台电脑';

  if (state === 'ready' || state === 'present') {
    return {
      title: state === 'present' ? '已经找到 CLI，但读不出版本号' : 'CLI 已经装好了，还需要安装指引吗？',
      description: `${state === 'present'
        ? `Mova 在 ${status?.command || '本机'} 找到了 antigravity CLI，但没能读出它的版本号（它在被问 --version 时可能不返回）。`
          + `${appName} 会照常把它用于 Gemini 订阅；如果登录时报版本错误，再按下面的提示词升级。`
        : `检测到可用的 antigravity CLI${version ? `（v${version}）` : ''}，${appName} 可以直接使用你的 Gemini 订阅。`
          + '如果你要在别的电脑上再装一次，可以把下面的提示词复制给任意 AI Agent。'}`,
      hint: '这一步不是必须的：关掉这个窗口不影响使用。',
      primary: '复制给 Agent',
      secondary: '已安装，重新检测',
      tone: 'ok',
    };
  }

  if (state === 'outdated') {
    return {
      title: `CLI 版本过旧${version ? `（v${version}）` : ''}，要现在升级吗？`,
      description: `${appName} 需要 antigravity CLI ≥ ${MIN_VERSION} 才能通过 ACP 使用你的 Gemini 订阅；`
        + '请升级现有安装，不要卸载重装（重装容易丢掉已登录的订阅状态）。',
      hint: '下面这段提示词可以直接复制给任意 AI Agent，让它帮你确认版本并升级。',
      primary: '复制给 Agent',
      secondary: '已安装，重新检测',
      tone: 'warn',
    };
  }

  if (state === 'missing') {
    // 有一种容易搞混的情况：本机装着 antigravity 桌面程序，但没装命令行版的 agy。
    // 探测会把那一次命中如实报上来（foundPath），这里必须说清——否则用户会以为「明明装了却找不到」。
    const wrongBinary = typeof status?.foundPath === 'string' && status.foundPath
      ? `\n注意：Mova 在 ${status.foundPath} 找到的是 antigravity 的桌面程序，它不提供 agy 命令行与 acp 子命令，所以仍然需要安装 CLI。`
      : '';
    return {
      title: `这台电脑还没装 antigravity CLI，要现在装吗？`,
      description: `${appName} 的 Gemini 订阅由本机 antigravity CLI 执行，没有它就没法添加 Google 账号。`
        + '下面这段提示词可以直接复制给任意 AI Agent，让它帮你把 CLI 装好。'
        + wrongBinary,
      hint: `装完记得完全退出 ${appName} 再重新打开：PATH 的改动只对新启动的进程生效。`,
      primary: '复制给 Agent',
      secondary: '已安装，重新检测',
      tone: 'warn',
    };
  }

  return {
    title: `没能确认 CLI 的状态，要手动检查一下吗？`,
    description: `读不到 antigravity CLI 的探测结果，${appName} 无法保证 Gemini 订阅可用。`
      + `可以复制下面的提示词让任意 AI Agent 到 ${platformLabel} 上核对安装与版本。`,
    hint: '如果确认已经装好，点「已安装，重新检测」再看一次。',
    primary: '复制给 Agent',
    secondary: '已安装，重新检测',
    tone: 'default',
  };
}
