/**
 * antigravity CLI 发现与探测的单元测试。
 *
 * 全部走注入：access / exec 都是假的，跑测试不碰真实磁盘与进程。
 * 断言消息用中文，测试名用英文，方便失败时直接看出是哪条行为退化。
 */
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_CANDIDATES,
  candidatePaths,
  installHint,
  isCompatible,
  locateCli,
  parseVersion,
} from '../electron/subscription/cli.mjs';

const WIN_HOME = 'C:\\Users\\u';
const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  ProgramFiles: 'C:\\Program Files',
  USERPROFILE: WIN_HOME,
  PATH: 'C:\\tools;"C:\\Program Files\\Antigravity"',
};
const POSIX_ENV = { HOME: '/home/u', PATH: '/usr/local/bin:/usr/bin' };
/** 期望值也用 path.win32 拼，避免手写反斜杠时多写/漏写一层。 */
const WIN_LOCAL_AGY = win32.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'antigravity', 'agy.exe');
const WIN_PATH_AGY = win32.join('C:\\tools', 'agy.exe');
/** antigravity 的**桌面程序**：名字出现在候选里，但它不是 CLI。 */
const WIN_LOCAL_APP = win32.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'antigravity', 'antigravity.exe');

/** 只认白名单里的路径，同时记录被探过哪些（用来断言「没再试 PATH」）。 */
function fakeAccess(existing = []) {
  const set = new Set(existing);
  const calls = [];
  return {
    calls,
    async access(target) {
      calls.push(target);
      return set.has(target);
    },
  };
}

/** 记录每次 exec 的 (command, args)，按 args 返回脚本化结果。 */
function fakeExec(handler) {
  const calls = [];
  return {
    calls,
    async exec(command, args) {
      calls.push({ command, args: [...args] });
      return handler(command, args);
    },
  };
}

function versionOk(text) {
  return { stdout: text, stderr: '', code: 0 };
}

// —— candidatePaths ——

test('candidatePaths on win32 resolves the %LOCALAPPDATA% install dir with backslashes', () => {
  const paths = candidatePaths({ platform: 'win32', env: WIN_ENV, home: WIN_HOME });
  assert.ok(paths.includes(WIN_LOCAL_AGY), '应当包含 %LOCALAPPDATA%\\Programs\\antigravity\\agy.exe');
  assert.ok(paths.every(item => !item.includes('/')), 'Windows 候选路径不应出现正斜杠');
  assert.ok(DEFAULT_CANDIDATES.some(template => template.includes('{localappdata}')), '模板表里要有 {localappdata} 占位');
});

test('candidatePaths tries PATH before guessed install dirs and keeps a stable order', () => {
  const paths = candidatePaths({ platform: 'win32', env: WIN_ENV, home: WIN_HOME });
  const pathIndex = paths.indexOf(WIN_PATH_AGY);
  assert.ok(pathIndex >= 0, 'PATH 里的 agy.exe 应当被展开成绝对候选');
  assert.ok(pathIndex < paths.indexOf(WIN_LOCAL_AGY), 'PATH 命中要排在猜测目录之前（可信度更高）');
  assert.deepEqual(candidatePaths({ platform: 'win32', env: WIN_ENV, home: WIN_HOME }), paths, '同样的输入必须产出同样顺序');
});

test('candidatePaths drops duplicates, including case-only differences on win32', () => {
  const env = { ...WIN_ENV, PATH: 'C:\\tools;C:\\tools;C:\\TOOLS;C:\\tools\\' };
  const paths = candidatePaths({ platform: 'win32', env, home: WIN_HOME });
  const keys = paths.map(item => item.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, '候选路径必须去重（Windows 大小写不敏感）');
  assert.equal(keys.filter(key => key === 'c:\\tools\\agy.exe').length, 1, '同一个 PATH 目录只留一条 agy.exe');
});

test('candidatePaths is layout-specific for darwin vs linux', () => {
  const darwin = candidatePaths({ platform: 'darwin', env: { HOME: '/Users/u', PATH: '/usr/local/bin' }, home: '/Users/u' });
  const linux = candidatePaths({ platform: 'linux', env: POSIX_ENV, home: '/home/u' });
  assert.ok(darwin.includes('/Applications/Antigravity.app/Contents/MacOS/agy'), 'macOS 要查 .app 里的可执行文件');
  assert.ok(!linux.includes('/Applications/Antigravity.app/Contents/MacOS/agy'), 'Linux 不该出现 .app 路径');
  assert.ok(linux.includes('/usr/bin/agy'), 'Linux 要查 /usr/bin');
  assert.ok(!darwin.includes('/usr/bin/agy'), 'macOS 不该把 /usr/bin 当安装位置');
  assert.notDeepEqual(darwin, linux, '两个平台的候选清单不能相同');
  assert.ok([...darwin, ...linux].every(item => item.startsWith('/')), 'posix 候选必须是绝对路径');
});

test('candidatePaths never leaks an unresolved placeholder', () => {
  const cases = [
    ['win32', WIN_ENV, WIN_HOME],
    ['darwin', { HOME: '/Users/u', PATH: '/usr/local/bin' }, '/Users/u'],
    ['linux', POSIX_ENV, '/home/u'],
  ];
  for (const [platform, env, home] of cases) {
    const paths = candidatePaths({ platform, env, home });
    assert.ok(paths.length > 0, `${platform} 至少要给出一个候选`);
    assert.ok(paths.every(item => !item.includes('{')), `${platform} 的候选里不应残留 {占位符}`);
  }
});

// —— parseVersion ——

test('parseVersion reads the version out of "agy 2.24.0"', () => {
  assert.deepEqual(parseVersion('agy 2.24.0'), { major: 2, minor: 24, patch: 0 }, '带前缀的单行输出要能解析');
});

test('parseVersion accepts a leading v', () => {
  assert.deepEqual(parseVersion('v2.24.0\n'), { major: 2, minor: 24, patch: 0 }, 'v 前缀不能影响解析');
});

test('parseVersion prefers the version line in multi-line output', () => {
  const stdout = 'node v20.11.0\nantigravity 2.24.0\nplatform win32';
  assert.deepEqual(parseVersion(stdout), { major: 2, minor: 24, patch: 0 }, '不该被前面的 node 版本抢走');
  assert.deepEqual(parseVersion('  usage: agy <command>  \nversion: 3.1.4'), { major: 3, minor: 1, patch: 4 }, '带 version 字样的行优先');
});

test('parseVersion returns null when there is no version', () => {
  assert.equal(parseVersion('usage: agy <command>'), null, '没有三段式版本号时返回 null');
  assert.equal(parseVersion(''), null, '空串返回 null');
  assert.equal(parseVersion(undefined), null, '非字符串输入不抛异常');
  assert.equal(parseVersion(null), null, 'null 输入不抛异常');
});

// —— isCompatible ——

test('isCompatible accepts the floor version and anything newer', () => {
  assert.equal(isCompatible({ major: 2, minor: 0, patch: 0 }), true, '2.0.0 正好达标');
  assert.equal(isCompatible({ major: 3, minor: 0, patch: 0 }), true, '3.0.0 属于兼容范围');
  assert.equal(isCompatible({ major: 2, minor: 24, patch: 0 }), true, '2.24.0 应兼容');
});

test('isCompatible rejects versions below the floor and unknown versions', () => {
  // 下限是 1.0.0（不是 2.0.0）：实测能用的 CLI 是 1.5.8，把 1.x 判成「过旧」会把正常安装挡在外面。
  assert.equal(isCompatible({ major: 1, minor: 5, patch: 8 }), true, '实测可用的 1.5.8 必须放行');
  assert.equal(isCompatible({ major: 0, minor: 9, patch: 9 }), false, '0.9.9 太旧');
  assert.equal(isCompatible(null), false, '版本未知时不能放行');
  assert.equal(isCompatible({}), false, '字段缺失时不能放行');
});

test('isCompatible honours a custom min', () => {
  assert.equal(isCompatible({ major: 2, minor: 1, patch: 0 }, { min: [2, 2, 0] }), false, '低于自定义下限要拒绝');
  assert.equal(isCompatible({ major: 2, minor: 2, patch: 0 }, { min: [2, 2, 0] }), true, '等于自定义下限要放行');
});

// —— locateCli ——

test('locateCli prefers settings.cliPath and never probes PATH afterwards', async () => {
  const settingsPath = 'C:\\custom\\agy.exe';
  const access = fakeAccess([settingsPath, WIN_PATH_AGY]);
  const exec = fakeExec(() => versionOk('agy 2.24.0'));
  const result = await locateCli({
    settings: { cliPath: settingsPath },
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: exec.exec,
  });
  assert.equal(result.found, true, '配置了可用路径就该找到 CLI');
  assert.equal(result.command, settingsPath, '必须用设置里的路径');
  assert.equal(result.source, 'settings', '来源要标明是设置');
  assert.deepEqual(access.calls, [settingsPath], '命中设置路径后不该再探 PATH');
  assert.equal(exec.calls.length, 1, '版本只探测一次');
  assert.deepEqual(exec.calls[0].args, ['--version'], '先试 --version');
  assert.deepEqual(result.version, { major: 2, minor: 24, patch: 0 }, '版本对象要透传');
  assert.equal(result.compatible, true, '2.24.0 应判定兼容');
  assert.deepEqual(result.args, ['acp'], '发现阶段只返回 ACP 启动参数，不启动会话');
});

test('locateCli falls back to PATH when settings are empty', async () => {
  const access = fakeAccess([WIN_PATH_AGY]);
  const exec = fakeExec(() => versionOk('agy 2.10.0'));
  const result = await locateCli({
    settings: { cliPath: '' },
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: exec.exec,
  });
  assert.equal(result.found, true, '设置没填时应回退自动查找');
  assert.equal(result.command, WIN_PATH_AGY, '应当命中 PATH 里的 agy.exe');
  assert.equal(result.source, 'auto', '来源要标明是自动发现');
  assert.equal(exec.calls.length, 1, '只对第一个可执行候选探测版本');
});

test('locateCli reports cli_missing with a non-empty tried list', async () => {
  const exec = fakeExec(() => {
    throw new Error('不该执行到这里');
  });
  const result = await locateCli({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: async () => false,
    exec: exec.exec,
  });
  assert.equal(result.found, false, '全部候选不存在时 found 必须是 false');
  assert.equal(result.code, 'cli_missing', '失败原因要区分成 cli_missing');
  assert.ok(Array.isArray(result.tried) && result.tried.length > 0, 'tried 要列出探过的位置');
  assert.match(result.detail, /已尝试 \d+ 个位置/, 'detail 要说清楚试过多少处');
  assert.equal(exec.calls.length, 0, '没找到可执行文件就不该跑版本探测');
});

test('locateCli keeps found:true but compatible:false for an old CLI', async () => {
  const access = fakeAccess([WIN_PATH_AGY]);
  const result = await locateCli({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: fakeExec(() => versionOk('agy 0.9.9')).exec,
  });
  assert.equal(result.found, true, '版本旧不代表没装');
  assert.equal(result.compatible, false, '0.9.9 应判定不兼容');
  assert.deepEqual(result.version, { major: 0, minor: 9, patch: 9 }, '版本号要照实返回');
  assert.equal(result.code, undefined, '不兼容不该被当成 cli_missing');
  assert.match(result.detail, /低于要求/, 'detail 要提示版本过旧');
});

test('locateCli treats a throwing exec as unknown version, not as missing', async () => {
  const access = fakeAccess([WIN_PATH_AGY]);
  const result = await locateCli({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: async () => {
      throw new Error('spawn EACCES');
    },
  });
  assert.equal(result.found, true, 'exec 抛异常不能变成「没装」');
  assert.equal(result.version, null, '版本未知时返回 null');
  // 读不出版本号 ≠ 版本太旧。实测 antigravity.exe 在被问 --version 时可能一直不返回
  // （GUI 程序），超时后如果按「不兼容」处理，界面会说「版本过旧」并把 Gemini 登录挡下来。
  assert.equal(result.compatible, undefined, '版本未知时兼容性也未知，不能判成 false');
  assert.notEqual(result.code, 'cli_missing', '失败原因不能是 cli_missing');
});

test('locateCli retries the "version" subcommand when --version fails', async () => {
  const access = fakeAccess([WIN_PATH_AGY]);
  const exec = fakeExec((command, args) => (args[0] === '--version'
    ? { stdout: 'unknown flag: --version', stderr: '', code: 1 }
    : versionOk('antigravity version 2.3.1')));
  const result = await locateCli({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: exec.exec,
  });
  assert.deepEqual(result.version, { major: 2, minor: 3, patch: 1 }, '子命令的输出也要能解析');
  assert.deepEqual(exec.calls.map(call => call.args), [['--version'], ['version']], '先 --version 再 version 子命令');
});

test('locateCli falls back to auto discovery when the configured path is gone', async () => {
  const access = fakeAccess([WIN_PATH_AGY]);
  const result = await locateCli({
    settings: { cliPath: 'C:\\gone\\agy.exe' },
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: fakeExec(() => versionOk('agy 2.24.0')).exec,
  });
  assert.equal(result.found, true, '配置路径失效时仍应找到 CLI');
  assert.equal(result.command, WIN_PATH_AGY, '应当退回自动查找的结果');
  assert.match(result.detail, /已配置的 CLI 路径 .* 不可用，已改为自动查找/, 'detail 要说明配置路径已失效');
});

test('locateCli on posix probes extension-less names only', async () => {
  const macAgy = '/usr/local/bin/agy';
  const access = fakeAccess([macAgy]);
  const result = await locateCli({
    platform: 'darwin',
    env: { HOME: '/Users/u', PATH: '/usr/local/bin' },
    home: '/Users/u',
    access: access.access,
    exec: fakeExec(() => versionOk('agy 2.5.0')).exec,
  });
  assert.equal(result.command, macAgy, 'macOS 应当命中 /usr/local/bin/agy');
  assert.ok(access.calls.every(target => !target.endsWith('.exe')), 'posix 不该拼出 .exe 候选');
});

test('locateCli returns cli_missing instead of throwing when probes are absent', async () => {
  const result = await locateCli({ settings: { cliPath: '' }, platform: 'linux', env: POSIX_ENV, home: '/home/u' });
  assert.equal(result.found, false, '缺少探针时不能抛异常');
  assert.equal(result.code, 'cli_missing', '仍然按没找到收敛');
  assert.deepEqual(result.tried, [], '没有探针就没探过任何位置');
});

// —— 「命中的是桌面程序，不是 CLI」 ——
//
// 真实事故：本机装了 antigravity 桌面程序（%LOCALAPPDATA%\Programs\antigravity\antigravity.exe），
// 没有装 agy CLI。旧逻辑把它当成 CLI 收下 → `--version` 永远不返回（GUI 不退出）→
// 「版本未知」→ 用户点登录 2 秒就失败，且界面看不出真正原因。
test('locateCli rejects the antigravity desktop app instead of pretending it is the CLI', async () => {
  const access = fakeAccess([WIN_LOCAL_APP]);
  const result = await locateCli({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    // 桌面程序对 --version / version / --help / acp --help 全都答不上来
    exec: fakeExec(() => ({ stdout: '', stderr: 'no such command', code: 1 })).exec,
  });
  assert.equal(result.found, false, '桌面程序不能当成 CLI');
  assert.equal(result.code, 'cli_missing', '要按「没装 CLI」收敛，而不是「版本过旧」');
  assert.equal(result.foundPath, WIN_LOCAL_APP, '要如实报出命中的是哪个文件，界面才能解释清楚');
  assert.match(result.detail, /桌面程序/, 'detail 要说明看到的是桌面程序');
});

test('locateCli accepts an antigravity-named binary that proves it speaks acp', async () => {
  const access = fakeAccess([WIN_LOCAL_APP]);
  const result = await locateCli({
    platform: 'win32',
    env: WIN_ENV,
    home: WIN_HOME,
    access: access.access,
    exec: fakeExec((command, args) => (args[0] === '--help'
      ? { stdout: 'usage: antigravity <command>\n  acp   run the agent client protocol\n', stderr: '', code: 0 }
      : { stdout: '', stderr: 'unknown flag', code: 1 })).exec,
  });
  assert.equal(result.found, true, '帮助里写了 acp 就是 CLI，名字像桌面程序也认');
  assert.equal(result.version, null, '版本号仍然读不出来');
  assert.equal(result.compatible, undefined, '版本未知 → 兼容性未知（不是 false）');
});

// —— installHint ——

test('installHint gives distinct, actionable text per platform', () => {
  const win = installHint({ platform: 'win32' });
  const mac = installHint({ platform: 'darwin' });
  const linux = installHint({ platform: 'linux' });
  for (const [platform, text] of [['win32', win], ['darwin', mac], ['linux', linux]]) {
    assert.ok(typeof text === 'string' && text.trim().length > 10, `${platform} 的安装说明不能为空`);
    assert.match(text, /antigravity CLI/, `${platform} 的说明要指明装什么`);
    assert.match(text, /选择 CLI 路径/, `${platform} 的说明要给出还能怎么办`);
  }
  assert.notEqual(win, mac, 'Windows 与 macOS 的说明不能相同');
  assert.notEqual(win, linux, 'Windows 与 Linux 的说明不能相同');
  assert.notEqual(mac, linux, 'macOS 与 Linux 的说明不能相同');
  assert.match(win, /LOCALAPPDATA/, 'Windows 说明要写出安装目录');
  assert.match(mac, /\.dmg|应用程序/, 'macOS 说明要给出安装方式');
  assert.match(linux, /\/usr\/local\/bin/, 'Linux 说明要给出可执行文件位置');
});
