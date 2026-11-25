'use strict';
// 截图管线：desktopCapturer → 裁剪 → 缩放到 token 预算 → 缓存 Frame{sha,path,scale,crop,dpr}。
// 照 Mova桌面操作开发方案.md §8.1 / §8.2。
//
// 本模块刻意不 require('electron')：desktopCapturer / screen / sharp 全部注入，
// 这样纯逻辑（尺寸、裁剪、去重、黑帧/蓝边检测）能脱离 Electron 单测。
//
//   const capture = createCapture({ desktopCapturer, screen, sharp, cacheDir });
//   const frame = await capture.grab({ displayId, maxLongEdge: 1280 });
//   // frame.ctx 可直接喂给 geometry.toPhysical(point, frame)

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { fitWithin, normalizeDisplay, rectOf, clampRectToDisplay, isRectEmpty } = require('./geometry.cjs');

const DEFAULT_MAX_FRAMES = 20;
const DEFAULT_MAX_LONG_EDGE = 1280; // §8.2：窗口级定位长边 1280
const DEFAULT_FORMAT = 'png';
// 单张缩略图的请求上限：再大只是白烧内存（4K 屏物理分辨率 3840 已覆盖）
const MAX_REQUEST_EDGE = 4096;
const BLACK_VARIANCE = 6;
const BLUE_DELTA = 18;
const BLUE_RATIO = 0.6;

function coded(code, message, extra) {
  const error = new Error(message || code);
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 screen（Electron screen 或 displays 数组）为 display 列表。 */
function toDisplays(screen) {
  if (!screen) return [];
  if (Array.isArray(screen)) return screen.map(normalizeDisplay);
  if (typeof screen.getAllDisplays === 'function') {
    try { return (screen.getAllDisplays() || []).map(normalizeDisplay); } catch { return []; }
  }
  return [];
}

/** displayId 优先按 id 匹配（字符串/数字都算），其次 primary，最后第一块。 */
function resolveDisplay(displays, displayId) {
  if (!displays.length) return null;
  if (displayId !== undefined && displayId !== null && displayId !== '') {
    const wanted = String(displayId);
    const hit = displays.find((display) => String(display.id) === wanted);
    if (hit) return hit;
  }
  return displays.find((display) => display.primary) || displays[0] || null;
}

/**
 * 从 sources 里挑目标显示器。
 * 1) source.display_id 命中 display.id（Windows 上通常有）；
 * 2) 没有 display_id 时按 sources 顺序对应 getAllDisplays 顺序（Linux 常见）；
 * 3) 都比不上就退回第一块 —— 但记 matchedBy:'fallback'，调用方可以据此降级。
 */
function pickScreenSource(sources, displays, display) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return null;
  const withId = list.filter((source) => source && source.display_id);
  if (display && display.id !== null && withId.length) {
    const byId = withId.find((source) => String(source.display_id) === String(display.id));
    if (byId) return { source: byId, matchedBy: 'display_id' };
  }
  if (display && withId.length === 0 && list.length === displays.length) {
    const index = displays.indexOf(display);
    if (index >= 0 && list[index]) return { source: list[index], matchedBy: 'index' };
  }
  return { source: list[0], matchedBy: 'fallback' };
}

/** windowId 支持完整 source id（window:123:0）或纯数字/子串。 */
function pickWindowSource(sources, windowId) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return null;
  const wanted = String(windowId);
  const exact = list.find((source) => source && String(source.id) === wanted);
  if (exact) return exact;
  const byIdPart = list.find((source) => source && String(source.id).split(':').includes(wanted));
  if (byIdPart) return byIdPart;
  const byTitle = list.find((source) => source && wanted && String(source.name || '').includes(wanted));
  return byTitle || null;
}

/** 裁剪走灰度小图算方差（比 sharp.stats 便宜，也避免 alpha 干扰）。 */
async function analyzeBlack(sharp, buffer) {
  const { data } = await sharp(buffer)
    .resize({ width: 64, height: 40, fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!data || !data.length) return { black: true, mean: 0, variance: 0 };
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i];
  const mean = sum / data.length;
  let acc = 0;
  for (let i = 0; i < data.length; i += 1) {
    const d = data[i] - mean;
    acc += d * d;
  }
  const variance = acc / data.length;
  return { black: variance < BLACK_VARIANCE || mean < 2, mean, variance };
}

/**
 * 边缘污染检测（§12.4）：采样四边各 40px 的带子，统计“偏蓝”（B−R > 18）比例。
 * 实现上把整图缩到 160 宽再取边框，等价但便宜得多。
 */
async function analyzeTaint(sharp, buffer, width, height) {
  const sampleWidth = Math.min(160, Math.max(16, Math.round(width)));
  const { data, info } = await sharp(buffer)
    .resize({ width: sampleWidth, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sw = info.width;
  const sh = info.height;
  const channels = info.channels || 3;
  // 40px 在原图上的占比（上下各 40 -> 80），换算到小图
  const bandFraction = Math.min(0.3, 80 / Math.max(1, Math.min(width, height)));
  const band = Math.max(1, Math.round(Math.min(sw, sh) * bandFraction));
  let sampled = 0;
  let blue = 0;
  for (let y = 0; y < sh; y += 1) {
    const edgeRow = y < band || y >= sh - band;
    for (let x = 0; x < sw; x += 1) {
      if (!edgeRow && x >= band && x < sw - band) continue;
      const offset = (y * sw + x) * channels;
      const r = data[offset];
      const b = data[offset + 2];
      sampled += 1;
      if (b - r > BLUE_DELTA && b > 40) blue += 1;
    }
  }
  const ratio = sampled ? blue / sampled : 0;
  return { tainted: ratio > BLUE_RATIO, blueRatio: Number(ratio.toFixed(3)), sampled };
}

/** 输出编码：png 原样（没有缩放时避免二次编码），jpeg 走 sharp。 */
async function encode(sharp, buffer, fit, format, needResize) {
  if (format === 'jpeg') {
    return sharp(buffer).resize(fit.width, fit.height, { fit: 'fill' }).jpeg({ quality: 82 }).toBuffer();
  }
  if (!needResize) return buffer;
  return sharp(buffer).resize(fit.width, fit.height, { fit: 'fill' }).png({ compressionLevel: 6 }).toBuffer();
}

/**
 * @param {object} deps
 * @param {object} deps.desktopCapturer Electron desktopCapturer
 * @param {object|object[]} deps.screen Electron screen（或 getAllDisplays() 数组）
 * @param {object} deps.sharp sharp 实例
 * @param {string} [deps.cacheDir] 截图落盘目录（通常是 userData/desktop/shots）
 * @param {number} [deps.maxFrames=20] 磁盘上保留的帧数
 * @param {object} [deps.logger]
 */
function createCapture(deps = {}) {
  const {
    desktopCapturer,
    screen,
    sharp,
    cacheDir = path.join(os.tmpdir(), 'mova-desktop-shots'),
    maxFrames = DEFAULT_MAX_FRAMES,
    logger = null,
  } = deps;
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    throw coded('capture-unavailable', 'desktopCapturer 未注入');
  }
  if (!sharp || typeof sharp !== 'function') throw coded('capture-unavailable', 'sharp 未注入');

  const frames = []; // {id, sha, path, at, width, height}
  let counter = 0;
  let lastSha = '';
  let disposed = false;
  let dirReady = null;

  function ensureDir() {
    if (!dirReady) dirReady = fs.mkdir(cacheDir, { recursive: true }).catch((error) => {
      dirReady = null;
      throw coded('capture-io', `无法创建截图目录: ${error.message}`);
    });
    return dirReady;
  }

  /** 超过 maxFrames 按 mtime 清理（不只看内存表，避免进程重启后目录膨胀）。 */
  async function prune() {
    try {
      const names = await fs.readdir(cacheDir);
      const files = [];
      for (const name of names) {
        if (!/^f_\d+_.*\.(png|jpe?g)$/i.test(name)) continue;
        const full = path.join(cacheDir, name);
        try {
          const stat = await fs.stat(full);
          files.push({ full, mtime: stat.mtimeMs });
        } catch { /* 并发删除，忽略 */ }
      }
      if (files.length <= maxFrames) return;
      files.sort((a, b) => b.mtime - a.mtime);
      for (const file of files.slice(maxFrames)) {
        try { await fs.unlink(file.full); } catch { /* ignore */ }
      }
    } catch (error) {
      logger?.warn?.(`[capture] prune 失败: ${error.message}`);
    }
  }

  /**
   * 抓一帧。
   * @param {object} [options]
   * @param {number|string} [options.displayId]
   * @param {number|string} [options.windowId] 抓窗口时用（types 自动切 window）
   * @param {{x:number,y:number,w?:number,h?:number,width?:number,height?:number}} [options.region]
   *        物理像素。绝对坐标优先；若明显是“显示器相对”写法（整块都在 0..display.w/h 内且
   *        display 原点不为 0）则自动加 display 原点。会被 clamp 到屏幕内。
   * @param {number} [options.maxLongEdge=1280]
   * @param {number} [options.maxPixels=1150000]
   * @param {'png'|'jpeg'} [options.format='png']
   * @param {boolean} [options.blackCheck=true] false 时跳过黑帧判定（纯色界面、自测用）
   * @returns {Promise<object>} Frame
   */
  async function grab(options = {}) {
    if (disposed) throw coded('disposed', 'capture 已释放');
    try {
      const displays = toDisplays(screen);
      if (!displays.length) throw coded('no-display', '没有可用的显示器');
      const display = resolveDisplay(displays, options.displayId);
      if (!display) throw coded('no-display', '找不到目标显示器');

      const maxLongEdge = num(options.maxLongEdge, DEFAULT_MAX_LONG_EDGE) || DEFAULT_MAX_LONG_EDGE;
      const maxPixels = Number.isFinite(Number(options.maxPixels)) ? Number(options.maxPixels) : 1150000;
      const format = options.format === 'jpeg' ? 'jpeg' : DEFAULT_FORMAT;
      if (options.windowId !== undefined && options.windowId !== null && options.windowId !== '') {
        return await grabWindow({ ...options, display, displays, maxLongEdge, maxPixels, format });
      }
      return await grabScreen({ ...options, display, displays, maxLongEdge, maxPixels, format });
    } catch (error) {
      if (error && error.code) throw error;
      throw coded('capture-failed', (error && error.message) || '截图失败');
    }
  }

  async function grabScreen(options) {
    const { display, displays, maxLongEdge, maxPixels, format } = options;
    const physical = display.physicalBounds;
    if (isRectEmpty(physical)) throw coded('capture-region-empty', '显示器物理矩形为空');

    let region = options.region ? rectOf(options.region) : { ...physical };
    if (options.region) {
      // 显示器相对坐标（0,0 起）自动补原点，避免“取了主屏却传了副屏相对坐标”这类经典错
      const relative = region.x >= 0 && region.y >= 0
        && region.x + region.w <= physical.w && region.y + region.h <= physical.h
        && (physical.x !== 0 || physical.y !== 0)
        && !(region.x >= physical.x && region.y >= physical.y
          && region.x + region.w <= physical.x + physical.w && region.y + region.h <= physical.y + physical.h);
      if (relative) region = { ...region, x: region.x + physical.x, y: region.y + physical.y };
    }
    region = clampRectToDisplay(region, physical);
    if (isRectEmpty(region)) throw coded('capture-region-empty', 'region 与显示器没有交集');

    const requestWidth = Math.min(MAX_REQUEST_EDGE, Math.max(1, physical.w));
    const requestHeight = Math.min(MAX_REQUEST_EDGE, Math.max(1, physical.h));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: requestWidth, height: requestHeight },
      fetchWindowIcons: false,
    });
    const picked = pickScreenSource(sources, displays, display);
    if (!picked || !picked.source || !picked.source.thumbnail) throw coded('capture-no-source', '没有拿到屏幕截图源');
    const source = picked.source;
    if (typeof source.thumbnail.isEmpty === 'function' && source.thumbnail.isEmpty()) {
      throw coded('capture-empty', 'desktopCapturer 返回空缩略图（锁屏 / 安全桌面 / 权限被拒）');
    }

    const raw = source.thumbnail.toPNG();
    const size = typeof source.thumbnail.getSize === 'function' ? source.thumbnail.getSize() : { width: requestWidth, height: requestHeight };
    const meta = await sharp(raw).metadata();
    const imgWidth = num(size.width) || num(meta.width);
    const imgHeight = num(size.height) || num(meta.height);
    if (!(imgWidth > 0) || !(imgHeight > 0)) throw coded('capture-empty', '截图尺寸为 0');

    // 整屏图 -> 物理像素的缩放（Windows 上通常正好 1；有 DPI/平台差异时以实际图为准）
    const kx = imgWidth / physical.w;
    const ky = imgHeight / physical.h;
    const cropImage = {
      x: Math.round((region.x - physical.x) * kx),
      y: Math.round((region.y - physical.y) * ky),
      w: Math.max(1, Math.round(region.w * kx)),
      h: Math.max(1, Math.round(region.h * ky)),
    };
    // extract 必须严格落在图内
    cropImage.w = Math.max(1, Math.min(cropImage.w, imgWidth - cropImage.x));
    cropImage.h = Math.max(1, Math.min(cropImage.h, imgHeight - cropImage.y));
    cropImage.x = Math.max(0, Math.min(cropImage.x, imgWidth - 1));
    cropImage.y = Math.max(0, Math.min(cropImage.y, imgHeight - 1));

    const fullFrame = cropImage.x === 0 && cropImage.y === 0
      && cropImage.w >= imgWidth && cropImage.h >= imgHeight;
    let buffer = raw;
    if (!fullFrame) {
      buffer = await sharp(raw).extract({ left: cropImage.x, top: cropImage.y, width: cropImage.w, height: cropImage.h }).png().toBuffer();
    }

    const fit = fitWithin(cropImage.w, cropImage.h, { maxLongEdge, maxPixels });
    const needResize = Math.abs(fit.width - cropImage.w) > 0 || Math.abs(fit.height - cropImage.h) > 0;
    const data = await encode(sharp, buffer, fit, format, needResize);

    const analysis = await analyzeBlack(sharp, data);
    if (options.blackCheck !== false && analysis.black) {
      throw coded('capture-black', '截图几乎是黑帧（锁屏 / 安全桌面 / DRM 内容）', { mean: analysis.mean, variance: analysis.variance });
    }
    const taint = await analyzeTaint(sharp, data, fit.width, fit.height);
    return await finish({
      data,
      display,
      crop: region,
      captureScale: fit.width / region.w,
      dpr: display.scaleFactor,
      width: fit.width,
      height: fit.height,
      format,
      space: 'screen',
      matchedBy: picked.matchedBy,
      taint,
    });
  }

  async function grabWindow(options) {
    const { display, maxLongEdge, maxPixels, format, windowId } = options;
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 2560, height: 1600 },
      fetchWindowIcons: false,
    });
    const source = pickWindowSource(sources, windowId);
    if (!source || !source.thumbnail) throw coded('capture-no-window', `找不到窗口 source: ${windowId}`);
    if (typeof source.thumbnail.isEmpty === 'function' && source.thumbnail.isEmpty()) {
      throw coded('capture-empty', '窗口缩略图为空（最小化 / 被隐藏）');
    }
    const raw = source.thumbnail.toPNG();
    const size = typeof source.thumbnail.getSize === 'function' ? source.thumbnail.getSize() : {};
    const meta = await sharp(raw).metadata();
    const imgWidth = num(size.width) || num(meta.width);
    const imgHeight = num(size.height) || num(meta.height);
    if (!(imgWidth > 0) || !(imgHeight > 0)) throw coded('capture-empty', '窗口截图尺寸为 0');

    const fit = fitWithin(imgWidth, imgHeight, { maxLongEdge, maxPixels });
    const needResize = fit.width !== imgWidth || fit.height !== imgHeight;
    const data = await encode(sharp, raw, fit, format, needResize);

    const analysis = await analyzeBlack(sharp, data);
    if (options.blackCheck !== false && analysis.black) {
      throw coded('capture-black', '窗口截图几乎是黑帧（DRM / 内容保护 / 窗口不可见）', { mean: analysis.mean, variance: analysis.variance });
    }
    const taint = await analyzeTaint(sharp, data, fit.width, fit.height);
    // 窗口源没有屏幕位置：crop 用窗口图原点，坐标是“窗口内物理像素”，
    // 调用方要加 windows.cjs 给的窗口 rect 原点（space:'window' 即为此标记）。
    return await finish({
      data,
      display,
      crop: { x: 0, y: 0, w: imgWidth, h: imgHeight },
      captureScale: fit.width / imgWidth,
      dpr: display.scaleFactor,
      width: fit.width,
      height: fit.height,
      format,
      space: 'window',
      matchedBy: 'window',
      taint,
    });
  }

  async function finish({ data, display, crop, captureScale, dpr, width, height, format, space, matchedBy, taint }) {
    const sha = crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);
    const frame = {
      sha,
      width,
      height,
      scale: captureScale,
      captureScale,
      crop: { ...crop },
      dpr,
      display: {
        id: display.id,
        scaleFactor: display.scaleFactor,
        bounds: display.bounds,
        physicalBounds: display.physicalBounds,
      },
      space,
      matchedBy,
      format,
      tainted: taint.tainted === true,
      taint: { blueRatio: taint.blueRatio, sampled: taint.sampled },
      bytes: data.length,
      ctx: {
        display: {
          id: display.id,
          scaleFactor: display.scaleFactor,
          bounds: display.bounds,
          physicalBounds: display.physicalBounds,
        },
        crop: { ...crop },
        captureScale,
        dpr,
      },
    };

    // 同 sha：命中缓存，不再落盘、不再发图（§8.7「图片只发一次」）
    const previous = frames.find((item) => item.sha === sha);
    if (previous) {
      lastSha = sha;
      logger?.info?.(`[capture] 帧去重 ${sha} -> ${previous.id}`);
      return { ...frame, ok: true, cached: true, cachedFrame: previous.id, path: previous.path, buffer: null };
    }

    await ensureDir();
    counter += 1;
    const id = `f_${counter}`;
    const fileName = `${id}_${sha.slice(0, 8)}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    const filePath = path.join(cacheDir, fileName);
    await fs.writeFile(filePath, data);

    const entry = { id, sha, path: filePath, at: Date.now(), width, height };
    frames.push(entry);
    while (frames.length > maxFrames) frames.shift();
    lastSha = sha;
    prune();

    return {
      ...frame,
      ok: true,
      cached: false,
      frameId: id,
      path: filePath,
      buffer: data,
    };
  }

  function frameSha() {
    return lastSha;
  }

  function status() {
    return { frames: frames.length, maxFrames, lastSha, cacheDir, disposed };
  }

  async function dispose() {
    disposed = true;
    frames.length = 0;
    lastSha = '';
  }

  return { grab, frameSha, status, dispose, cacheDir };
}

module.exports = {
  createCapture,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_LONG_EDGE,
  BLACK_VARIANCE,
  BLUE_DELTA,
  BLUE_RATIO,
};
