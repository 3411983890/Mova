/**
 * 负责：把一份「自包含」的启动动画 HTML 拆成 HTML + 外部 JS，写进 `electron/splash/`。
 * 不负责：把动画挂到界面上（`index.html` 的 `#boot-splash` 覆盖层 + `app.js` 的揭幕逻辑）、
 *   也不负责往 dist 拷（`scripts/build.mjs` 的 staticEntries 干这件事）。
 * 被谁调用：换启动动画时手工跑一次：`node scripts/split-splash.mjs [源 HTML]`。
 *
 * 为什么必须拆：应用所有 `mova://` 响应都带 `script-src 'self'` 的 CSP（`electron/main.cjs` 的 CSP），
 * **内联脚本一律被拦**。原始动画把五段逻辑内联在 HTML 里，直接放进 iframe 只会得到一张静止的画面
 * ——而且不报错，很难看出来。拆成外部文件后既满足 CSP，也让页面保持自身样式与逻辑隔离。
 */
import { readFile, writeFile } from 'node:fs/promises';

const source = process.argv[2]
  || '.mova-backups/restructure-20261114-022545/mova-startup.html';
const targetDir = 'electron/splash';

const html = await readFile(source, 'utf8');
const blocks = [];
const withoutScripts = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_match, body) => {
  blocks.push(body);
  return '';
});
if (!blocks.length) throw new Error('源文件里没有内联 <script>，不需要拆分');

// 顺序必须保持：这几段脚本是顺序依赖的（先数据层、再引擎、最后挂载）。
const js = blocks
  .map((body, index) => `/* ── block ${index + 1} / ${blocks.length} ───────────────────────────── */\n${body.trim()}`)
  .join('\n\n');

const withLoader = withoutScripts.replace(
  '</body>',
  '  <script src="mova-startup.js"></script>\n</body>',
);
if (!withLoader.includes('mova-startup.js')) throw new Error('没找到 </body>，无法插入脚本引用');

await writeFile(`${targetDir}/mova-startup.html`, withLoader, 'utf8');
await writeFile(`${targetDir}/mova-startup.js`, `${js}\n`, 'utf8');
console.log(`拆出 ${blocks.length} 段脚本 → ${targetDir}/mova-startup.js（${js.length} 字符）`);
console.log(`HTML 剩余 ${withLoader.length} 字符（原 ${html.length}）`);
