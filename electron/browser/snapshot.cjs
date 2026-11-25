'use strict';
// CDP AXTree -> compact snapshot + diff. One instance per tab: it remembers the
// previous snapshot so `mode:"auto"` can return only what changed.
//
// 按需采集（P2）：
// - frames:"none"  完全不看 iframe（最快，适合已知只看主文档的步骤）
// - frames:"index" 默认。只列出 iframe 的编号/网址，正文用 frame:"f1" 单独取；
//                  复杂页面因此不会再因为 iframe 内容把预算吃光。
// - frames:"all"   旧行为：把每个 iframe 的内容直接拼进快照。
// - frame:"f1"     只采集这一个 iframe（跨域时返回明确原因，而不是静默空内容）。
// - ref:"@e12"     只采集该节点子树（「展开这一块」），用于大表格/长列表。

const { compactAxTree } = require('./ax-compact.cjs');
const { diffSnapshots } = require('./diff.cjs');

const MAX_FRAMES = 6;
const FRAME_MODES = new Set(['none', 'index', 'all']);

function frameModeOf(options = {}) {
  if (options.frame) return 'none';
  if (FRAME_MODES.has(options.frames)) return options.frames;
  // 兼容旧参数：scope:"main" 一直是不含 iframe 的意思。
  return options.scope === 'main' ? 'none' : 'index';
}

async function listFrames(cdp, maxFrames) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const children = Array.isArray(frameTree?.childFrames) ? frameTree.childFrames : [];
  const frames = [];
  for (let index = 0; index < Math.min(children.length, maxFrames); index += 1) {
    const frame = children[index]?.frame;
    if (!frame || !frame.id) continue;
    frames.push({ id: `f${index + 1}`, frameId: frame.id, url: frame.url || '', index: index + 1 });
  }
  return frames;
}

async function captureFrame(cdp, frame, options = {}) {
  const prefix = `${frame.id}:`;
  try {
    const ax = await cdp.send('Accessibility.getFullAXTree', { frameId: frame.frameId }, 10000);
    const compact = compactAxTree(ax.nodes || [], {
      header: false,
      baseIndent: 0,
      framePrefix: prefix,
      maxChars: options.maxChars || 12000,
      maxNodes: options.maxNodes,
    });
    return {
      ok: true,
      frame,
      text: compact.text,
      entries: compact.entries.map(entry => ({ ...entry, key: `${prefix}${entry.key}`, frame: frame.id })),
      truncated: compact.truncated,
    };
  } catch (error) {
    return { ok: false, frame, code: error?.code || 'frame-unreadable', message: error?.message || 'error' };
  }
}

async function capture(cdp, options = {}) {
  const scope = options.scope || 'page';
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 24000;
  const url = options.url || cdp.guest.getURL();
  const title = options.title || cdp.guest.getTitle();
  const frameMode = frameModeOf(options);
  const maxFrames = Number.isInteger(options.maxFrames) ? Math.max(1, Math.min(MAX_FRAMES, options.maxFrames)) : MAX_FRAMES;

  // 只取某一个 frame 时，不抓主文档树：这正是「按需采集」省下的那部分。
  if (options.frame) {
    let available = [];
    try { available = await listFrames(cdp, maxFrames); } catch { /* frame tree is optional */ }
    const wanted = available.find(item => item.id === String(options.frame));
    if (!wanted) {
      return {
        url, title, scope: `frame:${options.frame}`, takenAt: Date.now(),
        text: `# scope frame:${options.frame}\n- no such frame; call browser_snapshot with frames:"index" first`,
        entries: [], frames: available, truncated: false, chars: 0,
      };
    }
    const one = await captureFrame(cdp, wanted, { maxChars, maxNodes: options.maxNodes });
    const header = `# page ${url}${title ? `  "${title}"` : ''}\n# scope frame:${wanted.id}${one.ok ? '' : `  [unreadable: ${one.code}]`}`;
    return {
      url, title, scope: `frame:${wanted.id}`, takenAt: Date.now(),
      text: one.ok
        ? `${header}\n${one.text}`
        : `${header}\n- cross-origin frame "${wanted.url}": 无法读取内容；需要用户在该站点授权，或直接用 browser_navigate 打开该网址`,
      entries: one.ok ? one.entries : [],
      frames: available,
      truncated: Boolean(one.truncated),
      crossOrigin: one.ok ? undefined : true,
      chars: one.ok ? one.text.length : 0,
    };
  }

  const axResult = await cdp.send('Accessibility.getFullAXTree', {}, 15000);
  const main = compactAxTree(axResult.nodes || [], {
    url, title, scope, maxChars,
    rootRef: options.ref || options.root,
    maxNodes: options.maxNodes,
  });

  const frameList = [];
  const frameEntries = [];
  const frameLines = [];
  let frameText = '';
  if (frameMode !== 'none') {
    let available = [];
    try { available = await listFrames(cdp, maxFrames); } catch { /* frame tree is optional */ }
    for (const item of available) {
      if (frameMode === 'index') {
        frameList.push({ ...item });
        frameLines.push(`- iframe ${item.id} "${item.url}" — 用 browser_snapshot {frame:"${item.id}"} 读取内容`);
        continue;
      }
      const one = await captureFrame(cdp, item, { maxChars: Math.max(2000, Math.floor(maxChars / 2)) });
      frameList.push({ ...item, readable: one.ok, ...(one.ok ? {} : { code: one.code }) });
      if (one.ok) {
        frameText += `\n- iframe ${item.id} "${item.url}"\n${one.text}`;
        frameEntries.push(...one.entries);
      } else {
        frameText += `\n- iframe ${item.id} "${item.url}" [unreadable: ${one.code}]`;
      }
    }
  }

  const text = [main.text, ...(frameLines.length ? ['# iframes', ...frameLines] : []), frameText]
    .filter(Boolean).join('\n');

  return {
    url,
    title,
    scope,
    takenAt: Date.now(),
    text,
    entries: [...main.entries, ...frameEntries],
    frames: frameList,
    rooted: main.rooted,
    truncated: main.truncated,
    chars: main.chars + frameText.length,
  };
}

function diff(previous, current, threshold) {
  if (!previous) return { mode: 'full', reason: 'first-snapshot', text: current.text, entries: current.entries };
  const result = diffSnapshots(
    { url: previous.url, entries: previous.entries },
    { url: current.url, entries: current.entries },
    typeof threshold === 'number' ? { threshold } : undefined,
  );
  if (result.mode === 'full') {
    return { mode: 'full', reason: result.reason, text: current.text, entries: current.entries };
  }
  return { mode: 'diff', text: result.text, entries: current.entries, stats: result.stats };
}

function createSnapshotEngine(cdp) {
  let previous = null;
  let inFlight = null;

  async function take(options = {}) {
    if (inFlight) throw new Error('snapshot-in-flight');
    inFlight = (async () => {
      const current = await capture(cdp, options);
      const mode = options.mode || 'auto';
      let result;
      if (mode === 'full' || !previous || previous.url !== current.url) {
        result = { mode: 'full', text: current.text, entries: current.entries, url: current.url, title: current.title };
      } else {
        result = { ...diff(previous, current, options.threshold), url: current.url, title: current.title };
        if (result.mode === 'full') result.entries = current.entries;
      }
      if (current.frames && current.frames.length) result.frames = current.frames;
      if (current.scope !== 'page') result.scope = current.scope;
      if (current.truncated) result.truncated = true;
      if (current.crossOrigin) result.crossOrigin = true;
      previous = current;
      return result;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    take,
    reset() { previous = null; },
    get previous() { return previous; },
  };
}

module.exports = { capture, diff, createSnapshotEngine, frameModeOf, MAX_FRAMES };
