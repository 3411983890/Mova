'use strict';
/**
 * 负责：使用本机 Electron 渲染并校验 `docs/prototypes/promo/index.html` 60 秒宣传片，导出 48kHz 立体声 WAV 音轨、6 幕高清关键帧 PNG 与 60fps WebM 成片。
 * 不负责：不改动宣传片的分镜时间轴或应用业务源码，也不引入任何外部 npm 依赖。
 * 被谁调用：开发者或 CI 命令行直接执行（`node scripts/probes/record-promo.cjs [--keyframes | --record]`）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROMO_DIR = path.join(ROOT, 'docs', 'prototypes', 'promo');
const OUT_DIR = path.join(ROOT, '.test-temp', 'promo-out');

// 若由普通 node 启动，则自动转发给本地 electron 二进制执行
if (!process.versions.electron) {
  const electronBin = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const res = spawnSync(electronBin, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
    windowsHide: false,
  });
  process.exit(res.status ?? 1);
}

const { app, BrowserWindow, session } = require('electron');

const KEYFRAMES = [
  { t: 1.85, name: '01a-awakening-ball.png', label: 'Act 1 · 情绪小球光环唤醒' },
  { t: 4.75, name: '01b-awakening-wordmark.png', label: 'Act 1 · Mova 纯色字标合拢' },
  { t: 14.80, name: '02a-chatmova-search.png', label: 'Act 2 · ChatMova 多源检索与引用' },
  { t: 16.85, name: '02b-chatmova-quote.png', label: 'Act 2 · 选区「引用文本」浮层' },
  { t: 25.45, name: '03a-codemova-goal-usage.png', label: 'Act 3 · CodeMova 目标推进与 Token 卡片' },
  { t: 29.10, name: '03b-codemova-approval-diff.png', label: 'Act 3 · CodeMova 行级 Diff 审批条' },
  { t: 34.80, name: '04a-movabot-builder.png', label: 'Act 4 · MovaBot 新建角色与思考档位' },
  { t: 38.40, name: '04b-movabot-group.png', label: 'Act 4 · MovaBot 多智能体协同会话' },
  { t: 44.10, name: '05a-viewer-code.png', label: 'Act 5 · 右侧统一面板代码高亮定位' },
  { t: 47.65, name: '05b-viewer-inspector.png', label: 'Act 5 · 页面元素拾取器描边与标签' },
  { t: 51.85, name: '05c-openpencil-canvas.png', label: 'Act 5 · OpenPencil 矢量设计画布' },
  { t: 55.50, name: '06a-local-memory-vault.png', label: 'Act 6 · 凭据遮盖 / 混合检索 / 隐私保险库' },
  { t: 58.50, name: '06b-outro-wordmark.png', label: 'Act 6 · 品牌定格收尾' },
];

/**
 * 在页面内录制完整 60 秒 WebM 并按块回传 base64。
 * @param {import('electron').BrowserWindow} win
 * @param {string} webmPath
 */
async function recordFullWebm(win, webmPath) {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: win.webContents.mainFrame });
  });
  console.log('[promo] starting 60s real-time 60fps capture...');
  const b64 = await win.webContents.executeJavaScript(`
    (async () => {
      const chunks = [];
      window.recorderBridge = {
        chunk(u8) { chunks.push(u8); },
        done() {},
      };
      await window.promo.record({ bitrate: 14000000, fps: 60 });
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
      let s = '';
      for (let i = 0; i < merged.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, merged.subarray(i, i + 0x8000));
      }
      return btoa(s);
    })()
  `);
  fs.writeFileSync(webmPath, Buffer.from(b64, 'base64'));
  console.log(`[promo] wrote video: ${webmPath}`);
}

async function run() {
  const modeRecord = process.argv.includes('--record');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    show: modeRecord,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const pageErrors = [];
  win.webContents.on('page-error', (err) => pageErrors.push(String(err)));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) pageErrors.push(message);
  });

  const url = `file://${path.join(PROMO_DIR, 'index.html').replace(/\\/g, '/')}?export=1`;
  await win.loadURL(url);

  // 1. 全时间轴 241 个采样点确定性校验（0.00s -> 60.00s）
  const sweepResult = await win.webContents.executeJavaScript(`
    (() => {
      for (let i = 0; i <= 240; i++) {
        window.promo.seek(i * 0.25);
      }
      return { duration: window.promo.duration, cues: window.promo.cues.length };
    })()
  `);
  console.log(`[promo] timeline sweep OK: duration=${sweepResult.duration}s, audioCues=${sweepResult.cues}`);

  // 2. 离线渲染 48kHz 双声道 WAV 音轨
  const wavB64 = await win.webContents.executeJavaScript('window.promo.renderWavBase64()');
  const wavPath = path.join(OUT_DIR, 'mova-promo-audio.wav');
  fs.writeFileSync(wavPath, Buffer.from(wavB64, 'base64'));
  console.log(`[promo] wrote 48kHz stereo WAV: ${wavPath} (${fs.statSync(wavPath).size} bytes)`);

  // 3. 截取 6 幕关键帧 PNG
  for (const kf of KEYFRAMES) {
    await win.webContents.executeJavaScript(`window.promo.seek(${kf.t})`);
    await new Promise((r) => setTimeout(r, 60));
    const img = await win.webContents.capturePage();
    const outPath = path.join(OUT_DIR, kf.name);
    fs.writeFileSync(outPath, img.toPNG());
    console.log(`[promo] keyframe t=${kf.t.toFixed(2)}s -> ${kf.name} (${kf.label})`);
  }

  // 4. 可选：实时录制完整 60fps WebM
  if (modeRecord) {
    const webmPath = path.join(OUT_DIR, 'mova-promo.webm');
    await recordFullWebm(win, webmPath);
  }

  if (pageErrors.length > 0) {
    console.error('[promo] page errors detected:', pageErrors);
    app.exit(1);
    return;
  }

  win.destroy();
  app.quit();
}

app.whenReady().then(run).catch((err) => {
  console.error('[promo] fatal:', err);
  app.exit(1);
});
