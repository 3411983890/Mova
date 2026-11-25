'use strict';
// 桌面操作冒烟：验证 PowerShell UIA worker 通道（不依赖 Electron）
// 用法：node scripts/desktop-smoke.cjs [--app 微信]
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const { createHost } = require(path.join(root, 'electron', 'desktop', 'host.cjs'));
const { compact } = require(path.join(root, 'electron', 'desktop', 'compact.cjs'));

function line(label, value) {
  console.log(`[smoke] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main() {
  const wantApp = (() => {
    const i = process.argv.indexOf('--app');
    return i > 0 ? process.argv[i + 1] : '微信';
  })();

  const host = createHost({
    scriptPath: path.join(root, 'electron', 'desktop', 'host', 'uia-worker.ps1'),
    timeoutMs: 20000,
  });

  const t0 = Date.now();
  await host.start();
  line('worker started (ms)', Date.now() - t0);

  const ping = await host.call('ping', {});
  line('ping', ping);

  const t1 = Date.now();
  const { windows } = await host.call('windows', {});
  line('windows (ms)', Date.now() - t1);
  line('window count', windows.length);

  const target = windows
    .filter((w) => (w.title || '').includes(wantApp) || /Qt\d+QWindowIcon|mmui::/.test(w.class || ''))
    .sort((a, b) => (b.rect[2] * b.rect[3]) - (a.rect[2] * a.rect[3]))[0];

  if (!target) {
    line('target', `未找到含「${wantApp}」的窗口`);
    await host.dispose();
    process.exit(2);
  }
  line('target window', { hwnd: target.hwnd, title: target.title, class: target.class, rect: target.rect });

  const t2 = Date.now();
  const tree = await host.call('tree', { hwnd: target.hwnd, maxDepth: 6, maxNodes: 800 });
  line('tree (ms)', Date.now() - t2);
  line('nodes', tree.nodes ? tree.nodes.length : 0);
  line('truncated/timedOut', { truncated: tree.truncated, timedOut: tree.timedOut });

  if (tree.nodes && tree.nodes.length) {
    const view = compact(tree.nodes, { maxChars: 3000 });
    const text = typeof view === 'string' ? view : view.text;
    line('compact', { chars: view.chars ?? (text || '').length, kept: view.kept, total: view.total, truncated: view.truncated });
    console.log('---- compact head ----');
    console.log(String(text || '').split('\n').slice(0, 25).join('\n'));
    console.log('---- end ----');
    fs.writeFileSync(path.join(root, 'design', 'e2e', 'smoke-tree.txt'), String(text || ''), 'utf8');
  }

  await host.dispose();
  line('done', true);
}

main().catch((err) => {
  console.error('[smoke] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
