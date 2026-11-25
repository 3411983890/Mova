/**
 * 负责：为 Linux 浏览器诊断会话接入现有浏览器 Skill 的浏览、快照、正文和截图操作。
 * 不负责：账号登录、网站提交、持久浏览器档案或模型编排。
 * 被谁调用：scripts/mova.mjs。
 */

import { setTimeout as delay } from 'node:timers/promises';
import browserTools from './tools.cjs';
import snapshotModule from './snapshot.cjs';
import readModule from './read.cjs';
import waitModule from './wait.cjs';
import { startHeadlessCdp } from './headless-cdp.mjs';
import { inspectUrl, startInspectProxy } from './headless-network.mjs';

const { createBrowserTools } = browserTools;
const { createSnapshotEngine } = snapshotModule;
const { readPage } = readModule;
const { waitFor } = waitModule;

function assertPage(frame, origin) {
  if (frame.unreachableUrl || new URL(frame.url).origin !== origin) {
    throw new Error('页面无法访问或已离开本次诊断授权的站点');
  }
}

async function loadedFrame(cdp, loaderId, origin, timeout, signal) {
  const until = Date.now() + timeout;
  let frame;
  do {
    signal?.throwIfAborted();
    frame = (await cdp.send('Page.getFrameTree')).frameTree.frame;
    if (!loaderId || frame.loaderId === loaderId || frame.unreachableUrl) break;
    await delay(50, undefined, { signal });
  } while (Date.now() < until);
  assertPage(frame, origin);
  const remaining = until - Date.now();
  if (remaining <= 0) throw new Error('页面加载超时');
  await waitFor(cdp, { for: 'load', timeout: remaining });
  return frame;
}

function pageOperations(browser, sessionId, origin, signal) {
  let page = { url: 'about:blank', title: '' };
  const send = (method, params, ms) => browser.send(method, params, ms, sessionId);
  const cdp = { send, guest: { getURL: () => page.url, getTitle: () => page.title } };
  const engine = createSnapshotEngine(cdp);

  async function snapshot(options = {}) {
    const { entries: _entries, ...result } = await engine.take(options);
    return { ok: true, ...result };
  }

  async function navigate(url, _space, { observe, timeout = 20_000 } = {}) {
    const target = inspectUrl(url);
    if (target.origin !== origin) throw new Error('网址超出本次诊断授权的站点');
    const navigation = await send('Page.navigate', { url: target.href }, timeout);
    if (navigation.errorText || navigation.isDownload) throw new Error(navigation.errorText || '目标需要下载文件');
    await loadedFrame(cdp, navigation.loaderId, origin, timeout, signal);
    const { result } = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    const { frameTree } = await send('Page.getFrameTree');
    assertPage(frameTree.frame, origin);
    page = { url: frameTree.frame.url, title: result?.value || '' };
    engine.reset();
    return { ok: true, ...page, ...(observe === 'none' ? {} : { observation: await snapshot({ mode: 'full' }) }) };
  }

  async function screenshot({ mode = 'viewport', fullPage } = {}) {
    if (mode !== 'viewport' || fullPage) throw new Error('本次 Linux 诊断支持当前视口截图');
    const { cssVisualViewport } = await send('Page.getLayoutMetrics');
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    return {
      ok: true, mode, mimeType: 'image/png', data,
      width: cssVisualViewport.clientWidth, height: cssVisualViewport.clientHeight,
    };
  }

  return { navigate, snapshot, read: options => readPage(cdp, options), screenshot };
}

export async function openHeadlessInspection({ url, binary = 'chrome-headless-shell', signal }) {
  signal?.throwIfAborted();
  const target = inspectUrl(url);
  const proxy = await startInspectProxy(target);
  let browser;
  async function close() {
    try { await browser?.close(); } finally { await proxy.close(); }
  }
  try {
    browser = await startHeadlessCdp({ binary, proxy: proxy.address, signal });
    const { targetInfos } = await browser.send('Target.getTargets');
    const page = targetInfos.find(info => info.type === 'page');
    if (!page) throw new Error('浏览器没有可用页面');
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const operations = pageOperations(browser, sessionId, target.origin, signal);
    const tools = createBrowserTools(operations).filter(tool => tool.name.slice('browser_'.length) in operations);
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
