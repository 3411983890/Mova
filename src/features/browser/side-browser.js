import './side-browser.css';
import { icon, replaceStaticIcons } from '../../shared/icons.js';
import {
  DIR, FILE, WEB, createLocationHistory, directoryOf, entryIcon, joinPath, labelOf,
  normalizeLocation, normalizePath, normalizeUrl, rootNameOf, splitAnchor, truncateText,
} from './location.js';
import { mountAddress } from './address.js';
import { mountViewer } from './viewer/viewer.js';
import { mountQuotePopover } from './quote.js';
import { mountWebInspect } from './web-inspect.js';
import { createScopedViewState } from './scoped-view-state.js';

// 供 quote.js / web-inspect.js 直接 import 当前活动位置（不经过返回值，避免循环依赖）。
let moduleLocation = null;
export function activeLocation() {
  return moduleLocation;
}

export function mountSideBrowser({ roots, collapseSidebar, expandSidebar }) {
  const frame = document.querySelector('.content-frame');
  const toggles = [
    document.querySelector('#browser-toggle'),
    document.querySelector('#chat-browser-toggle'),
  ].filter(Boolean);
  const panel = document.createElement('aside');
  panel.className = 'browser-panel'; panel.hidden = true;
  panel.innerHTML = `<div class="browser-resizer" role="separator" tabindex="0" aria-label="调整浏览器宽度"></div>
    <header class="browser-toolbar"><div class="browser-nav-group"><button class="browser-icon-button" data-back title="后退" aria-label="后退"><i class="ph ph-arrow-left"></i></button><button class="browser-icon-button" data-forward title="前进" aria-label="前进"><i class="ph ph-arrow-right"></i></button><button class="browser-icon-button" data-reload title="刷新" aria-label="刷新"><i class="ph ph-arrow-clockwise"></i></button></div>
    <form class="browser-address"><i class="ph ph-globe browser-address-icon" aria-hidden="true"></i><input class="browser-url" aria-label="网址或文件位置" placeholder="网址或文件位置"><button type="button" class="browser-icon-button" data-share title="打开当前位置" aria-label="打开当前位置"><i class="ph ph-arrow-up-right"></i></button></form>
    <button class="browser-icon-button" data-inspect title="选择页面元素" aria-label="选择页面元素" aria-pressed="false" disabled><i class="ph ph-cursor-click"></i></button><button class="browser-icon-button browser-menu-trigger" data-menu title="标签页" aria-label="标签页" aria-haspopup="menu" aria-expanded="false"><i class="ph ph-dots-three"></i></button><div class="browser-menu" role="menu" aria-label="标签页" hidden></div></header>
    <div class="browser-tabs"><div class="browser-spaces"><select class="browser-space-select" aria-label="工作区"></select><button class="browser-space-new" type="button" title="新建工作区" aria-label="新建工作区">+</button><button class="browser-space-isolated" type="button" title="新建隔离工作区（独立登录）" aria-label="新建隔离工作区">⧉</button><button class="browser-space-rename" type="button" title="重命名工作区" aria-label="重命名工作区">✎</button></div><div class="browser-tab-list" role="tablist" aria-label="浏览器标签页"></div><button class="browser-tab-new" type="button" title="新建标签页" aria-label="新建标签页">+</button></div>
    <div class="browser-stage"><div class="browser-start">输入网址，或点击对话中引用的文件</div><div class="browser-viewport" hidden><webview class="browser-frame browser-webview" partition="persist:mova-browser" allowpopups style="display:none"></webview><iframe class="browser-frame browser-file-frame" title="文件预览" sandbox="allow-same-origin" referrerpolicy="no-referrer" hidden></iframe><pre class="browser-text" hidden></pre></div><p class="browser-error" hidden></p><div class="browser-inspect-hint" role="status" aria-live="polite" hidden><span class="browser-inspect-hint-text"></span><button type="button" class="browser-inspect-hint-exit" hidden>退出</button></div></div>
    <div class="browser-login" hidden><form class="browser-login-card">
      <div class="browser-login-head"><strong>登录</strong><span class="browser-login-origin"></span></div>
      <label>用户名<input class="browser-login-user" autocomplete="username" spellcheck="false"></label>
      <label>密码<input class="browser-login-password" type="password" autocomplete="current-password"></label>
      <div class="browser-login-unlock" hidden><label>保险柜口令<input type="password" class="browser-login-passphrase" autocomplete="current-password"></label><button type="button" class="browser-login-unlock-button">解锁</button></div>
      <p class="browser-login-hint" hidden></p>
      <div class="browser-login-actions"><button type="button" class="browser-login-cancel">取消</button><button type="submit" class="browser-login-submit">填充并登录</button></div>
    </form></div>
    <div class="browser-cookie-login" hidden><div class="browser-cookie-card">
      <strong>发现该站点的登录记录</strong>
      <p class="browser-cookie-origin"></p>
      <p>可以直接用保存的 Cookie 登录，也可以重新输入密码。</p>
      <div class="browser-cookie-actions"><button type="button" data-cookie-use>用 Cookie 登录</button><button type="button" data-cookie-relogin>重新登录</button></div>
    </div></div>
    <div class="browser-takeover" hidden role="status" aria-live="polite"><div class="browser-takeover-copy"><strong>Agent 已暂停</strong><span class="browser-takeover-note"></span></div><div class="browser-takeover-actions"><button type="button" data-takeover-resume>我已处理，继续</button><button type="button" data-takeover-cancel>结束任务</button></div></div>`;
  frame.append(panel);
  // 面板是运行时插入的，静态图标替换不会自动覆盖它。
  replaceStaticIcons(panel);
  const input = panel.querySelector('.browser-url');
  const viewport = panel.querySelector('.browser-viewport');
  const iframe = panel.querySelector('iframe');
  const tabList = panel.querySelector('.browser-tab-list');
  const tabNew = panel.querySelector('.browser-tab-new');
  const spaceSelect = panel.querySelector('.browser-space-select');
  const spaceNew = panel.querySelector('.browser-space-new');
  const spaceIsolated = panel.querySelector('.browser-space-isolated');
  const spaceRename = panel.querySelector('.browser-space-rename');
  let webview = panel.querySelector('webview');
  const text = panel.querySelector('.browser-text');
  const menu = panel.querySelector('.browser-menu');
  const error = panel.querySelector('.browser-error');
  const login = panel.querySelector('.browser-login');
  const loginForm = login.querySelector('form');
  const loginOrigin = login.querySelector('.browser-login-origin');
  const loginUser = login.querySelector('.browser-login-user');
  const loginPassword = login.querySelector('.browser-login-password');
  const loginUnlock = login.querySelector('.browser-login-unlock');
  const loginPassphrase = login.querySelector('.browser-login-passphrase');
  const loginHint = login.querySelector('.browser-login-hint');
  const loginSubmit = login.querySelector('.browser-login-submit');
  const cookieLogin = panel.querySelector('.browser-cookie-login');
  const cookieOrigin = panel.querySelector('.browser-cookie-origin');
  let cookieOriginValue = '';
  const credentialBridge = window.movaDesktop?.browser?.credentials;
  const takeover = panel.querySelector('.browser-takeover');
  const takeoverNote = panel.querySelector('.browser-takeover-note');
  let takeoverId = null;
  const inspectButton = panel.querySelector('[data-inspect]');
  const tabs = [];
  function loadSpaceNames() {
    try {
      const saved = JSON.parse(localStorage.getItem('mova.browser.spaces') || '[]');
      return Array.isArray(saved)
        ? saved.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string').slice(0, 8)
        : [];
    } catch { return []; }
  }
  const savedSpaces = loadSpaceNames();
  const spaces = savedSpaces.length
    ? savedSpaces.map(item => ({
      id: item.id,
      name: item.name.slice(0, 40),
      activeTabId: null,
      isolated: item.isolated === true,
      partition: item.isolated === true ? `persist:mova-space-${item.id}` : 'persist:mova-browser',
    }))
    : [{ id: 'default', name: 'Space 1', activeTabId: null, isolated: false, partition: 'persist:mova-browser' }];
  let activeSpaceId = spaces[0].id;
  let spaceSeq = spaces.length;
  function saveSpaces() {
    try {
      localStorage.setItem('mova.browser.spaces', JSON.stringify(spaces.map(({ id, name, isolated }) => ({ id, name, isolated }))));
    } catch { /* storage may be unavailable */ }
  }
  let activeTab = null;
  let tabSeq = 0;
  const visited = [];
  let blob = null;
  const stage = panel.querySelector('.browser-stage');
  /** Which surface the stage shows: the web page, the file viewer, or the design canvas. */
  let view = 'web';
  let lastLocationView = 'web';
  const filesBridge = window.movaDesktop?.files?.view || null;
  let address = null;
  let viewer = null;
  let menuRequestId = 0;
  function tabLocation(tab = activeTab) {
    return tab?.history?.current() || null;
  }
  function setModuleLocation(loc) {
    moduleLocation = loc || null;
  }
  viewer = mountViewer({
    container: stage,
    files: filesBridge,
    roots,
    onNavigate: (loc, options = {}) => {
      if (options?.replace === true) { void replaceLocation(loc); return; }
      void navigate(loc);
    },
    onDirectoryInfo: (loc, info) => {
      const current = tabLocation();
      if (!info || !current || current.kind !== DIR) return;
      if (current.rootId !== loc.rootId || current.path !== loc.path) return;
      address?.setEntryCount(info.total);
    },
  });
  // The design canvas joins the stage as one more surface, so the browser, the file
  // viewer and the canvas share the panel, its toolbar and its address pill.
  const canvasSlot = document.createElement('div');
  canvasSlot.className = 'browser-canvas';
  canvasSlot.hidden = true;
  stage.append(canvasSlot);
  address = mountAddress({    form: panel.querySelector('.browser-address'),
    input: panel.querySelector('.browser-url'),
    icon: panel.querySelector('.browser-address-icon'),
    onNavigate: loc => { void navigate(loc); },
    onSubmit: value => { void submitAddress(value); },
  });
  const tabBridge = window.movaDesktop?.browser;
  let browserPrefs = null;
  let restoringTabs = false;
  let restoredTabs = false;
  function saveTabState() {
    if (restoringTabs) return;
    try {
      const saved = tabs.filter(tab => tab.url).map(tab => ({ spaceId: tab.spaceId, url: tab.url }));
      localStorage.setItem('mova.browser.tabs', JSON.stringify(saved));
    } catch { /* storage unavailable */ }
  }
  function restoreSavedTabs() {
    if (restoredTabs || browserPrefs?.basics?.restoreTabs !== true) return;
    restoredTabs = true;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('mova.browser.tabs') || '[]'); } catch { saved = []; }
    if (!Array.isArray(saved) || !saved.length) return;
    restoringTabs = true;
    saved.slice(0, 8).forEach((item, index) => {
      if (item && typeof item.url === 'string' && /^https?:/i.test(item.url)) {
        makeTab(item.url, item.spaceId || activeSpaceId, { background: index > 0 });
      }
    });
    restoringTabs = false;
    saveTabState();
  }
  window.movaDesktop?.browser?.settings?.get?.().then(result => {
    if (!result?.ok) return;
    browserPrefs = result.value;
    if (browserPrefs?.basics?.rememberWidth === false) {
      try { localStorage.removeItem('mova.browser.width'); } catch { /* ignore */ }
      setBrowserWidth(frame.getBoundingClientRect().width * 0.42);
    }
    restoreSavedTabs();
  }).catch(() => {});
  const newTabUrl = () => browserPrefs?.basics?.newTabUrl || 'https://www.google.com';

  function tabLabel(tab) {
    const loc = tab?.history?.current?.();
    if (!tab?.title && loc && loc.kind !== WEB) return labelOf(loc, { roots: roots() });
    return tab?.title || tab?.url || '新标签页';
  }
  function ensureSpace(id, options = {}) {
    let space = spaces.find(item => item.id === id);
    if (!space) {
      const isolated = options.isolated === true;
      space = {
        id,
        name: `Space ${++spaceSeq}${isolated ? '（隔离）' : ''}`,
        activeTabId: null,
        isolated,
        partition: isolated ? `persist:mova-space-${id}` : 'persist:mova-browser',
      };
      spaces.push(space);
      saveSpaces();
    }
    return space;
  }
  function renderSpaces() {
    spaceSelect.replaceChildren(...spaces.map(space => {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      return option;
    }));
    spaceSelect.value = activeSpaceId;
  }
  function renderTabs() {
    renderSpaces();
    tabList.replaceChildren();
    for (const tab of tabs.filter(item => item.spaceId === activeSpaceId)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'browser-tab';
      button.dataset.tabId = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === activeTab));
      const title = document.createElement('span');
      title.className = 'browser-tab-title';
      title.textContent = tabLabel(tab);
      const close = document.createElement('span');
      close.className = 'browser-tab-close';
      close.dataset.tabClose = tab.id;
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', `关闭 ${tabLabel(tab)}`);
      close.textContent = '×';
      button.append(title, close);
      tabList.append(button);
    }
  }
  function clearActive() {
    if (activeTab) activeTab.el.style.display = 'none';
    // Keep the webview's internal display:flex contract; see .browser-webview.
    activeTab = null;
    webview = null;
    stopInspect();
    quote.hide();
    viewer.hide();
    clear();
    viewport.hidden = false;
    syncToolbar(null);
    renderTabs();
    panel.querySelector('.browser-start').hidden = false;
    try { tabBridge?.tabCleared?.(activeSpaceId); } catch { /* bridge may be absent */ }
  }
  function activateTab(tab) {
    if (!tab || !tabs.includes(tab)) return;
    if (activeTab && activeTab !== tab) activeTab.el.style.display = 'none';
    activeTab = tab;
    activeSpaceId = tab.spaceId;
    ensureSpace(activeSpaceId).activeTabId = tab.id;
    webview = tab.el;
    tab.el.style.display = 'flex';
    iframe.hidden = true;
    text.hidden = true;
    const loc = tab.history.current();
    panel.querySelector('.browser-start').hidden = Boolean(loc);
    renderLocation(loc);
    if (!loc) panel.querySelector('.browser-start').hidden = false;
    renderTabs();
    try { tabBridge?.tabActive?.(tab.id, tab.spaceId); } catch { /* bridge may be absent in preview */ }
  }
  function switchSpace(id) {
    const space = ensureSpace(id);
    activeSpaceId = space.id;
    const tab = tabs.find(item => item.id === space.activeTabId) || tabs.find(item => item.spaceId === id);
    if (tab) { activateTab(tab); return; }
    clearActive();
  }
  function makeTab(url, spaceId = activeSpaceId, options = {}) {
    const space = ensureSpace(spaceId);
    const background = options.background === true;
    let el;
    if (tabs.length === 0 && webview && !webview.dataset.tab && space.partition === 'persist:mova-browser') {
      el = webview;
    } else {
      el = document.createElement('webview');
      el.className = 'browser-frame browser-webview';
      el.setAttribute('partition', space.partition);
      el.setAttribute('allowpopups', '');
      el.style.display = 'none';
      viewport.append(el);
    }
    el.dataset.tab = '1';
    const tab = { id: `tab-${++tabSeq}`, el, history: createLocationHistory(), title: '', url: '', spaceId: space.id };
    const setUrl = (event, push) => {
      // 只认能出现在地址栏里的两种 scheme：http(s) 与本地预览用的 file:。
      // 其它（about:blank、chrome-error:、devtools: …）是 webview 自己的中间态，不该写进历史栈。
      if (!/^(?:https?|file):\/\//i.test(event.url)) return;
      const activeLoc = tab === activeTab ? tab.history.current() : null;
      if (activeLoc && activeLoc.kind !== WEB) {
        // 文件/目录位置时，隐藏的 webview 后台跳转不能污染位置栈。
        tab.url = event.url;
        renderTabs();
        saveTabState();
        return;
      }
      const current = tab.history.current();
      if (current?.kind === WEB && current.url === event.url) return;
      const previous = tab.history.index > 0 ? tab.history.list()[tab.history.index - 1] : null;
      if (previous?.kind === WEB && previous.url === event.url) tab.history.back();
      else if (push) tab.history.push({ kind: WEB, url: event.url });
      else tab.history.replace({ kind: WEB, url: event.url });
      tab.url = event.url;
      if (tab === activeTab) {
        syncToolbar(tab.history.current());
        setTimeout(() => { void promptLoginFor(tab); }, 900);
      }
      renderTabs();
      saveTabState();
    };
    el.addEventListener('did-navigate', event => setUrl(event, true));
    el.addEventListener('did-navigate-in-page', event => setUrl(event, true));
    el.addEventListener('page-title-updated', event => { tab.title = event.title || ''; renderTabs(); });
    el.addEventListener('dom-ready', () => {
      // Hide the guest's own scrollbars; the page still scrolls by wheel/touch.
      try {
        const css = el.insertCSS('html,body{scrollbar-width:none!important}::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}');
        if (css?.catch) css.catch(() => {});
      } catch { /* older webview */ }
      try { tabBridge?.tabReady?.(tab.id, el.getWebContentsId(), space.id); } catch { /* guest not ready */ }
      // 新文档的注入脚本已就绪：重新 arm，让网页选区引用生效（§4.5）。
      // 后台 arm 失败不弹红条：用户只是打开了网址，没有发起任何选择动作；
      // 真正的失败由点击「选择页面元素」时的 onError 提示。
      if (tab === activeTab) {
        armedTabId = '';
        armInspect({ report: false });
      }
      setTimeout(() => { void promptLoginFor(tab); }, 700);
    });
    tabs.push(tab);
    if (background) {
      tab.el.style.display = 'none';
      if (url) {
        tab.url = url;
        tab.history.push({ kind: WEB, url });
        tab.el.src = url;
      }
      renderTabs();
    } else {
      if (activeSpaceId !== space.id) activeSpaceId = space.id;
      activateTab(tab);
      if (url) void navigate({ kind: WEB, url });
    }
    saveTabState();
    return tab;
  }
  function closeTab(tab) {
    const position = tabs.indexOf(tab);
    if (position < 0) return;
    const space = ensureSpace(tab.spaceId);
    tabs.splice(position, 1);
    try { tab.el.remove(); } catch { /* already gone */ }
    try { tabBridge?.tabClosed?.(tab.id); } catch { /* bridge may be absent */ }
    saveTabState();
    if (space.activeTabId === tab.id) space.activeTabId = null;
    if (activeTab !== tab) { renderTabs(); return; }
    const next = tabs.filter(item => item.spaceId === tab.spaceId)[0] || null;
    if (next) { activateTab(next); return; }
    clearActive();
  }
  tabNew.addEventListener('click', () => { makeTab(newTabUrl(), activeSpaceId); input.focus(); input.select?.(); });
  spaceSelect.addEventListener('change', () => switchSpace(spaceSelect.value));
  spaceNew.addEventListener('click', () => {
    const space = ensureSpace(`space-${++spaceSeq}`);
    switchSpace(space.id);
    makeTab(newTabUrl(), space.id);
  });
  spaceIsolated.addEventListener('click', () => {
    const space = ensureSpace(`isolated-${++spaceSeq}`, { isolated: true });
    switchSpace(space.id);
    makeTab(newTabUrl(), space.id);
  });
  spaceRename.addEventListener('click', () => {
    const space = spaces.find(item => item.id === activeSpaceId);
    if (!space) return;
    const name = window.prompt('工作区名称', space.name);
    if (!name || !name.trim()) return;
    space.name = name.trim().slice(0, 40);
    renderTabs();
    saveSpaces();
  });
  tabList.addEventListener('click', event => {
    const close = event.target.closest('[data-tab-close]');
    if (close) {
      const tab = tabs.find(item => item.id === close.dataset.tabClose);
      if (tab) closeTab(tab);
      return;
    }
    const button = event.target.closest('[data-tab-id]');
    if (button) {
      const tab = tabs.find(item => item.id === button.dataset.tabId);
      if (tab) activateTab(tab);
    }
  });

  function open(value) {
    const wasHidden = panel.hidden;
    panel.hidden = !value; frame.classList.toggle('browser-open', value);
    for (const toggle of toggles) toggle.setAttribute('aria-expanded', String(value));
    if (!value) {
      frame.classList.remove('chat-collapsed');
      // 面板关闭：结束网页选择、收起浮层（§3.11 退出条件）。
      stopInspect();
      quote.hide();
    }
    if (value && browserPrefs?.basics?.autoCollapseSidebar === true) {
      collapseSidebar?.();
    }
    if (value) {
      // Opening a third view must not squeeze the chat below its minimum.
      // Give the new view room by taking it from the secondary sidebar first.
      const sidebar = document.querySelector('.project-sidebar');
      const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;
      if (frame.clientWidth - sidebarWidth - MIN_CHAT < MIN_BROWSER &&
          !document.querySelector('.window-shell')?.classList.contains('sidebar-collapsed')) {
        collapseSidebar?.();
      }
      requestAnimationFrame(() => {
        const saved = Number(localStorage.getItem('mova.browser.width'));
        setBrowserWidth(Number.isFinite(saved) && saved > 0 ? saved : frame.clientWidth * 0.42);
        // 面板从 display:none 恢复时面包屑宽度才可测量，重新折叠一次。
        address?.fit();
      });
      // 从隐藏变可见且当前是网页：网页注入可能已随面板卸载，重新 arm。
      // 同 dom-ready：打开面板不是选择动作，失败不弹红条。
      if (wasHidden && view !== 'canvas') {
        armedTabId = '';
        armInspect({ report: false });
      }
    }
  }
  /* ---- 视图选择：面板关着时先问要开哪一个 ------------------------------------------------
     面板里三个视图（网页 / 画板 / 文件）共用一个舞台，地址栏只描述当前来源。所以「打开」
     不是单一动作，关着的时候先给一次选择；开着的时候同一个图标就是关闭。 */
  const VIEW_CHOICES = [
    { view: 'web', label: '内置浏览器', hint: '网页' },
    { view: 'canvas', label: '内置画板', hint: '设计画板' },
    { view: 'file', label: '资源管理器', hint: '文件与文件夹' },
  ];
  const viewChooser = document.createElement('div');
  viewChooser.className = 'view-chooser';
  viewChooser.setAttribute('role', 'menu');
  viewChooser.setAttribute('aria-label', '打开视图');
  viewChooser.hidden = true;
  viewChooser.innerHTML = VIEW_CHOICES.map(choice => `<button type="button" role="menuitem" class="view-chooser-item" data-view="${choice.view}"><span class="view-chooser-label">${choice.label}</span><span class="view-chooser-hint">${choice.hint}</span></button>`).join('');
  document.body.append(viewChooser);

  function hideViewChooser() { viewChooser.hidden = true; }

  function showViewChooser(anchor) {
    const rect = anchor.getBoundingClientRect();
    viewChooser.hidden = false;
    // 先摆上去再量宽度，才能右对齐到这个按钮并夹进视口。
    const width = viewChooser.getBoundingClientRect().width || 168;
    viewChooser.style.top = `${Math.round(rect.bottom + 6)}px`;
    viewChooser.style.left = `${Math.max(8, Math.round(Math.min(rect.right - width, window.innerWidth - width - 8)))}px`;
    viewChooser.querySelector('.view-chooser-item')?.focus();
  }

  viewChooser.addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) openView(button.dataset.view);
  });
  document.addEventListener('pointerdown', event => {
    if (viewChooser.hidden) return;
    if (viewChooser.contains(event.target) || toggles.some(toggle => toggle.contains(event.target))) return;
    hideViewChooser();
  }, true);
  window.addEventListener('keydown', event => { if (event.key === 'Escape') hideViewChooser(); });

  for (const toggle of toggles) toggle.addEventListener('click', () => {
    if (panel.hidden) { showViewChooser(toggle); return; }
    hideViewChooser();
    open(false);
  });

  let loginBusy = false;
  const loginPrompted = new Set();
  function setLoginHint(text) {
    loginHint.textContent = text || '';
    loginHint.hidden = !text;
  }
  function currentOrigin() {
    const loc = tabLocation();
    const raw = loc?.kind === WEB ? loc.url : currentUrlOf(webview);
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return { origin: `${url.protocol}//${url.host}`, href: url.href };
    } catch { return null; }
  }
  function hideLogin() {
    login.hidden = true;
    viewport.style.visibility = '';
    loginPassword.value = '';
    loginPassphrase.value = '';
    setLoginHint('');
    loginUnlock.hidden = true;
  }
  async function showLogin() {
    closeMenu();
    const target = currentOrigin();
    if (!target) { error.textContent = '请先打开一个网页'; error.hidden = false; return; }
    open(true);
    login.hidden = false;
    viewport.style.visibility = 'hidden';
    loginOrigin.textContent = target.origin;
    loginUser.value = '';
    loginPassword.value = '';
    loginPassphrase.value = '';
    loginUnlock.hidden = true;
    setLoginHint('');
    if (!credentialBridge) {
      setLoginHint('当前环境不支持记忆保险柜，只能一次性填充。');
      loginUser.focus();
      return;
    }
    try {
      const result = await credentialBridge.status();
      const status = result?.ok ? result.value : null;
      if (!status || status.ok === false) {
        setLoginHint(status?.message || '记忆保险柜不可用（需要服务模式），只能一次性填充。');
      } else if (status.configured === false) {
        setLoginHint('还没有创建记忆保险柜。可以一次性填充，或先到设置里创建保险柜。');
      } else if (status.unlocked === false) {
        loginUnlock.hidden = false;
        setLoginHint('保险柜已锁定，输入口令解锁后才能保存。');
      }
    } catch {
      setLoginHint('无法读取记忆保险柜，只能一次性填充。');
    }
    loginUser.focus();
  }

  function hideCookieLogin() {
    cookieLogin.hidden = true;
    cookieOriginValue = '';
    if (login.hidden) restoreWebSurface();
  }
  async function showCookieLogin(origin) {
    closeMenu();
    open(true);
    cookieOriginValue = origin;
    cookieOrigin.textContent = origin;
    login.hidden = true;
    cookieLogin.hidden = false;
    viewport.style.visibility = 'hidden';
  }
  panel.querySelector('[data-cookie-use]').addEventListener('click', async () => {
    if (!cookieOriginValue || !credentialBridge?.loginRecord) return;
    const result = await credentialBridge.loginRecord.use(cookieOriginValue);
    hideCookieLogin();
    if (result?.ok) {
      try { webview.reload?.(); } catch { /* guest may be gone */ }
    } else {
      error.textContent = result?.message || 'Cookie 登录失败';
      error.hidden = false;
    }
  });
  panel.querySelector('[data-cookie-relogin]').addEventListener('click', () => {
    const origin = cookieOriginValue;
    hideCookieLogin();
    if (origin) void showLogin();
  });

  function askCookieInChat(origin) {
    const host = document.getElementById('approval-host');
    if (!host) return Promise.resolve('deny');
    const bar = document.createElement('section');
    bar.className = 'approval-bar browser-cookie-approval';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Cookie 登录审批');
    bar.innerHTML = `<div class="approval-head"><span class="approval-badge is-cookie">Cookie 登录</span><strong>发现该站点的登录记录，是否用 Cookie 登录？</strong></div>
      <p class="approval-detail"></p>
      <div class="approval-actions"><button type="button" data-cookie-deny>拒绝</button><button type="button" class="settings-button primary" data-cookie-allow>允许一次</button></div>`;
    bar.querySelector('.approval-detail').textContent = `${origin} · 已保存 Cookie 与本地存储`;
    host.append(bar);
    return new Promise(resolve => {
      const finish = decision => { bar.remove(); resolve(decision); };
      bar.querySelector('[data-cookie-deny]').addEventListener('click', () => finish('deny'));
      bar.querySelector('[data-cookie-allow]').addEventListener('click', () => finish('once'));
    });
  }

  async function promptLoginFor(tab) {
    if (!tab || tab !== activeTab || !login.hidden || !cookieLogin.hidden) return;
    if (tab.history.current()?.kind !== WEB) return;
    const key = tab.url || tab.id;
    if (!key || loginPrompted.has(key)) return;
    try {
      const needsPassword = await tab.el.executeJavaScript(`(() => {
        const p = document.querySelector('input[type="password"]');
        return !!(p && p.offsetParent !== null && !p.disabled && !p.readOnly);
      })()`);
      const looksLogin = /(?:sign[_-]?in|log[_-]?in|passport|\/auth\/)/i.test(tab.url || '');
      if (!needsPassword && !looksLogin) return;
      const origin = currentOrigin()?.origin;
      if (!origin) return;
      if (credentialBridge?.loginRecord) {
        const record = await credentialBridge.loginRecord.has(origin);
        if (record?.ok && record.value?.has) {
          loginPrompted.add(key);
          const decision = await askCookieInChat(origin);
          if (decision === 'once') {
            const used = await credentialBridge.loginRecord.use(origin);
            if (used?.ok) { try { tab.el.reload?.(); } catch { /* guest gone */ } }
          } else if (decision === 'deny') {
            await showLogin();
          }
          return;
        }
      }
      if (!needsPassword) return;
      loginPrompted.add(key);
      await showLogin();
    } catch { /* navigation or guest gone */ }
  }

  login.querySelector('.browser-login-cancel').addEventListener('click', hideLogin);
  login.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hideLogin(); } });
  login.addEventListener('click', event => { if (event.target === login) hideLogin(); });
  login.querySelector('.browser-login-unlock-button').addEventListener('click', async () => {
    const passphrase = loginPassphrase.value;
    if (!passphrase) { setLoginHint('请输入保险柜口令'); return; }
    try {
      const result = await window.movaDesktop.memory.vault.unlock(passphrase);
      if (!result?.ok) { setLoginHint('口令不正确，或保险柜尚未创建'); return; }
      loginUnlock.hidden = true;
      loginPassphrase.value = '';
      setLoginHint('保险柜已解锁，请再次点击“填充并登录”。');
    } catch { setLoginHint('无法解锁保险柜'); }
  });
  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (loginBusy) return;
    const target = currentOrigin();
    if (!target) { setLoginHint('页面已经离开，请重新打开登录页'); return; }
    const username = loginUser.value.trim();
    const password = loginPassword.value;
    if (!password) { setLoginHint('请输入密码'); loginPassword.focus(); return; }
    if (!credentialBridge) { setLoginHint('当前环境不支持保险柜'); return; }
    loginBusy = true;
    loginSubmit.disabled = true;
    try {
      // Saving is silent; if the vault is unavailable, still fill once.
      const saved = await credentialBridge.save({ origin: target.origin, username, password });
      const filled = await credentialBridge.fill({
        origin: target.origin,
        submit: true,
        ...(saved?.ok ? {} : { credentials: { username, password } }),
      });
      if (!filled?.ok) { setLoginHint(filled?.message || '填充登录信息失败'); return; }
      hideLogin();
      // Capture the post-login cookies once the submit response has landed.
      if (credentialBridge.loginRecord) {
        setTimeout(() => { void credentialBridge.loginRecord.save().catch(() => {}); }, 900);
      }
    } catch (cause) {
      setLoginHint(cause?.message || '登录信息填充失败');
    } finally {
      loginBusy = false;
      loginSubmit.disabled = false;
    }
  });

  // ---- 选区引用 + 页面元素选择（方案 §3.9–3.11 / §4.5） ---------------------
  // 浮层（quote.js）与注入桥（web-inspect.js）都是解耦模块；这里只做宿主胶水：
  // 按钮状态、舞台提示条、arm 时机、文件视图/网页选区接线、关闭时机。
  const QUOTE_IGNORED = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], button, [data-quote-ignore]';
  const PICKER_HINT = '点击页面上的元素引用到对话 · Esc';
  const SELECTION_HINT = '此页面不支持直接引用选区，可改用「选择页面元素」';
  const QUOTE_DEBOUNCE = 120;

  const hint = stage.querySelector('.browser-inspect-hint');
  const hintText = hint.querySelector('.browser-inspect-hint-text');
  const hintExit = hint.querySelector('.browser-inspect-hint-exit');
  let hintMode = '';
  let hintTimer = 0;
  let quoteTimer = 0;
  let pickerOn = false;
  // True while the user's own click is being served. Background arms (navigation, panel open,
  // Esc-out) also report failures, and those must stay silent: opening a URL is not a pick.
  let pickerRequested = false;
  let armedTabId = '';
  let armTicket = 0;
  // 主进程侧是否真的建立过注入会话：没有就不必每次切文件都发一次 stop。
  let inspectLive = false;

  const quote = mountQuotePopover({
    stage,
    getLocation: () => tabLocation(),
  });

  const inspect = mountWebInspect({
    getWebview: () => webview,
    onSelection: payload => { quote.showSelection(payload.rect, payload.text, payload.source); },
    onElement: payload => { quote.showElement(payload.rect, payload.element, payload.source); },
    onExit: () => {
      setPickerState(false);
      quote.hide();
      // 导航 / 页面内 Esc 之后如果还停在网页上，重新 arm（选区上报继续可用）。
      armedTabId = '';
      if (tabLocation()?.kind === WEB) armInspect({ report: false });
    },
    onPickerChange: value => setPickerState(value),
    onError: payload => {
      // 只有用户主动点了「选择页面元素」才用红条报告；后台 arm 失败只写日志。
      if (pickerRequested || pickerOn) showInspectError(payload?.message);
      else console.warn('[browser] 元素选择不可用：', payload?.message || payload?.code);
    },
  });

  function clearHintTimer() {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = 0;
    }
  }

  function showHint(text, options = {}) {
    clearHintTimer();
    hintMode = options.mode || '';
    hint.dataset.tone = options.tone || 'info';
    hintText.textContent = text || '';
    hintText.title = text || '';
    hintExit.hidden = options.exit !== true;
    hint.hidden = false;
    if (options.timeout > 0) {
      hintTimer = setTimeout(() => {
        hintTimer = 0;
        hideHint();
      }, options.timeout);
    }
  }

  function hideHint() {
    clearHintTimer();
    hintMode = '';
    hint.hidden = true;
    hintText.textContent = '';
    hintExit.hidden = true;
    delete hint.dataset.tone;
  }

  /** 注入失败 / DevTools 占用（§3.10）：顶部提示，4 秒后自动消失，不静默失败。 */
  function showInspectError(message) {
    showHint(message || SELECTION_HINT, { tone: 'error', timeout: 4000, mode: 'error' });
  }

  function setPickerState(value) {
    const next = value === true;
    pickerOn = next;
    inspectButton.setAttribute('aria-pressed', String(next));
    if (next) showHint(PICKER_HINT, { mode: 'picking', exit: true });
    else if (hintMode === 'picking') hideHint();
  }

  /** 进入网页位置 / dom-ready / 面板打开 / 切标签：只开选区上报（picker:false）。 */
  function armInspect(options = {}) {
    const loc = tabLocation();
    const tabId = activeTab?.id || '';
    if (!tabId || loc?.kind !== WEB || panel.hidden) {
      armedTabId = '';
      return;
    }
    if (armedTabId === tabId) return;
    const ticket = ++armTicket;
    void inspect.arm(tabId).then(result => {
      // 位置已经换过：这次 arm 的结果不再代表当前页面。
      if (ticket !== armTicket) return;
      if (result?.ok) {
        armedTabId = tabId;
        inspectLive = true;
        return;
      }
      armedTabId = '';
      if (options.report === true) showInspectError(result?.message);
    }).catch(() => { /* 桥不可用时静默：按钮点击会给出明确提示 */ });
  }

  /** 结束选择并撤掉注入：面板关闭 / 离开网页位置 / 销毁时用。 */
  function stopInspect() {
    armedTabId = '';
    armTicket += 1;
    setPickerState(false);
    hideHint();
    if (!inspectLive) return;
    inspectLive = false;
    void inspect.stop();
  }

  /** 「退出」按钮：只停 picker，注入会话保留，选区引用继续可用。 */
  function cancelPicker() {
    armedTabId = '';
    armInspect({ report: false });
  }

  const onInspectClick = () => {
    if (pickerOn) {
      cancelPicker();
      return;
    }
    if (tabLocation()?.kind !== WEB) return;
    quote.hide();
    armedTabId = '';
    pickerRequested = true;
    void inspect.startPicker(activeTab?.id || '').then(result => {
      pickerRequested = false;
      if (result?.ok) {
        armedTabId = activeTab?.id || '';
        inspectLive = true;
      } else {
        setPickerState(false);
      }
    });
  };
  const onHintExitClick = () => { cancelPicker(); };
  inspectButton.addEventListener('click', onInspectClick);
  hintExit.addEventListener('click', onHintExitClick);
  // The page-side script handles Esc inside the guest; when focus is still on
  // the panel (toolbar button, viewer) the host has to cancel it too.
  function onHostKeyDown(event) {
    if (event.key !== 'Escape' || !pickerOn) return;
    event.preventDefault();
    cancelPicker();
  }
  window.addEventListener('keydown', onHostKeyDown);

  /** 选区所在的代码 / 文本行号（代码视图有 data-line，文本视图读行号槽）。 */
  function lineOfRange(range) {
    const node = range?.startContainer;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element?.closest) return 0;
    const codeLine = element.closest('[data-line]');
    if (codeLine) return Number(codeLine.dataset.line) || 0;
    const textLine = element.closest('.text-line');
    if (textLine) return Number(textLine.querySelector('.code-gutter')?.textContent) || 0;
    return 0;
  }

  /** 读取 stage 内（Markdown / 代码 / 文本视图）的有效选区。 */
  function readStageSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return null;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element || !stage.contains(element)) return null;
    if (element.closest(QUOTE_IGNORED)) return null;
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 || rect.height > 0);
    // Anchor above the first selected line so moving the pointer up hits the pill.
    const rect = rects[0] ?? range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect, line: lineOfRange(range) };
  }

  function evaluateQuoteSelection() {
    const loc = tabLocation();
    // 只有文件位置参与：网页走注入桥，目录没有可选文本。
    if (!loc || loc.kind !== FILE) return;
    const found = readStageSelection();
    if (!found) {
      quote.hide();
      return;
    }
    const source = { kind: FILE, rootId: loc.rootId, path: loc.path };
    const line = found.line || Number(loc.line) || 0;
    if (line > 0) source.line = line;
    quote.showSelection(found.rect, found.text, source);
  }

  function scheduleQuoteSelection() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(evaluateQuoteSelection, QUOTE_DEBOUNCE);
  }

  // 浮层里的点击不要重新弹一次（引用后保留选区，方便连点同一段）。
  const onStageMouseUp = event => {
    if (event.target?.closest?.('.browser-quote')) return;
    if (tabLocation()?.kind === FILE) scheduleQuoteSelection();
  };
  const onDocumentSelectionChange = () => {
    if (tabLocation()?.kind === FILE) scheduleQuoteSelection();
  };
  // 页面内滚动宿主收不到事件（webview 不能挂 preload），指针重新回到页面即视为放弃，
  // 避免浮层停在错位坐标上；导航/刷新由 web-inspect 的 exit 收尾。
  const onViewportMouseOver = event => {
    if (tabLocation()?.kind !== WEB) return;
    if (String(event.target?.tagName || '').toLowerCase() !== 'webview') return;
    quote.hide();
  };
  stage.addEventListener('mouseup', onStageMouseUp);
  document.addEventListener('selectionchange', onDocumentSelectionChange);
  viewport.addEventListener('mouseover', onViewportMouseOver);

  function hideTakeover() {
    takeover.hidden = true;
    takeoverId = null;
    takeoverNote.textContent = '';
  }
  function showTakeover(payload = {}) {
    if (!payload.id) return;
    takeoverId = payload.id;
    open(true);
    takeoverNote.textContent = payload.note || (payload.reason === 'login' ? '需要你完成登录' : '需要你处理当前页面');
    takeover.hidden = false;
    try { webview.focus?.(); } catch { /* guest may not be ready */ }
  }
  function sendContinueMessage() {
    const root = document.querySelector('#composer [data-deep-agent-original]')?.shadowRoot;
    const textarea = root?.querySelector('textarea');
    const send = root?.querySelector('button[aria-label="发送"]');
    if (!textarea || !send) return;
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, '我已处理完浏览器，请继续。');
    else textarea.value = '我已处理完浏览器，请继续。';
    textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    setTimeout(() => { try { send.click(); } catch { /* composer may have unmounted */ } }, 80);
  }
  async function respondTakeover(decision) {
    if (!takeoverId) return;
    const id = takeoverId;
    hideTakeover();
    try { await window.movaDesktop?.browser?.respondTakeover?.(id, decision); } catch { /* controller may be gone */ }
    if (decision === 'resume') sendContinueMessage();
  }
  panel.querySelector('[data-takeover-resume]').addEventListener('click', () => { void respondTakeover('resume'); });
  panel.querySelector('[data-takeover-cancel]').addEventListener('click', () => { void respondTakeover('cancel'); });
  window.movaDesktop?.browser?.onTakeover?.(showTakeover);
  window.movaDesktop?.browser?.onTakeoverClose?.(({ id } = {}) => { if (!takeoverId || id === takeoverId) hideTakeover(); });

  // ---- 位置模型 + 渲染分发 ------------------------------------------------
  // 只有这里会 push 位置并驱动舞台；链接、地址栏、三个点、目录双击、面包屑
  // 全部都收敛到 navigate()/replaceLocation()（方案 §4.3）。
  function showPanelError(message) {
    open(true);
    error.textContent = message || '操作失败';
    error.hidden = false;
    // 失败后地址栏回到稳定态，避免输入框停留在半截相对路径上。
    syncToolbar(tabLocation());
  }

  function hidePanelError() {
    error.hidden = true;
    error.textContent = '';
  }

  function clear() {
    if (blob) URL.revokeObjectURL(blob);
    blob = null;
    iframe.removeAttribute('src');
    iframe.hidden = true;
    if (webview) webview.style.display = 'none';
    text.hidden = true;
    viewport.hidden = false;
    error.hidden = true;
    panel.querySelector('.browser-start').hidden = true;
  }

  function syncToolbar(loc) {
    setModuleLocation(loc);
    stage.dataset.locationKind = loc?.kind || '';
    // 「选择页面元素」只在网页位置可用（§3.2 行为矩阵）。
    const inspectable = loc?.kind === WEB;
    const inspectTitle = inspectable ? '选择页面元素' : '仅网页可选取元素';
    inspectButton.disabled = !inspectable;
    inspectButton.title = inspectTitle;
    inspectButton.setAttribute('aria-label', inspectTitle);
    const share = panel.querySelector('[data-share]');
    const titles = { [WEB]: '在系统浏览器中打开', [FILE]: '在资源管理器中显示文件', [DIR]: '在资源管理器中打开文件夹' };
    const label = titles[loc?.kind] || '打开当前位置';
    share.title = label;
    share.setAttribute('aria-label', label);
    share.disabled = !loc;
    address.setLocation(loc, {
      rootName: loc && loc.kind !== WEB ? rootNameOf(loc, roots()) : '',
      entryCount: loc?.kind === DIR ? -1 : undefined,
    });
    try {
      window.dispatchEvent(new CustomEvent('mova:location-change', { detail: loc || null }));
    } catch { /* CustomEvent 不可用（预览环境）时忽略 */ }
  }

  // `<webview>` throws ("must be attached and dom-ready") when guest APIs are
  // called during the first navigation, so every read goes through this guard.
  function currentUrlOf(el) {
    if (!el) return '';
    try { return el.getURL?.() || el.getAttribute?.('src') || ''; } catch { return el.getAttribute?.('src') || ''; }
  }

  function showWebSurface(loc) {
    clear();
    webview.style.display = 'flex';
    panel.querySelector('.browser-start').hidden = true;
    const current = currentUrlOf(webview);
    if (current !== loc.url) webview.src = loc.url;
    renderTabs();
  }

  function hideWebSurface() {
    if (webview) webview.style.display = 'none';
    if (blob) URL.revokeObjectURL(blob);
    blob = null;
    iframe.removeAttribute('src');
    iframe.hidden = true;
    text.hidden = true;
    viewport.hidden = true;
    error.hidden = true;
    panel.querySelector('.browser-start').hidden = true;
  }

  function renderLocation(loc) {
    // Any navigation leaves the canvas: the surface returns to the page or file it shows.
    if (view === 'canvas') canvasSlot.hidden = true;
    view = !loc ? 'web' : loc.kind === WEB ? 'web' : 'file';
    lastLocationView = view;
    panel.dataset.view = view;
    if (!loc) {
      stopInspect();
      quote.hide();
      viewer.hide();
      clear();
      viewport.hidden = false;
      panel.querySelector('.browser-start').hidden = false;
      syncToolbar(null);
      return;
    }
    hidePanelError();
    if (loc.kind === WEB) {
      viewer.hide();
      showWebSurface(loc);
      syncToolbar(loc);
      // 立刻试一次（可能是已加载的页面）；失败不打扰，dom-ready 会再试并给出提示。
      armInspect({ report: false });
      return;
    }
    // 离开网页位置：选择态和注入会话都要收掉，浮层不能挂在文件视图上。
    stopInspect();
    quote.hide();
    hideWebSurface();
    viewer.show(loc);
    syncToolbar(loc);
  }

  /**
   * Switches the stage between its three surfaces. `canvas` is not a navigation: the design
   * panel keeps its own document and the address pill only describes it.
   */
  function showView(next) {
    if (next === 'canvas') {
      if (view !== 'canvas') lastLocationView = view;
      view = 'canvas';
      panel.dataset.view = 'canvas';
      open(true);
      stopInspect();
      quote.hide();
      hideWebSurface();
      hidePanelError();
      canvasSlot.hidden = false;
      const design = canvasSlot.querySelector('.mova-design-panel');
      if (design) design.hidden = false;
      syncToolbar(null);
      // A canvas needs more room than a page: widen the panel once `open` restored its width.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = Math.max(panel.getBoundingClientRect().width, frame.clientWidth * 0.62);
        setBrowserWidth(target);
        address?.fit();
      }));
      return;
    }
    canvasSlot.hidden = true;
    renderLocation(tabLocation());
  }

  /** Returns the surface to whatever it showed before the canvas took it over. */
  function leaveCanvas() {
    if (view !== 'canvas') return;
    showView(lastLocationView || 'web');
  }

  /**
   * The chooser's three items. `web` and `file` are locations rather than surfaces, so they render
   * the active tab's position; `canvas` is a surface of its own and is opened by the design
   * workspace, which also has to boot its editor.
   */
  function openView(kind) {
    hideViewChooser();
    if (kind === 'canvas') {
      showView('canvas');
      window.dispatchEvent(new CustomEvent('mova:open-design'));
      return;
    }
    if (kind === 'file') {
      const last = [...visited].reverse().find(loc => loc && loc.kind !== WEB);
      if (!last) {
        open(true);
        renderLocation(tabLocation());
        showPanelError('还没有打开过文件：在对话里点一个文件，之后这里会回到上次的位置');
        return;
      }
      // push:false keeps the tab's history honest while restoring the last file position.
      void navigate(last, { push: false });
      return;
    }
    open(true);
    renderLocation(tabLocation());
  }

  /** 打开一个位置：push 历史 + 渲染。所有入口都走这里。 */
  async function navigate(input, options = {}) {
    open(true);
    const loc = normalizeLocation(input);
    if (!loc) {
      showPanelError('只能打开网页链接或已授权文件夹内的相对路径');
      return;
    }
    let tab = activeTab;
    if (!tab) {
      tab = makeTab();
      if (!tab) return;
    }
    if (activeTab !== tab) activateTab(tab);
    if (options.push === false) tab.history.replace(loc);
    else tab.history.push(loc);
    if (loc.kind === WEB) tab.url = loc.url;
    visited.push(loc);
    closeMenu();
    renderLocation(tab.history.current());
    saveTabState();
    if (loc.kind === DIR) address.fit();
  }

  /** 自纠正（例如链接指向目录）：替换当前历史项而不是新增一条。 */
  async function replaceLocation(loc) {
    return navigate(loc, { push: false });
  }

  /** 用主进程的 stat 判存在性/类型；失败返回 'missing'。 */
  async function statKind(loc) {
    if (!filesBridge?.stat) return 'unknown';
    try {
      const result = await filesBridge.stat({ rootId: loc.rootId, path: loc.path });
      if (!result?.ok) return 'missing';
      return result.value?.type === 'dir' ? DIR : FILE;
    } catch {
      return 'unknown';
    }
  }

  /** 地址栏提交：先当网址，再当当前 root 内的相对路径。 */
  async function submitAddress(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return;
    if (/^https?:\/\//i.test(raw)) {
      const url = normalizeUrl(raw);
      if (!url) { showPanelError('请输入有效的网址'); return; }
      await navigate({ kind: WEB, url });
      return;
    }
    // 本地预览：显式 file:// 一律按「网址」处理，不受当前面板是文件视图还是网页视图影响。
    // 能不能真的打开由主进程判定（只允许已登记项目根内的白名单类型），这里只负责别把它当路径解析。
    if (/^file:\/\//i.test(raw)) {
      const url = normalizeUrl(raw);
      if (!url) { showPanelError('本地文件地址无效（不支持网络共享路径 file://server/…）'); return; }
      await navigate({ kind: WEB, url });
      return;
    }
    const current = tabLocation();
    if (!current || current.kind === WEB) {
      const url = normalizeUrl(raw);
      if (url) { await navigate({ kind: WEB, url }); return; }
      showPanelError('请输入有效的网址，文件请从对话引用中打开');
      return;
    }
    if (/^[a-z]:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\') || raw.split(/[\\/]/).includes('..')) {
      // `./x`、`../x` 是相对当前目录的写法，单独放行。
      if (!/^\.\.?([\\/]|$)/.test(raw)) {
        showPanelError('只能打开已授权项目文件夹内的文件');
        return;
      }
    }
    const anchor = splitAnchor(raw);
    const baseDir = current.kind === DIR ? current.path : directoryOf(current.path);
    const path = /^\.\.?([\\/]|$)/.test(anchor.path)
      ? joinPath(baseDir, anchor.path)
      : normalizePath(anchor.path);
    if (path === null) { showPanelError('路径不合法：不能包含 ..、盘符或绝对路径'); return; }
    const kind = await statKind({ kind: FILE, rootId: current.rootId, path });
    if (kind === DIR) { await navigate({ kind: DIR, rootId: current.rootId, path }); return; }
    if (kind === 'missing') { showPanelError('文件不在已授权文件夹内'); return; }
    const target = { kind: FILE, rootId: current.rootId, path };
    if (anchor.line) target.line = anchor.line;
    await navigate(target);
  }

  /** `mova:open-reference` 的 file 分支：多根目录按存在性逐个试（方案 §3.1）。 */
  async function openFileReference(detail = {}) {
    const available = roots() || [];
    if (!available.length) {
      showPanelError('当前项目还没有登记可读取的文件夹');
      return;
    }
    const anchor = splitAnchor(String(detail.path || ''));
    const candidates = [];
    const add = (root, path) => {
      if (!root || path === null || path === undefined) return;
      if (candidates.some(item => item.root.id === root.id && item.path === path)) return;
      candidates.push({ root, path });
    };
    const named = available.find(root => anchor.path.replace(/\\/g, '/').startsWith(`${root.name}/`));
    const direct = available.find(root => root.id === detail.rootId);
    if (direct) add(direct, normalizePath(anchor.path));
    if (named) add(named, normalizePath(anchor.path.replace(/\\/g, '/').slice(named.name.length + 1)));
    for (const root of available) add(root, normalizePath(anchor.path));
    // 预览环境没有 stat：沿用“单一根目录直接开”的旧行为，否则会误报不存在。
    if (!filesBridge?.stat) {
      const fallback = candidates[0];
      if (!fallback) { showPanelError('文件不在已授权文件夹内'); return; }
      await navigate({ kind: FILE, rootId: fallback.root.id, path: fallback.path, line: anchor.line || undefined });
      return;
    }
    for (const { root, path } of candidates) {
      const kind = await statKind({ rootId: root.id, path });
      if (kind !== FILE && kind !== DIR) continue;
      const loc = { kind, rootId: root.id, path };
      if (kind === FILE && anchor.line) loc.line = anchor.line;
      await navigate(loc);
      return;
    }
    // 模型给的常常是绝对路径（Gemini 的 CLI 工具尤其如此），渲染层自己的 normalizePath 会直接判死。
    // 归属判定放在主进程（它才拿得到 realpath 与根清单），这里只问一次「它落在哪个根里」。
    const located = await locateReference(anchor.path);
    if (located) {
      const loc = { kind: located.type === 'dir' ? DIR : FILE, rootId: located.rootId, path: located.path };
      if (loc.kind === FILE && anchor.line) loc.line = anchor.line;
      await navigate(loc);
      return;
    }
    showPanelError('文件不在已授权文件夹内：请确认它位于当前项目的文件夹中');
  }

  /** 让主进程把一个原始路径落到已登记根上；拿不到归属就返回 null（绝不猜）。 */
  async function locateReference(rawPath) {
    if (!filesBridge?.locate || typeof rawPath !== 'string' || !rawPath.trim()) return null;
    try {
      const result = await filesBridge.locate({ raw: rawPath });
      const value = result?.ok === true ? result.value : null;
      return value && typeof value.rootId === 'string' && typeof value.path === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  panel.querySelector('[data-back]').onclick = event => {
    event.preventDefault();
    const tab = activeTab;
    if (!tab) return;
    const loc = tab.history.current();
    // 网页优先 webview 自身历史；其余（文件/目录、跨类型回退）走位置栈。
    if (loc?.kind === WEB && webview?.canGoBack?.()) { webview.goBack(); return; }
    if (!tab.history.back()) return;
    tab.url = tabLocation()?.url || tab.url;
    renderLocation(tab.history.current());
    saveTabState();
  };
  panel.querySelector('[data-forward]').onclick = event => {
    event.preventDefault();
    const tab = activeTab;
    if (!tab) return;
    const loc = tab.history.current();
    if (loc?.kind === WEB && webview?.canGoForward?.()) { webview.goForward(); return; }
    if (!tab.history.forward()) return;
    tab.url = tabLocation()?.url || tab.url;
    renderLocation(tab.history.current());
    saveTabState();
  };
  panel.querySelector('[data-reload]').onclick = event => {
    event.preventDefault();
    const loc = tabLocation();
    if (loc?.kind === WEB) {
      if (webview?.reload) webview.reload();
      else if (activeTab?.el?.reload) activeTab.el.reload();
      return;
    }
    if (loc) viewer.refresh();
  };
  panel.querySelector('[data-share]').onclick = () => {
    const loc = tabLocation();
    if (!loc) return;
    if (loc.kind === WEB) {
      void window.movaDesktop?.browser?.external?.(loc.url);
      return;
    }
    if (loc.kind === FILE) {
      if (!window.movaDesktop?.files?.reveal) { showPanelError('资源管理器调用仅在桌面版可用'); return; }
      void window.movaDesktop.files.reveal({ rootId: loc.rootId, path: loc.path });
      return;
    }
    if (!filesBridge?.openDir) { showPanelError('打开文件夹仅在桌面版可用'); return; }
    void filesBridge.openDir({ rootId: loc.rootId, path: loc.path });
  };

  function restoreWebSurface() {
    if (webview) {
      webview.style.visibility = '';
      webview.style.clipPath = '';
    }
    viewport.style.backgroundImage = '';
    viewport.style.background = '';
  }
  function setMenuExpanded(value) {
    panel.querySelector('[data-menu]').setAttribute('aria-expanded', String(value));
  }
  function closeMenu() {
    menu.hidden = true;
    menuRequestId += 1;
    setMenuExpanded(false);
    restoreWebSurface();
  }
  function menuRow(label, className, onClick, options = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = className;
    if (options.icon) {
      const glyph = icon(options.icon);
      glyph.setAttribute('aria-hidden', 'true');
      row.append(glyph);
    }
    const text = document.createElement('span');
    text.className = 'browser-menu-entry-label';
    text.textContent = label;
    text.title = options.title || label;
    row.append(text);
    row.onclick = event => { event.preventDefault(); event.stopPropagation(); onClick?.(event); };
    return row;
  }
  function menuHeading(text) {
    const heading = document.createElement('div');
    heading.className = 'browser-menu-heading';
    heading.textContent = text;
    return heading;
  }
  /** 文件/目录模式的三个点：当前文件夹条目（不含标签页，方案 §3.2）。 */
  async function openFolderMenu(loc) {
    const ticket = ++menuRequestId;
    menu.replaceChildren(menuHeading(loc.kind === DIR ? '当前文件夹' : '所在文件夹'));
    const loading = document.createElement('div');
    loading.className = 'browser-menu-empty';
    loading.textContent = '读取中…';
    menu.append(loading);
    menu.hidden = false;
    setMenuExpanded(true);
    const listing = await viewer.directoryListing(loc);
    if (ticket !== menuRequestId || menu.hidden) return;
    renderFolderRows(loc, listing);
  }
  function renderFolderRows(loc, listing) {
    menu.replaceChildren(menuHeading(listing.dir?.path ? listing.dir.path.split('/').pop() : rootNameOf(loc, roots())));
    const dir = listing.dir || (loc.kind === DIR ? loc : null);
    if (dir && dir.path) {
      const parent = dir.path.includes('/') ? dir.path.slice(0, dir.path.lastIndexOf('/')) : '';
      menu.append(menuRow('上一级', 'browser-menu-entry', () => {
        closeMenu();
        void navigate({ kind: DIR, rootId: loc.rootId, path: parent });
      }, { icon: 'arrow-left' }));
    }
    if (!listing.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'browser-menu-empty';
      empty.textContent = '这个文件夹是空的';
      menu.append(empty);
    }
    for (const entry of listing.entries) {
      const path = dir?.path ? `${dir.path}/${entry.name}` : entry.name;
      menu.append(menuRow(truncateText(entry.name, 40), 'browser-menu-entry', () => {
        closeMenu();
        void navigate(entry.type === 'dir'
          ? { kind: DIR, rootId: loc.rootId, path }
          : { kind: FILE, rootId: loc.rootId, path });
      }, { icon: entryIcon(entry), title: entry.name }));
    }
    if (dir && filesBridge?.openDir) {
      const footer = menuRow('在资源管理器中打开', 'browser-menu-new', () => {
        closeMenu();
        void filesBridge.openDir({ rootId: loc.rootId, path: dir.path });
      });
      menu.append(footer);
    }
    // 用系统默认程序打开：与 Ctrl+点击同一件事，md 交给关联的编辑器/浏览器（等同在文件管理器里双击）。
    if (loc?.kind === FILE && filesBridge?.openExternal) {
      menu.append(menuRow('用默认程序打开', 'browser-menu-new', () => {
        closeMenu();
        void filesBridge.openExternal({ rootId: loc.rootId, path: loc.path });
      }));
    }
  }
  function renderTabMenu() {
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'browser-menu-heading';
    heading.textContent = '标签页';
    menu.append(heading);
    if (!tabs.length) {
      const empty = document.createElement('div');
      empty.className = 'browser-menu-empty';
      empty.textContent = '没有标签页';
      menu.append(empty);
    }
    for (const tab of tabs) {
      const row = document.createElement('div');
      row.className = `browser-menu-tab${tab === activeTab ? ' is-active' : ''}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'browser-menu-tab-open';
      open.textContent = tabLabel(tab);
      open.title = tab.url || tabLabel(tab);
      open.onclick = event => { event.preventDefault(); event.stopPropagation(); closeMenu(); activateTab(tab); };
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'browser-menu-tab-close';
      close.setAttribute('aria-label', `关闭 ${tabLabel(tab)}`);
      close.textContent = '×';
      close.onclick = event => { event.stopPropagation(); closeTab(tab); if (!menu.hidden) renderTabMenu(); };
      row.append(open, close);
      menu.append(row);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'browser-menu-new';
    add.textContent = '＋ 新建标签页';
    add.onclick = () => { closeMenu(); makeTab(newTabUrl(), activeSpaceId); input.focus(); };
    menu.append(add);
  }
  panel.querySelector('[data-menu]').onclick = () => {
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    const loc = tabLocation();
    if (loc && loc.kind !== WEB) {
      void openFolderMenu(loc);
      return;
    }
    renderTabMenu();
    menu.hidden = false;
    setMenuExpanded(true);
    // The dropdown already has its own stacking layer; do not clip or dim
    // the whole webview behind it.
  };
  const resizer = panel.querySelector('.browser-resizer');
  const MIN_CHAT = 360;
  const MIN_BROWSER = 320;
  function maxBrowserWidth() {
    const rect = frame.getBoundingClientRect();
    const sidebar = document.querySelector('.project-sidebar');
    const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;
    return Math.max(MIN_BROWSER, rect.width - sidebarWidth - MIN_CHAT);
  }
  function setBrowserWidth(value, persist = false) {
    const width = Math.max(MIN_BROWSER, Math.min(maxBrowserWidth(), value));
    panel.style.setProperty('--browser-width', `${width}px`);
    resizer.setAttribute('aria-valuenow', String(Math.round(width)));
    if (persist && browserPrefs?.basics?.rememberWidth !== false) {
      try { localStorage.setItem('mova.browser.width', String(Math.round(width))); } catch { /* storage unavailable */ }
    }
  }
  const savedWidth = Number(localStorage.getItem('mova.browser.width'));
  if (Number.isFinite(savedWidth) && savedWidth >= MIN_BROWSER) setBrowserWidth(savedWidth);
  resizer.setAttribute('aria-valuemin', String(MIN_BROWSER));
  resizer.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));

  resizer.addEventListener('pointerdown', event => {
    resizer.setPointerCapture(event.pointerId);
    const move = pointer => {
      // One boundary, one pane: clamp at min chat/min browser; never cascade
      // into hiding another view.
      setBrowserWidth(frame.getBoundingClientRect().right - pointer.clientX);
    };
    const end = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', end);
      if (browserPrefs?.basics?.rememberWidth !== false) {
        try { localStorage.setItem('mova.browser.width', String(Math.round(panel.getBoundingClientRect().width))); } catch { /* ignore */ }
      }
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', end);
  });

  resizer.addEventListener('dblclick', () => {
    frame.classList.remove('chat-collapsed');
    setBrowserWidth(frame.getBoundingClientRect().width * 0.42, true);
  });
  resizer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') { setBrowserWidth(frame.getBoundingClientRect().width * 0.42, true); return; }
    const delta = event.key === 'ArrowLeft' ? 16 : -16;
    setBrowserWidth(panel.getBoundingClientRect().width + delta, true);
  });
  window.addEventListener('mova:open-reference', event => {
    const value = event?.detail;
    if (!value) return;
    if (value.kind === 'url' && value.url) {
      void navigate({ kind: WEB, url: value.url });
      return;
    }
    if (value.kind === 'file') void openFileReference(value);
  });
  window.movaDesktop?.browser?.onEnsure?.(({ url } = {}) => {
    if (url) void navigate({ kind: WEB, url });
    else open(true);
  });
  tabBridge?.onTabNew?.(({ url, spaceId, background } = {}) => {
    makeTab(url || newTabUrl(), spaceId || activeSpaceId, { background: background === true });
  });
  tabBridge?.onTabSelect?.(({ tabId } = {}) => {
    const tab = tabs.find(item => item.id === tabId);
    if (tab) activateTab(tab);
  });
  tabBridge?.onTabClose?.(({ tabId } = {}) => {
    const tab = tabs.find(item => item.id === tabId);
    if (tab) closeTab(tab);
  });
  const scopedViews = createScopedViewState({
    capture: () => ({ open: !panel.hidden, view, tabId: activeTab?.id ?? null, spaceId: activeSpaceId }),
    restore: state => {
      hideViewChooser();
      closeMenu();
      login.hidden = true;
      cookieLogin.hidden = true;
      canvasSlot.hidden = true;
      view = 'web';
      lastLocationView = 'web';
      panel.dataset.view = 'web';
      if (state.spaceId) activeSpaceId = state.spaceId;
      const tab = tabs.find(item => item.id === state.tabId);
      if (tab) activateTab(tab);
      else clearActive();
      if (state.view === 'canvas') showView('canvas');
      open(state.open);
    },
  });
  function syncScope(key) { scopedViews.select(key); }
  function rekeyScope(from, to) { scopedViews.rekey(from, to); }
  // 供后续代理（引用浮层 / 元素选择）使用：位置、舞台、当前活动位置。
  return {
    open: navigate,
    syncScope,
    rekeyScope,
    getActiveLocation: () => tabLocation(),
    getStage: () => stage,
    /** Where the design canvas mounts, so all three surfaces share this panel. */
    getCanvasSlot: () => canvasSlot,
    showView,
    leaveCanvas,
    openView,
    getView: () => view,
    /** 面板整体卸载时调用：退订网页事件、移除浮层与监听。 */
    destroy() {
      clearTimeout(quoteTimer);
      clearTimeout(hintTimer);
      hintTimer = 0;
      stage.removeEventListener('mouseup', onStageMouseUp);
      document.removeEventListener('selectionchange', onDocumentSelectionChange);
      viewport.removeEventListener('mouseover', onViewportMouseOver);
      inspectButton.removeEventListener('click', onInspectClick);
      hintExit.removeEventListener('click', onHintExitClick);
      window.removeEventListener('keydown', onHostKeyDown);
      quote.destroy();
      inspect.dispose();
    },
  };
}
