import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_VERSION,
  buildAgentInstallPrompt,
  buildDialogCopy,
  cliStateOf,
  formatCliVersion,
  isCliReady,
  normalizePlatform,
} from '../src/features/cli-models/install-cli-prompt.mjs';

// 三种探测结果，覆盖 CLI 的唯一三条真实分支（没装 / 过旧 / 就绪）。
const MISSING = Object.freeze({ found: false, code: 'cli_missing', detail: '已尝试 6 个位置', tried: [] });
const OUTDATED = Object.freeze({
  found: true,
  command: 'C:\\Users\\me\\AppData\\Local\\Programs\\antigravity\\agy.exe',
  args: ['acp'],
  version: { major: 1, minor: 9, step: 2 },
  compatible: false,
  source: 'auto',
});
const READY = Object.freeze({
  found: true,
  command: '/usr/local/bin/agy',
  args: ['acp'],
  version: { major: 2, minor: 1, step: 0 },
  compatible: true,
  source: 'settings',
});

const PLATFORMS = ['win32', 'darwin', 'linux'];

test('cliStateOf reports ready only when found and compatible', () => {
  assert.equal(cliStateOf(READY), 'ready', '找到且兼容应为 ready');
});

test('cliStateOf reports outdated when found but incompatible', () => {
  assert.equal(cliStateOf(OUTDATED), 'outdated', '找到但版本不兼容应为 outdated');
});

test('cliStateOf reports missing when the probe found nothing', () => {
  assert.equal(cliStateOf(MISSING), 'missing', 'found:false 应为 missing');
});

test('cliStateOf reports unknown for null status', () => {
  assert.equal(cliStateOf(null), 'unknown', '没有探测结果时不能猜成 missing');
});

test('cliStateOf reports unknown when required fields are missing', () => {
  assert.equal(cliStateOf({}), 'unknown', '缺字段应视为未知');
  // 只找到二进制、版本号没读出来 → present：既不能误报「过旧」，也不该把登录入口关掉。
  assert.equal(cliStateOf({ found: true }), 'present', '只有 found 没有 compatible 属「找到了但版本未知」');
  assert.equal(cliStateOf({ found: true, compatible: undefined }), 'present');
});

test('isCliReady is true for a ready CLI', () => {
  assert.equal(isCliReady(READY), true, '就绪的 CLI 应通过 isCliReady');
});

test('isCliReady is false for every other state', () => {
  assert.equal(isCliReady(OUTDATED), false, '版本过旧不算就绪');
  assert.equal(isCliReady(MISSING), false, '没装不算就绪');
  assert.equal(isCliReady(null), false, '未知状态不算就绪');
  assert.equal(isCliReady({ found: true }), false, '兼容性未知时不能算就绪');
});

test('prompt targets antigravity CLI through ACP with the user own subscription', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'win32', status: MISSING });
  assert.match(prompt, /antigravity CLI/, '提示词必须点名 antigravity CLI');
  assert.match(prompt, /\bagy\b/, '提示词必须点明可执行文件名 agy');
  assert.match(prompt, /ACP/, '必须说明 Mova 走的是 ACP 协议');
  assert.match(prompt, /Gemini/, '必须说明用的是用户自己的 Gemini 订阅额度');
});

test('windows prompt lists typical install locations', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'win32', status: MISSING });
  assert.ok(prompt.includes('LOCALAPPDATA'), 'Windows 落点应包含 %LOCALAPPDATA%');
  assert.ok(prompt.includes('agy.exe'), 'Windows 落点应是 agy.exe');
  assert.ok(prompt.includes('Windows'), '应注明平台名');
});

test('macos prompt lists the homebrew location', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'darwin', status: MISSING });
  assert.ok(prompt.includes('/opt/homebrew/bin'), 'macOS 落点应包含 /opt/homebrew/bin');
  assert.ok(prompt.includes('macOS'), '应注明平台名');
});

test('linux prompt lists the /usr/local/bin location', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'linux', status: MISSING });
  assert.ok(prompt.includes('/usr/local/bin'), 'Linux 落点应包含 /usr/local/bin');
  assert.ok(prompt.includes('Linux'), '应注明平台名');
});

test('prompt tells the agent to verify the version and the PATH entry', () => {
  for (const platform of PLATFORMS) {
    const prompt = buildAgentInstallPrompt({ platform, status: MISSING });
    assert.ok(prompt.includes('agy --version'), `${platform} 的验证步骤必须包含 agy --version`);
    assert.ok(prompt.includes(MIN_VERSION), `${platform} 必须写明最低版本 ${MIN_VERSION}`);
    assert.ok(prompt.includes('PATH'), `${platform} 必须要求确认 agy 在 PATH 里`);
  }
  assert.ok(buildAgentInstallPrompt({ platform: 'win32', status: MISSING }).includes('where agy'), 'Windows 用 where agy');
  assert.ok(buildAgentInstallPrompt({ platform: 'darwin', status: MISSING }).includes('which agy'), 'macOS 用 which agy');
});

test('prompt stays honest about unknown download sources', () => {
  for (const platform of PLATFORMS) {
    const prompt = buildAgentInstallPrompt({ platform, status: MISSING });
    assert.ok(prompt.includes('不要凭记忆编造'), `${platform} 必须禁止编造安装命令`);
    assert.ok(prompt.includes('官方文档'), `${platform} 必须要求先查官方文档`);
    assert.ok(prompt.includes('先向用户确认'), `${platform} 不确定来源时必须先问用户`);
  }
});

test('prompt contains no fabricated urls', () => {
  for (const platform of PLATFORMS) {
    for (const status of [MISSING, OUTDATED, READY, null]) {
      const prompt = buildAgentInstallPrompt({ platform, status });
      assert.ok(!prompt.includes('http'), '提示词里不应出现任何 URL，避免编造下载地址');
    }
  }
});

test('prompt carries the safety constraints', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'linux', status: MISSING });
  assert.ok(prompt.includes('sudo') || prompt.includes('管理员'), '必须提醒 sudo / 管理员权限要先征得同意');
  assert.ok(prompt.includes('同意'), '提权必须先获得用户同意');
  assert.ok(prompt.includes('令牌'), '必须禁止打印/上传/写入令牌');
});

test('prompt reminds the user to reopen the app for PATH changes', () => {
  for (const platform of PLATFORMS) {
    const prompt = buildAgentInstallPrompt({ platform, status: MISSING });
    assert.ok(prompt.includes('重新打开 Mova'), `${platform} 必须提醒重新打开 Mova`);
    assert.ok(prompt.includes('PATH'), `${platform} 必须说明 PATH 只对新进程生效`);
  }
});

test('prompt offers the manual CLI path fallback', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'darwin', status: MISSING });
  assert.ok(prompt.includes('设置 → CLI 模型 → CLI 路径'), '必须给出手动指定 CLI 路径的兜底入口');
});

test('outdated prompt reports the current version and asks for an upgrade', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'win32', status: OUTDATED });
  assert.ok(prompt.includes('1.9.2'), '过旧时必须写明当前检测到的版本号');
  assert.ok(prompt.includes('升级'), '过旧时必须要求升级');
  assert.ok(prompt.includes('重装'), '过旧时必须说明「升级而不是重装」');
  assert.ok(prompt.includes(MIN_VERSION), '过旧时必须写明目标最低版本');
  assert.ok(!buildAgentInstallPrompt({ platform: 'win32', status: READY }).includes('1.9.2'), '就绪时不应再报旧版本号');
});

test('prompt requires a delivery report from the agent', () => {
  const prompt = buildAgentInstallPrompt({ platform: 'linux', status: MISSING });
  assert.ok(prompt.includes('安装方式'), '必须要求回报安装方式');
  assert.ok(prompt.includes('绝对路径'), '必须要求回报可执行文件绝对路径');
  assert.ok(prompt.includes('的输出'), '必须要求回报验证命令的输出');
});

test('prompt stays under the readable length limit', () => {
  for (const platform of [...PLATFORMS, '']) {
    for (const status of [MISSING, OUTDATED, READY, null]) {
      const prompt = buildAgentInstallPrompt({ platform, status });
      assert.ok(prompt.length <= 1800, `提示词应 ≤ 1800 字符，实际 ${prompt.length}（${platform || 'unknown'}）`);
    }
  }
});

test('prompt degrades honestly when the platform is unknown', () => {
  const prompt = buildAgentInstallPrompt({ platform: '', status: MISSING });
  assert.ok(prompt.includes('Windows'), '平台未知时也要提到需要确认平台');
  assert.ok(prompt.includes('官方文档'), '平台未知时仍然要求查官方文档');
});

test('dialog copy differs per state and keeps a question-shaped title', () => {
  const missing = buildDialogCopy({ platform: 'win32', status: MISSING });
  const outdated = buildDialogCopy({ platform: 'win32', status: OUTDATED });
  const ready = buildDialogCopy({ platform: 'win32', status: READY });
  assert.notEqual(missing.title, outdated.title, '未安装与版本过旧的标题必须不同');
  assert.notEqual(missing.title, ready.title, '未安装与就绪的标题必须不同');
  assert.notEqual(outdated.title, ready.title, '版本过旧与就绪的标题必须不同');
  for (const copy of [missing, outdated, ready]) {
    assert.ok(copy.title.includes('？') || copy.title.includes('?'), '标题必须是疑问句');
    assert.ok(copy.description.length > 10, '说明不能为空');
    assert.ok(copy.primary.includes('复制'), '主按钮必须是「复制给 Agent」');
    assert.ok(copy.secondary.includes('重新检测'), '次按钮必须能重新检测');
  }
});

test('dialog copy uses warning tone for broken states and ok tone when ready', () => {
  assert.equal(buildDialogCopy({ status: MISSING }).tone, 'warn', '没装 CLI 应使用警示色调');
  assert.equal(buildDialogCopy({ status: OUTDATED }).tone, 'warn', '版本过旧应使用警示色调');
  assert.equal(buildDialogCopy({ status: READY }).tone, 'ok', '就绪状态应是正常色调');
  assert.equal(buildDialogCopy({ status: null }).tone, 'default', '状态未知时不应伪装成错误');
});

test('dialog copy for an outdated CLI shows the current version', () => {
  const copy = buildDialogCopy({ platform: 'darwin', status: OUTDATED });
  assert.ok(copy.title.includes('1.9.2') || copy.description.includes('1.9.2'), '过旧文案必须带上当前版本号');
  assert.ok(`${copy.title}${copy.description}`.includes(MIN_VERSION), '过旧文案必须写明最低版本');
});

test('platform and version helpers normalize renderer inputs', () => {
  assert.equal(normalizePlatform('Win32'), 'win32', 'process.platform 的 win32 应被识别');
  assert.equal(normalizePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'darwin', 'macOS 的 UA 应被识别');
  assert.equal(normalizePlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux', 'Linux 的 UA 应被识别');
  assert.equal(normalizePlatform(''), '', '认不出来时返回空串，由提示词自己问平台');
  assert.equal(formatCliVersion({ major: 2, minor: 0, step: 3 }), '2.0.3', '版本对象应格式化成语义化版本号');
  // 主进程（electron/subscription/cli.mjs）给的是 `patch`，渲染层老实现读 `step`：
  // 两边字段名不一致时「CLI 已就绪」后面会永远跟一个 v—，所以两种都认。
  assert.equal(formatCliVersion({ major: 1, minor: 5, patch: 8 }), '1.5.8', '主进程的 patch 字段也要认');
  assert.equal(formatCliVersion({ major: 1, minor: 5 }), '', '缺字段时不许拼出半截版本号');
  assert.equal(formatCliVersion(null), '', '版本读不出来时返回空串');
});
