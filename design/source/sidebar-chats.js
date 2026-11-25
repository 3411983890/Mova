import { icon } from './icons.js';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function actionButton(label, iconName, className = 'chat-row-action') {
  const button = node('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.append(icon(iconName));
  return button;
}

// 最近一次对话距今多久：xx分钟 / xx小时 / xx天，始终显示在行尾。
export function chatAge(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

export function createChatRows(sidebar, scroller) {
  const preview = node('div', 'chat-preview');
  preview.id = 'chat-preview';
  preview.setAttribute('role', 'tooltip');
  const menu = node('div', 'chat-actions-menu');
  menu.id = 'chat-actions-menu';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', '聊天操作');
  preview.hidden = menu.hidden = true;
  document.body.append(preview, menu);

  let active = null;
  let menuAnchor = null;
  let previewTimer = 0;
  let resizeTimer = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function position(popup, row, anchor = row) {
    const margin = 10;
    const { width, height } = popup.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const right = anchor === row ? rect.right + 3 : rect.right + 6;
    const fitsBeside = right + width + margin <= window.innerWidth;
    const preferredX = fitsBeside ? right : rect.right - width;
    const preferredY = fitsBeside ? rect.top : rect.bottom + 6;
    popup.style.left = `${Math.max(margin, Math.min(preferredX, window.innerWidth - width - margin))}px`;
    popup.style.top = `${Math.max(margin, Math.min(preferredY, window.innerHeight - height - margin))}px`;
  }

  function hidePreview() {
    clearTimeout(previewTimer);
    if (active) active.open.removeAttribute('aria-describedby');
    preview.hidden = true;
  }

  function showPreview(entry) {
    if (entry !== active || menuAnchor || !entry.row.isConnected) return;
    const { chat, project } = entry;
    const title = node('strong', 'chat-preview-title', chat.title);
    const location = node('span', 'chat-preview-location');
    const cloud = chat.location === 'cloud';
    location.append(icon(cloud ? 'cloud' : 'laptop'), node('span', '', cloud ? '云端' : '本地'));
    const heading = node('div', 'chat-preview-heading');
    heading.append(title, location);
    const folder = node('div', 'chat-preview-folder');
    folder.append(icon('folder-simple'), node('span', '', project.name));
    preview.replaceChildren(heading, folder);
    preview.hidden = false;
    position(preview, entry.row);
    entry.open.setAttribute('aria-describedby', preview.id);
  }

  function deactivate() {
    hidePreview();
    clearTimeout(resizeTimer);
    if (!active) return;
    active.motion?.cancel();
    active.row.classList.remove('is-scrolling-title');
    active.row.classList.remove('is-reading');
    active = null;
  }

  function slideTitle(entry) {
    entry.motion?.cancel();
    entry.row.classList.remove('is-scrolling-title');
    const distance = entry.title.scrollWidth - entry.clip.clientWidth;
    if (distance < 2 || reducedMotion.matches) return;
    entry.row.classList.add('is-scrolling-title');
    entry.motion = entry.title.animate([
      { transform: 'translateX(0)' },
      { transform: `translateX(${-distance}px)` },
    ], { duration: Math.max(540, distance * 19), delay: 320, easing: 'ease-in-out', fill: 'forwards' });
  }

  function activate(entry, withMotion) {
    if (menuAnchor || active === entry) return;
    deactivate();
    active = entry;
    entry.withMotion = withMotion;
    entry.row.classList.add('is-reading');
    if (withMotion) slideTitle(entry);
    previewTimer = setTimeout(() => showPreview(entry), withMotion ? 440 : 180);
  }

  function closeMenu(restoreFocus = false) {
    if (!menuAnchor) return;
    const { row, more } = menuAnchor;
    menuAnchor = null;
    menu.hidden = true;
    row.classList.remove('has-actions-menu');
    more.setAttribute('aria-expanded', 'false');
    if (restoreFocus && more.isConnected) more.focus({ preventScroll: true });
  }

  function close() {
    closeMenu();
    deactivate();
  }

  function showMenu(entry, keyboard) {
    if (menuAnchor === entry) { closeMenu(keyboard); return; }
    close();
    menuAnchor = entry;
    entry.row.classList.add('has-actions-menu');
    entry.more.setAttribute('aria-expanded', 'true');
    const openItem = actionButton('打开聊天', 'chat-circle', 'chat-menu-item');
    const archiveLabel = entry.chat.archived ? '恢复聊天' : '归档聊天';
    const archiveItem = actionButton(archiveLabel, entry.chat.archived ? 'arrow-u-up-left' : 'archive', 'chat-menu-item');
    openItem.append(node('span', '', '打开聊天'));
    archiveItem.append(node('span', '', archiveLabel));
    openItem.addEventListener('click', () => { closeMenu(); entry.onOpen(); });
    archiveItem.addEventListener('click', () => { closeMenu(); entry.onArchive(); });
    menu.replaceChildren(openItem, archiveItem);
    menu.hidden = false;
    position(menu, entry.row, entry.more);
    if (keyboard) openItem.focus({ preventScroll: true });
  }

  document.addEventListener('pointerdown', event => {
    if (menuAnchor && !menu.contains(event.target) && !menuAnchor.more.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (menuAnchor) closeMenu(true);
    else if (active) deactivate();
  });
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget) && event.relatedTarget !== menuAnchor?.more) closeMenu();
  });
  scroller.addEventListener('scroll', close, { passive: true });
  window.addEventListener('resize', close);
  new ResizeObserver(() => {
    closeMenu();
    if (!active) return;
    if (!preview.hidden) position(preview, active.row);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active?.withMotion) slideTitle(active); }, 90);
  }).observe(sidebar);

  function create(project, chat, { selected, onOpen, onArchive }) {
    const row = node('div', 'chat-row');
    row.classList.toggle('selected', selected);
    const open = node('button', 'chat-open');
    open.type = 'button';
    if (selected) open.setAttribute('aria-current', 'true');
    const clip = node('span', 'chat-title-window');
    const title = node('span', 'chat-title', chat.title);
    clip.append(title);
    open.append(clip);
    const actions = node('div', 'chat-row-actions');
    const more = actionButton(`${chat.archived ? '恢复' : '归档'}：${chat.title}`, chat.archived ? 'arrow-u-up-left' : 'archive');
    actions.append(more);
    const tail = node('div', 'chat-row-tail');
    const age = node('span', 'chat-time', chatAge(chat.updatedAt));
    age.__chat = chat;
    tail.append(age, actions);
    row.append(open, tail);
    const entry = { row, open, clip, title, project, chat, more, onOpen, onArchive };

    row.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') activate(entry, true); });
    row.addEventListener('pointerleave', () => { if (active === entry && !row.querySelector(':focus-visible')) deactivate(); });
    row.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) activate(entry, false); });
    row.addEventListener('focusout', event => { if (active === entry && !row.contains(event.relatedTarget) && !row.matches(':hover')) deactivate(); });
    open.addEventListener('click', onOpen);
    more.addEventListener('click', () => { close(); onArchive(); });
    return row;
  }

  function refreshTimes() {
    for (const element of sidebar.querySelectorAll('.chat-time')) {
      if (element.__chat) element.textContent = chatAge(element.__chat.updatedAt);
    }
  }

  return { create, close, refreshTimes };
}
