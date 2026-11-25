/**
 * 负责：把一个 SVG 图标栅格化成 Windows 需要的 `assets/app-icon.png` + 多尺寸 `assets/app-icon.ico`。
 * 不负责：把图标接到窗口上（`electron/main.cjs` 的 `icon:`），也不做打包（本仓库没有打包链路）。
 * 被谁调用：手工跑一次即可，换图标时重跑：
 *
 *   node_modules\electron\dist\electron.exe scripts\make-icon.cjs
 *
 * 为什么要用 Electron 自己来栅格化：仓库里没有 SVG 渲染库（也不允许新增依赖），
 * 而 Chromium 本来就在我们手里——开一个离屏窗口把 SVG 当文档加载，512×512 抓一帧就是 1:1 位图。
 * ICO 容器是手写的（Windows Vista+ 支持条目内直接放 PNG），见 buildIco()。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * 追踪日志：写文件而不是只靠 stdout。
 * Electron 的 GUI 进程在 `app.exit()` 时可能来不及刷新 stdout，排查阶段会看到「跑到一半就没输出了」。
 */
const TRACE_PATH = join(__dirname, '..', 'qa', 'icon-trace.log');
function trace(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { appendFileSync(TRACE_PATH, line); } catch { /* 目录不存在就只打 stdout */ }
  process.stdout.write(line);
}

const SVG_PATH = process.env.MOVA_ICON_SVG || 'C:\\Users\\34119\\Desktop\\mova_icon_final.svg';
const OUT_DIR = join(__dirname, '..', 'assets');
const MASTER = 512;
/** ICO 里放的尺寸：Windows 会按任务栏 / 标题栏 / Alt-Tab 各自挑最合适的一档。 */
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

/**
 * 手写 ICO 容器：6 字节头 + 每张 16 字节目录 + 各张 PNG 原样拼接。
 * @param {Array<{size: number, png: Buffer}>} images
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    // 256 在这两个字节里写 0（规范如此），不是 256。
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // 调色板颜色数：0 = 真彩
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map(item => item.png)]);
}

async function renderMaster(svg) {
  // 直接让 Chromium 渲染这个 SVG 文档：viewBox 是 512×512，窗口同尺寸即为 1:1。
  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:${MASTER}px;height:${MASTER}px}</style>${svg}`;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // 等一帧：离屏渲染在 load 完成之后才产出第一帧。
    await new Promise(resolve => setTimeout(resolve, 400));
    const image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) throw new Error('capturePage 返回空图');
    return image;
  } finally {
    win.destroy();
  }
}

async function main() {
  await app.whenReady();
  // Electron 的默认行为是「所有窗口关掉就退出应用」：渲染用的离屏窗口一 destroy，
  // 进程就干净地退出了，后面写文件那些 await 全部不会跑（现象是「退出码 0 但只生成了一半」）。
  // 这里必须显式接管这个事件。
  app.on('window-all-closed', () => { /* 写文件期间不许退出 */ });
  trace('app ready');
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(join(__dirname, '..', 'qa'), { recursive: true });
  const svg = await readFile(SVG_PATH, 'utf8');
  trace(`svg ${svg.length} bytes`);
  const master = await renderMaster(svg);
  const { width, height } = master.getSize();
  trace(`主图 ${width}×${height}`);

  const masterPath = join(OUT_DIR, 'app-icon.png');
  await writeFile(masterPath, master.toPNG());
  trace(`写出 ${masterPath}`);

  const images = ICO_SIZES.map(size => {
    const resized = master.resize({ width: size, height: size, quality: 'best' });
    const png = resized.toPNG();
    trace(`  ${size}: ${png.length} bytes`);
    return { size, png };
  });
  const icoPath = join(OUT_DIR, 'app-icon.ico');
  await writeFile(icoPath, buildIco(images));
  trace(`写出 ${icoPath}（${ICO_SIZES.join('/')}）`);

  // 回读校验：ICO 能读出最大那一档，说明容器结构没写错。
  const check = nativeImage.createFromPath(icoPath);
  trace(`回读 ICO：${check.isEmpty() ? '空（结构有问题）' : JSON.stringify(check.getSize())}`);
  app.exit(check.isEmpty() ? 1 : 0);
}

main().catch(error => {
  trace(`生成图标失败：${error?.stack || error}`);
  app.exit(2);
});
