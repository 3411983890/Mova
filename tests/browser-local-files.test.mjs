/**
 * 本地文件（`file://`）白名单：**默认关闭**，只有「已登记项目根内的可展示类型」才允许导航。
 *
 * 钉住的四件事（改这里之前先读 electron/browser/target.cjs 的 resolveLocalFileTarget）：
 * 1) 没注入 `localFiles` → 仍是 `blocked-url`（与放开这条能力之前完全一致，回归锁）；
 * 2) 判定必须发生在 **realpath 之后**：`..`、symlink/junction 都不能逃到根外；
 * 3) 根外错误**不泄露**目标路径（message 里既没有文件名也没有根路径）；
 * 4) 失败码可区分：`file_outside_roots` / `file_type_not_allowed` / `file_not_found`。
 *
 * 用真实临时目录 + 真实文件（`os.tmpdir()`），假 guest 只记录 `loadURL()`——这样「判定通过」与
 * 「真的走到了 webview 层」是两件分别断言的事，不会出现「报错被吞掉但测试还是绿的」。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  PageTarget,
  DEFAULT_LOCAL_FILE_EXTENSIONS,
  FILE_OUTSIDE_MESSAGE,
} = require('../electron/browser/target.cjs');

let base = '';
let projectRoot = '';
let outsideDir = '';

const projectFile = name => join(projectRoot, name);
const outsideFile = name => join(outsideDir, name);
const urlOf = path => pathToFileURL(path).href;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mova-local-files-'));
  projectRoot = join(base, 'project');
  outsideDir = join(base, 'outside');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(projectFile('page.html'), '<!doctype html><h1>ok</h1>');
  await writeFile(projectFile('notes.md'), '# notes');
  await writeFile(projectFile('tool.js'), 'console.log(1)');
  await writeFile(projectFile('setup.exe'), 'MZ');
  await writeFile(outsideFile('secret.html'), '<h1>secret</h1>');
});

after(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

/**
 * 假 guest：只实现 PageTarget 构造与 navigate 用到的那几个口子。
 * `loaded` 就是「导航真的到了 webview 层」的证据。
 */
function fakeGuest(initial = 'https://example.com/start') {
  const loaded = [];
  let url = initial;
  return {
    id: 1,
    loaded,
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => '页面',
    isLoading: () => false,
    on() {},
    removeListener() {},
    debugger: {
      isAttached: () => true,
      attach() {},
      detach() {},
      sendCommand: async () => ({}),
      on() {},
      removeListener() {},
    },
    async loadURL(href) { loaded.push(href); url = href; return {}; },
  };
}

function makeTarget(localFiles) {
  const guest = fakeGuest();
  const target = new PageTarget({ guest, tabId: 't1', spaceId: 'default', localFiles });
  return { guest, target };
}

const rootsOf = (...paths) => ({ roots: async () => paths });

test('根内 .html：允许导航，并且真的调到了 webview 层（loadURL）', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  const url = urlOf(projectFile('page.html'));
  const info = await target.navigate(url);

  assert.equal(guest.loaded.length, 1, '必须真的调用一次 loadURL');
  assert.match(guest.loaded[0], /^file:\/\/\//, '加载的是 file: 绝对地址');
  assert.equal(guest.loaded[0].toLowerCase().endsWith('page.html'), true);
  assert.equal(info.url, guest.loaded[0], '返回值里的 url 就是实际加载的那一个');
});

test('根外 .html：file_outside_roots，且 message / detail 都不含目标路径', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  const targetPath = outsideFile('secret.html');
  await assert.rejects(target.navigate(urlOf(targetPath)), error => {
    assert.equal(error.code, 'file_outside_roots');
    assert.equal(error.message, FILE_OUTSIDE_MESSAGE);
    assert.equal(error.message.includes('secret'), false, 'message 不许出现目标文件名');
    assert.equal(error.message.includes(outsideDir), false, 'message 不许出现目标目录');
    assert.equal(error.detail, undefined, '不许通过 detail 把路径带回来');
    return true;
  });
  assert.equal(guest.loaded.length, 0, '被拒绝的导航一次都不许碰 webview');
});

test('根内但不是可展示类型（.exe / .js）：file_type_not_allowed，并列出可用扩展名', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  for (const name of ['setup.exe', 'tool.js']) {
    await assert.rejects(target.navigate(urlOf(projectFile(name))), error => {
      assert.equal(error.code, 'file_type_not_allowed', `${name} 必须是类型不允许`);
      for (const extension of ['.html', '.pdf', '.png']) {
        assert.ok(error.message.includes(extension), `错误文案要提示可用扩展名：缺 ${extension}`);
      }
      assert.equal(error.message.includes(projectRoot), false, '类型错误也不必带绝对路径');
      return true;
    });
  }
  assert.equal(guest.loaded.length, 0);
  // 清单本身来自 target.cjs，技能层与测试都引用同一份。
  assert.ok(DEFAULT_LOCAL_FILE_EXTENSIONS.includes('.html'));
  assert.equal(DEFAULT_LOCAL_FILE_EXTENSIONS.includes('.js'), false, '脚本绝不能进白名单');
  assert.equal(DEFAULT_LOCAL_FILE_EXTENSIONS.includes('.exe'), false, '可执行文件绝不能进白名单');
});

test('根内但文件不存在：file_not_found；目录同样不是「可展示文件」', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  await assert.rejects(target.navigate(urlOf(projectFile('missing.html'))), error => {
    assert.equal(error.code, 'file_not_found');
    return true;
  });
  // 目录没有扩展名 → 类型不允许；带扩展名的目录（这里造一个 x.html 目录）→ 不是普通文件。
  await mkdir(projectFile('dir.html'), { recursive: true });
  await assert.rejects(target.navigate(urlOf(projectFile('dir.html'))), error => {
    assert.equal(error.code, 'file_not_found');
    return true;
  });
  assert.equal(guest.loaded.length, 0);
  await rm(projectFile('dir.html'), { recursive: true, force: true });
});

test('.. 穿越：file:///root/../outside/secret.html → file_outside_roots', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  const escaped = `${urlOf(projectRoot)}/../outside/secret.html`;
  await assert.rejects(target.navigate(escaped), error => {
    assert.equal(error.code, 'file_outside_roots', 'URL 规范化之后它确实在根外，必须按根外拒绝');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(guest.loaded.length, 0);
});

test('根内的目录链接指向根外（junction/symlink）→ file_outside_roots', async t => {
  const linkPath = join(projectRoot, 'escape');
  try {
    await symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`当前环境建不了目录链接（${error?.code || error?.message}），符号链接逃逸未实测`);
    return;
  }
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  await assert.rejects(target.navigate(urlOf(join(linkPath, 'secret.html'))), error => {
    assert.equal(error.code, 'file_outside_roots', '字面看着在根内，realpath 之后必须按根外拒绝');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(guest.loaded.length, 0);
  await rm(linkPath, { force: true });
});

test('没注入 localFiles：file: 仍然是 blocked-url（默认拒绝，回归锁）', async () => {
  const { guest, target } = makeTarget(null);
  await assert.rejects(target.navigate(urlOf(projectFile('page.html'))), error => {
    assert.equal(error.code, 'blocked-url');
    assert.equal(error.message, 'only http(s) navigation is allowed', '文案必须与放开之前一模一样');
    return true;
  });
  assert.equal(guest.loaded.length, 0);
});

test('其它 scheme 一律继续拒绝：javascript: / data: / blob:（注入了 localFiles 也一样）', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  for (const url of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'blob:https://example.com/x']) {
    await assert.rejects(target.navigate(url), error => {
      assert.equal(error.code, 'blocked-url', `${url} 必须 blocked-url`);
      return true;
    });
  }
  assert.equal(guest.loaded.length, 0);
});

test('http(s) 行为一字不变：注入 localFiles 也不影响（loadURL 收到原样的 href）', async () => {
  const { guest, target } = makeTarget(rootsOf(projectRoot));
  await target.navigate('https://example.com/a?b=1#c');
  assert.deepEqual(guest.loaded, ['https://example.com/a?b=1#c']);
});

test('allowedExtensions 可覆盖：只给 .html 时 .md 被拒', async () => {
  const { guest, target } = makeTarget({ roots: async () => [projectRoot], allowedExtensions: ['.html'] });
  await assert.rejects(target.navigate(urlOf(projectFile('notes.md'))), error => {
    assert.equal(error.code, 'file_type_not_allowed');
    assert.equal(error.message.includes('.html'), true);
    return true;
  });
  assert.equal(guest.loaded.length, 0);
  await target.navigate(urlOf(projectFile('page.html')));
  assert.equal(guest.loaded.length, 1, '覆盖清单里的类型照常放行');
});

test('roots() 抛错时按根外拒绝（fail closed），不会因为读不到项目根就放行', async () => {
  const { guest, target } = makeTarget({ roots: async () => { throw new Error('store unavailable'); } });
  await assert.rejects(target.navigate(urlOf(projectFile('page.html'))), error => {
    assert.equal(error.code, 'file_outside_roots');
    return true;
  });
  assert.equal(guest.loaded.length, 0);
});

// ── 接线：browser_tabs new / controller.navigate 也走同一个入口 ────────────────
test('browser_tabs new 的 file: 也走同一个判定：不把 file: 当 webview 初始 src', async () => {
  const { createBrowserController } = require('../electron/browser/controller.cjs');
  const sent = [];
  const guests = [];
  const win = {
    isDestroyed: () => false,
    show() {},
    focus() {},
    isVisible: () => true,
    webContents: { id: 1, send: (channel, payload) => { sent.push([channel, payload]); } },
  };
  const controller = createBrowserController({
    app: { getPath: () => base },
    getWindow: () => win,
    localFiles: { roots: async () => [projectRoot] },
    logger: { warn() {}, info() {} },
  });
  try {
    // 渲染层收到 tab:new 之后会挂 webview 并上报 tabReady；这里用假 guest 模拟这一步。
    win.webContents.send = (channel, payload) => {
      sent.push([channel, payload]);
      if (channel !== 'browser:tab:new') return;
      const guest = fakeGuest();
      guests.push(guest);
      // tabReady 可能早于 registerGuest 完成：controller 会先记进 pendingReady。
      controller.tabReady('t1', guest.id, payload.spaceId);
      void controller.registerGuest(guest).catch(() => {});
    };

    const target = await controller.newTab(urlOf(projectFile('page.html')), 'default');
    assert.equal(sent.length, 1, '只发一次 tab:new');
    assert.equal(sent[0][1].url, undefined, '本地文件绝不能当 webview 的初始 src（会被 will-attach-webview 拒）');
    assert.equal(guests[0].loaded.length, 1, '建好标签页之后必须由 target.navigate 加载真实文件');
    assert.match(guests[0].loaded[0], /^file:\/\/\//);
    assert.equal(target.tabId, 't1');

    // 根外：判定在开标签页之前就失败，不留下一个空标签页。
    sent.length = 0;
    await assert.rejects(controller.navigate(urlOf(outsideFile('secret.html')), 'default'), error => {
      assert.equal(error.code, 'file_outside_roots');
      return true;
    });
    assert.equal(sent.length, 0, '根外不允许时不许发 tab:new');
  } finally {
    await controller.close();
  }
});
