import { pageOperation } from './page.js';
import { compatiblePointerViewport, dispatchPointer, getPointerViewport, pointerPoints } from './pointer.js';

document.documentElement.classList.add('mova-edge');
const endpoint = 'http://127.0.0.1:43729/edge';
const testPageUrl = new URL('/edge-test', endpoint).href;
let token = localStorage.getItem('mova.edge.token') || '';
let preset = localStorage.getItem('mova.edge.preset') || 'default';
const listeners = new Map();
const subscribe = (key, listener) => {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(listener);
  return () => listeners.get(key)?.delete(listener);
};
const emit = (key, payload) => listeners.get(key)?.forEach(listener => listener(payload));
const pairing = document.querySelector('#edge-pair-dialog');
const accessDialog = document.querySelector('#edge-access-dialog');
const accessConfirm = document.querySelector('#edge-access-confirm');
const pairStatus = document.querySelector('#edge-pair-status');
const pageToggle = document.querySelector('#edge-page');
const pageMenu = document.querySelector('#edge-page-menu');
const pairCode = document.querySelector('#edge-code');
const pageStatus = document.querySelector('#edge-page-status');
let target;
let agentGroupId;
const agentTabIds = new Set();
const authorizedTabs = new Map();
let pendingTabAccess;
const webOrigins = ['http://*/*', 'https://*/*'];
let groupWindowId;
async function restoreGroup(windowId) {
  if (groupWindowId === windowId) return;
  const key = `mova.agentGroup.${windowId}`;
  const saved = (await chrome.storage.session.get(key))[key];
  if (groupWindowId === windowId) return;
  if (saved && Number.isInteger(saved.id) && Array.isArray(saved.tabs)) {
    const live = await chrome.tabs.query({ windowId, groupId: saved.id });
    if (groupWindowId === windowId) return;
    if (live.length) {
      agentGroupId = saved.id;
      for (const tab of live) if (saved.tabs.includes(tab.id)) agentTabIds.add(tab.id);
    }
  }
  groupWindowId = windowId;
}
chrome.tabs.onRemoved.addListener(tabId => {
  agentTabIds.delete(tabId);
  authorizedTabs.delete(tabId);
  if (pendingTabAccess?.tabId === tabId) pendingTabAccess.finish(new Error('等待授权的标签页已关闭。'));
});

function fetchRpc(op, args, credential = token) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
    body: JSON.stringify({ op, args }),
  });
}
async function rpc(op, ...args) {
  try {
    const response = await fetchRpc(op, args, op === 'pair' ? '' : token);
    const result = await response.json();
    if (op !== 'pair' && response.status === 401 && !pairing.open) pairing.showModal();
    return result;
  } catch {
    return { ok: false, error: '无法连接本机 Mova。请启动桌面端并生成配对码。' };
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getAgentTab(tabId, windowId) {
  if (!Number.isInteger(tabId) || !agentTabIds.has(tabId)) throw new Error('Select a tab from browser_group_tabs.');
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId || tab.groupId !== agentGroupId) throw new Error('Tab is outside the Mova Agent group in this window.');
  return tab;
}

function canControlPage(tab, windowId) {
  return tab?.windowId === windowId && (tab.groupId === (chrome.tabGroups.TAB_GROUP_ID_NONE ?? -1)
    ? tab.active : tab.groupId === agentGroupId && agentTabIds.has(tab.id));
}

async function getPageTab(tabId, windowId) {
  if (!Number.isInteger(tabId)) throw new Error('请选择当前未分组网页或 Mova Agent 分组网页。');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw browserError('page-closed', '目标标签页已关闭。', '重新打开目标网页。');
  if (!canControlPage(tab, windowId)) throw new Error('请选择当前未分组网页或 Mova Agent 分组网页。');
  return tab;
}

function waitForTabAccess(tabId, signal, automatic = false) {
  if (pendingTabAccess) throw new Error('Another tab authorization is already pending.');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error, authorization) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      pendingTabAccess = undefined;
      if (automatic && accessDialog.open) accessDialog.close();
      if (error) reject(error);
      else resolve(authorization);
    };
    const cancel = () => finish(new Error('Tab authorization cancelled.'));
    const timer = setTimeout(() => finish(new Error('Tab authorization timed out.')), 110_000);
    pendingTabAccess = { tabId, signal, finish, automatic };
    signal.addEventListener('abort', cancel, { once: true });
    if (automatic) {
      pageStatus.textContent = '等待首次网页授权';
      accessDialog.showModal();
    } else {
      pageStatus.textContent = '等待授权：点击 Edge 工具栏的 Mova 图标，再打开侧栏地球菜单，选择「允许网页控制」。';
    }
  });
}

async function openAgentTab(value, windowId, signal) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS pages without embedded credentials can be opened.');
  }
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  try {
    const groups = await chrome.tabGroups.query({ windowId });
    agentGroupId = groups.some(group => group.id === agentGroupId)
      ? await chrome.tabs.group({ groupId: agentGroupId, tabIds: tab.id })
      : await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId } });
    await chrome.tabGroups.update(agentGroupId, { title: 'Mova Agent', color: 'blue', collapsed: false });
    signal.throwIfAborted();
    agentTabIds.add(tab.id);
    await chrome.tabs.update(tab.id, { url: url.href, active: true });
    await chrome.storage.session.set({
      [`mova.agentGroup.${windowId}`]: { id: agentGroupId, tabs: [...agentTabIds] },
    });
    target = undefined;
    pageToggle.setAttribute('aria-pressed', 'false');
    pageStatus.textContent = '请在新标签页点击 Mova 扩展图标，再从地球菜单允许网页控制。';
    return { opened: true, tabId: tab.id, group: 'Mova Agent', requiresAuthorization: true };
  } catch (error) {
    agentTabIds.delete(tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}
async function runPage(tabId, operation, args, documentId) {
  let execution;
  try {
    [execution] = await chrome.scripting.executeScript({
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId },
      func: pageOperation, args: [operation, args],
    });
  } catch (error) {
    if (!await chrome.tabs.get(tabId).catch(() => null)) {
      throw browserError('page-closed', '网页标签页已关闭。', '重新打开网页。');
    }
    if (/access|permission|cannot be scripted/i.test(error.message)) {
      throw browserError('page-unauthorized', error.message, '授权当前网页后再试。');
    }
    if (/document|frame/i.test(error.message)) {
      throw browserError('document-changed', error.message, '重新授权并获取新页面快照。');
    }
    throw error;
  }
  if (!execution?.result) throw browserError('page-result-missing', '网页脚本没有返回执行结果。', '重新读取页面状态，确认前一步是否执行。');
  if (execution.result.error) {
    const { code, message, suggestion, detail } = execution.result.error;
    throw browserError(code, message, suggestion, detail);
  }
  return execution;
}

function browserError(code, message, suggestion, detail) {
  return Object.assign(new Error(message), { code, suggestion, detail });
}

async function bindTab(tab, signal) {
  signal?.throwIfAborted();
  if (!/^https?:\/\//.test(tab?.url || '')) throw new Error('当前标签页还没有可访问的网页。');
  const info = await runPage(tab.id, 'bind', {});
  signal?.throwIfAborted();
  const latest = await chrome.tabs.get(tab.id);
  if (latest.url !== tab.url || latest.windowId !== tab.windowId || latest.groupId !== tab.groupId ||
      info.result.origin !== new URL(tab.url).origin) throw new Error('网页已切换，请重新选择标签页。');
  return { tabId: tab.id, windowId: tab.windowId, documentId: info.documentId, url: tab.url, origin: info.result.origin };
}

function applyTabAccess(authorization) {
  target = authorization;
  authorizedTabs.set(target.tabId, target);
  pageToggle.setAttribute('aria-pressed', 'true');
  pageStatus.textContent = new URL(target.origin).hostname;
}

async function autoBind(tabId, windowId, signal) {
  const deadline = Date.now() + 2500;
  for (;;) {
    const tab = await getPageTab(tabId, windowId);
    try {
      return await bindTab(tab, signal);
    } catch (error) {
      signal.throwIfAborted();
      const url = /^https?:\/\//.test(tab.url || '') ? new URL(tab.url) : null;
      const origins = url ? [`${url.protocol}//${url.hostname}/*`] : webOrigins;
      if (!await chrome.permissions.contains({ origins })) {
        throw Object.assign(new Error('Edge 尚未授予自动网页访问。'), { code: 'edge-host-permission-required' });
      }
      if ((!tab.pendingUrl && tab.status !== 'loading') || Date.now() >= deadline) {
        throw new Error(`Edge 无法访问该分组网页：${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }
}

async function autoBindWithConsent(tabId, windowId, session, signal) {
  try {
    return await autoBind(tabId, windowId, signal);
  } catch (error) {
    if (error.code !== 'edge-host-permission-required' || session.accessPrompted || session.preset !== 'full') throw error;
    session.accessPrompted = true;
    return waitForTabAccess(tabId, signal, true);
  }
}
pageToggle.addEventListener('click', async () => {
  pageMenu.hidePopover();
  try {
    const { id: windowId } = await chrome.windows.getCurrent();
    await restoreGroup(windowId);
    const tab = await activeTab();
    if (target && tab?.id === target.tabId && tab.url === target.url) {
      authorizedTabs.delete(target.tabId);
      target = undefined;
      pageToggle.setAttribute('aria-pressed', 'false');
      pageStatus.textContent = '';
      return;
    }
    if (!canControlPage(tab, windowId)) {
      pageStatus.textContent = '请选择当前未分组网页或 Mova Agent 分组网页。';
      return;
    }
    if (!/^https?:\/\//.test(tab?.url || '')) throw new Error();
    applyTabAccess(await bindTab(tab));
    if (pendingTabAccess?.tabId === tab.id) pendingTabAccess.finish(null, target);
  } catch {
    pageStatus.textContent = '请在目标网页点击 Edge 工具栏的 Mova 图标，再启用网页控制。';
  }
});

async function execute(command, session, windowId, signal) {
  const verify = async () => {
    signal.throwIfAborted();
    if (session.testPage) {
      const test = session.testPage;
      const tab = await chrome.tabs.get(test.tabId).catch(() => null);
      if (!tab) throw browserError('page-closed', '隔离测试页已关闭。', '重新打开 browser_test_page。');
      if (tab.windowId !== test.windowId || !tab.active || tab.url !== testPageUrl) {
        throw browserError('document-changed', '隔离测试页已切换。', '关闭并重新打开 browser_test_page。');
      }
      return session.target;
    }
    const tab = await activeTab();
    if (session.target && !await chrome.tabs.get(session.target.tabId).catch(() => null)) {
      throw browserError('page-closed', '已授权标签页已关闭。', '重新打开网页。');
    }
    if (!canControlPage(tab, windowId)) {
      throw browserError('page-out-of-scope', '当前标签页不在网页控制范围内。', '选择当前未分组网页或 Mova Agent 分组网页。');
    }
    let authorization = session.target;
    if (!authorization && session.preset === 'full' && ['snapshot', 'read', 'visual_screenshot'].includes(command.operation) &&
        canControlPage(tab, windowId)) {
      authorization = await autoBindWithConsent(tab.id, windowId, session, signal);
      session.target = authorization;
      applyTabAccess(authorization);
    }
    const current = await activeTab();
    if (!authorization || target !== authorization) throw browserError('page-unauthorized', '当前轮没有网页授权。', '授权当前网页。');
    if (current?.id !== authorization.tabId || current.url !== authorization.url) {
      if (!await chrome.tabs.get(authorization.tabId).catch(() => null)) throw browserError('page-closed', '已授权标签页已关闭。', '重新打开网页。');
      throw browserError('document-changed', '当前网页或网址已切换。', '重新选择并授权目标网页。');
    }
    if (!canControlPage(current, windowId)) throw new Error('当前标签页已超出网页控制范围。');
    return authorization;
  };
  const run = async () => {
    const authorization = await verify();
    const execution = await runPage(authorization.tabId, command.operation, command.input || {}, authorization.documentId);
    if (execution.result.origin !== authorization.origin) throw new Error('网页来源已变化');
    // documentId 只用于桥接层的观察去重（同一文档 + 页面版本才允许复用观察结果）。
    const value = { ...execution.result, documentId: execution.documentId };
    return command.operation === 'preview'
      ? { ...value, fixture: Boolean(session.testPage) } : value;
  };
  try {
    signal.throwIfAborted();
    let value;
    if (command.operation === 'test_page_open') {
      if (session.testPage) throw new Error('An isolated test page is already open for this turn.');
      const win = await chrome.windows.create({ url: testPageUrl, type: 'popup', width: 760, height: 620 });
      const previous = session.target;
      session.testPage = { windowId: win.id, previous };
      try {
        const deadline = Date.now() + 4000;
        for (;;) {
          signal.throwIfAborted();
          const [tab] = await chrome.tabs.query({ windowId: win.id, active: true });
          if (tab?.url === testPageUrl && tab.status === 'complete') {
            session.target = await bindTab(tab, signal);
            session.testPage.tabId = tab.id;
            value = { opened: true, isolated: true, tabId: tab.id };
            break;
          }
          if (Date.now() >= deadline) throw new Error('The local test page did not finish loading.');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        await closeTestPage(session);
        throw error;
      }
    } else if (command.operation === 'test_page_close') {
      value = { closed: await closeTestPage(session) };
    } else if (session.testPage && ['open_tab', 'select_group_tab', 'request_tab_access', 'close_tab', 'handoff'].includes(command.operation)) {
      throw new Error('Close the isolated test page before switching or handing off browser tabs.');
    } else if (command.operation === 'open_tab') {
      value = await openAgentTab(command.input?.url, windowId, signal);
      session.target = undefined;
      if (session.preset === 'full') {
        try {
          session.target = await autoBindWithConsent(value.tabId, windowId, session, signal);
          applyTabAccess(session.target);
          value.requiresAuthorization = false;
        } catch (error) {
          value.authorizationMessage = error.message;
          pageStatus.textContent = error.message;
        }
      }
    } else if (command.operation === 'group_tabs') {
      const tabs = agentGroupId === undefined ? [] : await chrome.tabs.query({ windowId, groupId: agentGroupId });
      value = tabs.filter(tab => agentTabIds.has(tab.id)).map(tab => ({
        id: tab.id, active: tab.active, title: tab.title, authorized: authorizedTabs.get(tab.id)?.url === tab.url && authorizedTabs.has(tab.id),
      }));
    } else if (command.operation === 'select_group_tab') {
      const tab = await getAgentTab(command.input.tabId, windowId);
      signal.throwIfAborted();
      await chrome.tabs.update(tab.id, { active: true });
      let authorization = authorizedTabs.get(tab.id);
      let authorizationMessage;
      if (authorization && authorization.url === tab.url) {
        try {
          await runPage(tab.id, 'bind', {}, authorization.documentId);
        } catch {
          authorizedTabs.delete(tab.id);
          authorization = undefined;
        }
      }
      if ((!authorization || authorization.url !== tab.url) && session.preset === 'full') {
        try {
          authorization = await autoBind(tab.id, windowId, signal);
        } catch (error) {
          signal.throwIfAborted();
          authorization = undefined;
          authorizationMessage = error.message;
        }
      }
      session.target = session.preset === 'full' || authorization?.url === tab.url ? authorization : undefined;
      if (session.target) applyTabAccess(session.target);
      else {
        target = undefined;
        pageToggle.setAttribute('aria-pressed', 'false');
        pageStatus.textContent = authorizationMessage || '标签页已选中，尚未授权网页控制。';
      }
      value = { tabId: tab.id, selected: true, authorized: Boolean(session.target), authorizationMessage };
    } else if (command.operation === 'request_tab_access') {
      const tabId = command.input.tabId ?? (await activeTab())?.id;
      const tab = await getPageTab(tabId, windowId);
      signal.throwIfAborted();
      await chrome.tabs.update(tab.id, { active: true });
      const authorization = authorizedTabs.get(tab.id);
      let valid = false;
      if (authorization && authorization.url === tab.url) {
        valid = await runPage(tab.id, 'bind', {}, authorization.documentId).then(() => true, () => false);
      }
      if (!valid) {
        authorizedTabs.delete(tab.id);
        target = session.target = undefined;
        pageToggle.setAttribute('aria-pressed', 'false');
      }
      session.target = valid ? authorization : session.preset === 'full'
        ? await autoBindWithConsent(tab.id, windowId, session, signal) : await waitForTabAccess(tab.id, signal);
      applyTabAccess(session.target);
      value = { tabId: tab.id, authorized: true };
    } else if (command.operation === 'close_tab') {
      const tab = await getAgentTab(command.input.tabId, windowId);
      signal.throwIfAborted();
      await chrome.tabs.remove(tab.id);
      if (session.target?.tabId === tab.id) session.target = undefined;
      if (target?.tabId === tab.id) {
        target = undefined;
        pageToggle.setAttribute('aria-pressed', 'false');
        pageStatus.textContent = '';
      }
      value = { tabId: tab.id, closed: true };
    } else if (command.operation === 'handoff') {
      const tabId = command.input.tabId ?? (await activeTab())?.id;
      const tab = await getPageTab(tabId, windowId);
      signal.throwIfAborted();
      await chrome.tabs.update(tab.id, { active: true });
      target = undefined;
      authorizedTabs.delete(tab.id);
      session.target = undefined;
      pageToggle.setAttribute('aria-pressed', 'false');
      pageStatus.textContent = '已交给你操作。完成后可重新授权网页。';
      value = { status: 'human', tabId: tab.id };
    } else if (['visual_screenshot', 'visual_preview', 'visual_pointer'].includes(command.operation)) {
      value = await executeVisual(command.operation, command.input || {}, session, verify, signal);
    } else {
      value = await run();
    }
    if (command.operation === 'wait') {
      // 条件等待：每 120 ms 复查一次条件；比固定 sleep 更早返回。
      const end = Date.now() + Math.min(30_000, Number(command.input.timeout) || 8000);
      while (!value.matched && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 120));
        value = await run();
      }
      if (!value.matched) throw browserError('wait-timeout', '等待页面条件超时。', '读取当前快照并检查等待条件。');
    }
    await rpc('browser:result', command.id, { ok: true, value });
  } catch (error) {
    await rpc('browser:result', command.id, {
      ok: false, error: error.message, code: error.code, suggestion: error.suggestion, detail: error.detail,
    });
  }
}

const activeRuns = new Map();
async function closeTestPage(session) {
  const test = session.testPage;
  if (!test) return false;
  session.testPage = undefined;
  session.target = test.previous;
  session.visual = undefined;
  await chrome.windows.remove(test.windowId).catch(() => {});
  return true;
}
const visualTabs = new Set();
function flagVisuals(matches, invalidate = false) {
  for (const { session } of activeRuns.values()) {
    if (session.visual && matches(session.visual.authorization)) {
      if (invalidate) session.visual.invalid = true;
      pageStatus.textContent = invalidate ? '网页缩放已变化，需重新截图。' : '窗口尺寸已变化，鼠标操作前会重新核对视口。';
    }
  }
}
chrome.tabs.onZoomChange?.addListener(({ tabId }) => flagVisuals(auth => auth.tabId === tabId, true));
chrome.windows.onBoundsChanged?.addListener(win => flagVisuals(auth => auth.windowId === win.id));

function stalePointer(session, authorization, input) {
  const previous = session.pointerStaleness;
  const nearby = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= 0.08;
  const sameTarget = previous?.authorization.tabId === authorization.tabId &&
    previous.authorization.documentId === authorization.documentId && previous.input.action === input.action &&
    ['x', 'y', 'endX', 'endY'].every(key => nearby(previous.input[key], input[key]));
  const count = sameTarget ? previous.count + 1 : 1;
  session.pointerStaleness = { authorization, input, count };
  session.visual = undefined;
  if (count >= 2) {
    return browserError('pointer-unavailable', '坐标路径在此环境不可用，请改用元素引用。', '调用 browser_snapshot，再使用 browser_act 操作目标引用。');
  }
  return browserError('viewport-stale', '视口尺寸、缩放、滚动位置或截图已变化。', '需重新截图，再定位坐标。');
}

async function executeVisual(operation, input, session, verify, signal) {
  const authorization = await verify();
  const debuggee = { tabId: authorization.tabId };
  if (visualTabs.has(debuggee.tabId)) throw new Error('A visual operation is already running on this tab.');
  visualTabs.add(debuggee.tabId);
  let attached = false;
  const send = (method, params) => chrome.debugger.sendCommand(debuggee, method, params);
  const check = async () => {
    signal.throwIfAborted();
    if (await verify() !== authorization) throw new Error('The authorized tab changed.');
    const execution = await runPage(authorization.tabId, 'bind', {}, authorization.documentId);
    if (execution.result.origin !== authorization.origin) throw new Error('The page navigated.');
  };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await check();
    const viewport = await getPointerViewport(send);
    if (operation === 'visual_screenshot') {
      const shot = await send('Page.captureScreenshot', {
        format: 'jpeg', quality: 75, fromSurface: true, captureBeyondViewport: false,
        clip: { x: viewport.pageX ?? 0, y: viewport.pageY ?? 0, width: viewport.width, height: viewport.height, scale: 1 },
      });
      await check();
      if (!shot?.data || shot.data.length > 12_000_000) throw new Error('Screenshot is empty or too large.');
      const viewId = crypto.randomUUID();
      session.visual = { viewId, authorization, viewport };
      return { viewId, viewport, data: shot.data, mimeType: 'image/jpeg' };
    }
    const view = session.visual;
    if (!view || view.viewId !== input.viewId || view.authorization !== authorization || view.invalid ||
        !compatiblePointerViewport(view.viewport, viewport)) {
      throw stalePointer(session, authorization, input);
    }
    const { from, to } = pointerPoints(input, view.viewport);
    if ([from, to].some(point => point.x >= viewport.width || point.y >= viewport.height)) {
      throw stalePointer(session, authorization, input);
    }
    const points = input.action === 'drag' ? [from, to] : [from];
    const { result: preview } = await runPage(authorization.tabId, 'pointer_preview', { points }, authorization.documentId);
    if (operation === 'visual_preview') return {
      origin: authorization.origin, labels: preview.labels, blocked: preview.blocked, blockedCode: preview.blockedCode, ref: preview.ref,
    };
    if (preview.blocked || JSON.stringify(input.labels) !== JSON.stringify(preview.labels)) throw new Error('The pointer target changed or requires manual control.');
    session.visual = undefined;
    const result = await dispatchPointer(send, input, view.viewport, check);
    session.pointerStaleness = undefined;
    return result;
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
    visualTabs.delete(debuggee.tabId);
  }
}
async function autoBindActivePage(windowId, signal) {
  await restoreGroup(windowId);
  const tab = await activeTab();
  if (!canControlPage(tab, windowId) || !/^https?:\/\//.test(tab.url || tab.pendingUrl || '')) return undefined;
  if (target?.tabId === tab.id && target.url === tab.url) {
    try {
      await runPage(tab.id, 'bind', {}, target.documentId);
      return target;
    } catch { /* The active page needs a fresh binding. */ }
  }
  return autoBind(tab.id, windowId, signal ?? new AbortController().signal);
}

async function enableAutomaticAccess(conversationId, expectedRequest) {
  // Must start in the original button gesture so Edge can show its permission prompt.
  const granted = await chrome.permissions.request({ origins: webOrigins });
  if (expectedRequest && pendingTabAccess !== expectedRequest) return;
  const waiting = pendingTabAccess;
  const fullRunWaiting = waiting && [...activeRuns.values()].some(run =>
    run.controller.signal === waiting.signal && run.session.preset === 'full');
  if (!granted) {
    const message = 'Edge 未授予自动网页访问。可从地球菜单再次启用。';
    if (fullRunWaiting) waiting.finish(new Error(message));
    pageStatus.textContent = message;
    return;
  }
  try {
    const { id: windowId } = await chrome.windows.getCurrent();
    if (fullRunWaiting) {
      const authorization = await autoBind(waiting.tabId, windowId, waiting.signal);
      if (pendingTabAccess === waiting) waiting.finish(null, authorization);
      return;
    }
    const authorization = await autoBindActivePage(windowId);
    if (!authorization) {
      pageStatus.textContent = '自动网页控制已启用，打开可操作的网页后会自动接入。';
      return;
    }
    applyTabAccess(authorization);
    for (const run of activeRuns.values()) {
      if (run.conversationId === conversationId && run.session.preset === 'full' && !run.session.target) {
        run.session.target = authorization;
      }
    }
  } catch (error) {
    if (fullRunWaiting && pendingTabAccess === waiting) waiting.finish(error);
    pageStatus.textContent = error.message;
  }
}

async function setConversationPreset(conversationId, value) {
  const access = value === 'full' ? enableAutomaticAccess(conversationId).catch(error => {
    pageStatus.textContent = error.message;
  }) : null;
  const updates = [];
  for (const [id, run] of activeRuns) {
    if (run.conversationId !== conversationId) continue;
    run.session.preset = value;
    if (!run.started) continue;
    updates.push(rpc('model:permission-preset', id, value).then(result => {
      if (!result.ok && activeRuns.has(id)) pageStatus.textContent = '本轮权限同步失败，下次发送会使用新档位。';
    }));
  }
  await Promise.all([...updates, access]);
}

document.querySelector('#edge-auto-access').addEventListener('click', () => {
  void enableAutomaticAccess().catch(error => { pageStatus.textContent = error.message; });
  pageMenu.hidePopover();
});
accessConfirm.addEventListener('click', async () => {
  const waiting = pendingTabAccess;
  accessConfirm.disabled = true;
  try {
    await enableAutomaticAccess(undefined, waiting);
  } catch (error) {
    if (waiting?.automatic && pendingTabAccess === waiting) waiting.finish(error);
    pageStatus.textContent = error.message;
  } finally {
    accessConfirm.disabled = false;
  }
});
function declineAutomaticAccess() {
  if (pendingTabAccess?.automatic) pendingTabAccess.finish(new Error('用户未允许 Edge 自动网页访问。'));
}
document.querySelector('#edge-access-cancel').addEventListener('click', declineAutomaticAccess);
accessDialog.addEventListener('cancel', event => {
  event.preventDefault();
  declineAutomaticAccess();
});

async function complete(id, request) {
  const controller = new AbortController();
  const session = { target, preset: request.permissionPreset ?? preset };
  const run = { controller, session, conversationId: request.conversationId, started: false };
  activeRuns.set(id, run);
  try {
    const { id: windowId } = await chrome.windows.getCurrent();
    await restoreGroup(windowId);
    if (session.preset === 'full') {
      try {
        const authorization = await autoBindActivePage(windowId, controller.signal);
        if (authorization && session.preset === 'full') {
          session.target = authorization;
          applyTabAccess(authorization);
        }
      } catch (error) {
        controller.signal.throwIfAborted();
        pageStatus.textContent = error.message;
      }
    }
    controller.signal.throwIfAborted();
    run.started = true;
    const response = await fetchRpc('model:complete', [
      id, { ...request, permissionPreset: session.preset }, session.target && { origin: session.target.origin }, preset,
    ]);
    if (!response.ok) {
      if (response.status === 401 && !pairing.open) pairing.showModal();
      return await response.json();
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let result;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'browser:command') void execute(event.value, session, windowId, controller.signal);
        else if (event.type === 'result') result = event.value;
        else emit(event.type === 'model:delta' ? id : event.type, event.value);
      }
    }
    return result ?? { ok: false, error: 'interrupted' };
  } catch {
    return { ok: false, error: 'network' };
  } finally {
    controller.abort();
    await closeTestPage(session);
    activeRuns.delete(id);
  }
}

document.querySelector('#edge-repair').addEventListener('click', () => {
  pageMenu.hidePopover();
  pairCode.value = '';
  pairStatus.textContent = '';
  if (!pairing.open) pairing.showModal();
  pairCode.focus();
});
document.querySelector('#edge-pair-cancel').addEventListener('click', () => pairing.close());
document.querySelector('#edge-pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await rpc('pair', pairCode.value.trim());
  if (!result.ok) {
    pairStatus.textContent = result.error === 'invalid-pairing-code' ? '配对码无效或过期，请在桌面端重新生成。' : result.error;
    return;
  }
  token = result.value;
  localStorage.setItem('mova.edge.token', token);
  location.reload();
});
if (!token) pairing.showModal();

window.movaDesktop = {
  isEdge: true,
  providers: { list: () => rpc('providers:list'), setActive: value => rpc('providers:active', value) },
  model: {
    complete,
    cancel: id => {
      activeRuns.get(id)?.controller.abort();
      return rpc('model:cancel', id);
    },
    onDelta: subscribe,
  },
  memory: {
    read: async () => {
      const result = await rpc('memory:settings');
      return result.ok ? { ok: true, value: { settings: result.value } } : result;
    },
    syncSessions: revision => rpc('sessions:read', revision),
    saveSessions: (snapshot, revision) => rpc('sessions:save', snapshot, revision),
    ingest: value => rpc('memory:ingest', value),
  },
  approvals: {
    onRequest: callback => subscribe('approval:request', callback),
    onClose: callback => subscribe('approval:close', callback),
    respond: (id, decision) => rpc('approval:respond', id, decision),
  },
  permissions: {
    list: async () => ({ ok: true, value: { roots: [] } }),
    setConversationPreset,
    getPreset: async () => ({ ok: true, value: { preset } }),
    setPreset: async value => {
      preset = ['auto', 'full'].includes(value) ? value : 'default';
      localStorage.setItem('mova.edge.preset', preset);
      return { ok: true, value: { preset } };
    },
  },
};
// Import after the transport and layout are ready so app.js can use them at startup.
await import('./app.js');
