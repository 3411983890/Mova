import { icon } from '../../shared/icons.js';
import { chatRowAction } from './chat-row-action.mjs';

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

// 最近一次对话距今多久。单位随跨度切换，最多三个字宽，所以行尾的宽度是固定的，
// 鼠标移入换成归档按钮时标题不会跟着变窄。
// 刚刚 / N分 / N时 / N日 / N月
export function chatAge(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return '';
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日`;
  return `${Math.floor(days / 30)}月`;
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
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

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
    if (!active) return;
    resetTitleShift(active.row);
    active.row.classList.remove('is-reading');
    active = null;
  }

  /**
   * Stop a running title scroll and put the text back where it starts. Called when the pointer
   * leaves (nothing should be left translated) and before a row is moved, because a `fill: forwards`
   * transform measured against the old width would otherwise stay on it.
   */
  function resetTitleShift(row) {
    if (!row) return;
    row.classList.remove('is-scrolling-title');
    const title = row.querySelector('.chat-title');
    if (!title) return;
    if (typeof title.getAnimations === 'function') {
      for (const animation of title.getAnimations()) animation.cancel();
    }
    title.style.transform = '';
  }

  /**
   * A title too long for its box scrolls slowly to its end while the row is hovered, so the full
   * text can be read without leaving the list. It only runs for a truncated title, it stops and
   * rewinds on pointer-out, and the distance is measured against the current box — the tail has a
   * fixed width, so hovering itself never changes that measurement.
   */
  function scrollTitle(entry) {
    resetTitleShift(entry.row);
    if (reducedMotion?.matches) return;
    // The class first: it drops `max-width: 100%` and the ellipsis, so the measured width is the
    // real text width. Measuring before it would make the end land a few pixels short.
    entry.row.classList.add('is-scrolling-title');
    const distance = Math.max(0, entry.title.scrollWidth - entry.clip.clientWidth);
    if (distance < 2) {
      entry.row.classList.remove('is-scrolling-title');
      return;
    }
    // Linear and unhurried: 32ms per pixel keeps a long Chinese title readable, with a floor so a
    // one-character overflow does not flicker and a ceiling so nothing crawls for half a minute.
    const duration = Math.min(12_000, Math.max(1_200, distance * 32));
    entry.motion = entry.title.animate([
      { transform: 'translateX(0)' },
      { transform: `translateX(${-distance}px)` },
    ], { duration, delay: 300, easing: 'linear', fill: 'forwards' });
  }

  function activate(entry, withMotion) {
    if (menuAnchor || active === entry) return;
    deactivate();
    active = entry;
    entry.row.classList.add('is-reading');
    // Touch input has no hover, so the scroll would start and stop with the tap: skip it there.
    if (withMotion) scrollTitle(entry);
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
    // 归档 / 恢复 / 删除由 chatRowAction() 一处决定：临时聊天在这个位置是「删除」，
    // 不是「归档后再提示存不下来」。
    const action = chatRowAction(entry.chat);
    const actionItem = actionButton(action.verb, action.icon, 'chat-menu-item');
    openItem.append(node('span', '', '打开聊天'));
    actionItem.append(node('span', '', action.verb));
    openItem.addEventListener('click', () => { closeMenu(); entry.onOpen(); });
    actionItem.addEventListener('click', () => {
      closeMenu();
      if (action.kind === 'delete') entry.onDelete?.();
      else entry.onArchive();
    });
    menu.replaceChildren(openItem, actionItem);
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
    // The box changed, so the distance the title has left to travel changed with it.
    if (active.row.matches(':hover')) scrollTitle(active);
    else resetTitleShift(active.row);
  }).observe(sidebar);

  function create(project, chat, { selected, running, conversationKey, stamp, onOpen, onArchive, onDelete, temporary }) {
    // 临时聊天不落盘：行尾按钮换成「删除」，位置与交互不变，但点下去真的能删掉。
    const action = chatRowAction({ archived: chat.archived, temporary: temporary === true });
    const row = node('div', 'chat-row');
    row.classList.toggle('selected', selected);
    row.classList.toggle('is-running', Boolean(running));
    // The conversation key is what `activeReplies` is keyed by, so a running reply maps back to
    // its row without re-rendering the whole sidebar.
    row.dataset.chatKey = conversationKey || JSON.stringify([project.name, chat.title]);
    // `stamp` comes from the caller, which can fall back to the last turn's time for chats saved
    // before the timestamp fields existed. `data-updated-at` is also the sort key.
    const time = Number(stamp) || Number(chat.updatedAt || chat.createdAt) || 0;
    row.dataset.updatedAt = String(time);
    const open = node('button', 'chat-open');
    open.type = 'button';
    if (selected) open.setAttribute('aria-current', 'true');
    const clip = node('span', 'chat-title-window');
    const title = node('span', 'chat-title', chat.title);
    clip.append(title);
    open.append(clip);
    const actions = node('div', 'chat-row-actions');
    const more = actionButton(`${action.label}：${chat.title}`, action.icon);
    actions.append(more);
    const tail = node('div', 'chat-row-tail');
    const age = node('span', 'chat-time', chatAge(time));
    // A spinning ring marks a reply that is still being generated. It is always in the DOM and CSS
    // reveals it, so starting or stopping a reply is one class toggle instead of a re-render.
    const spinner = node('span', 'chat-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    tail.append(age, spinner, actions);
    row.append(open, tail);
    const entry = { row, open, clip, title, project, chat, more, onOpen, onArchive, onDelete };

    row.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') activate(entry, true); });
    row.addEventListener('pointerleave', () => { if (active === entry && !row.querySelector(':focus-visible')) deactivate(); });
    row.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) activate(entry, false); });
    row.addEventListener('focusout', event => { if (active === entry && !row.contains(event.relatedTarget) && !row.matches(':hover')) deactivate(); });
    open.addEventListener('click', onOpen);
    more.addEventListener('click', () => {
      close();
      if (action.kind === 'delete') onDelete?.();
      else onArchive();
    });
    return row;
  }

  /** Re-render every visible age from the row's own stamp, so the label and the sort key agree. */
  function refreshTimes() {
    for (const row of sidebar.querySelectorAll('.chat-row[data-updated-at]')) {
      const element = row.querySelector('.chat-time');
      if (element) element.textContent = chatAge(row.dataset.updatedAt);
    }
  }

  /**
   * Show or hide the running ring on the rows already on screen. Takes a predicate over the row's
   * `data-chat-key` so the caller owns what "running" means.
   */
  function syncRunning(isRunning) {
    for (const row of sidebar.querySelectorAll('.chat-row[data-chat-key]')) {
      row.classList.toggle('is-running', Boolean(isRunning(String(row.dataset.chatKey))));
    }
  }

  /**
   * Reorder the visible rows newest-first, in place. Rebuilding the list would jump the scroll
   * position every time a reply finishes, so the rows are moved instead of re-created.
   */
  function resort() {
    const parents = new Map();
    for (const row of sidebar.querySelectorAll('.chat-row[data-updated-at]')) {
      const parent = row.parentElement;
      if (!parent) continue;
      if (!parents.has(parent)) parents.set(parent, []);
      parents.get(parent).push(row);
    }
    for (const [parent, rows] of parents) {
      const sorted = [...rows].sort((a, b) => Number(b.dataset.updatedAt) - Number(a.dataset.updatedAt));
      if (sorted.every((row, index) => rows[index] === row)) continue;
      // Appending moves the nodes; the project header (if any) stays first. A row that was mid
      // scroll keeps a `fill: forwards` translate measured against its old box, so rewind it first.
      for (const row of sorted) {
        resetTitleShift(row);
        parent.append(row);
      }
    }
  }

  /** Mark a conversation as just used: stamp its row, refresh its age, float it to the top. */
  function touch(conversationKey, updatedAt) {
    const stamp = String(Number(updatedAt) || Date.now());
    for (const row of sidebar.querySelectorAll('.chat-row[data-chat-key]')) {
      if (row.dataset.chatKey !== conversationKey) continue;
      row.dataset.updatedAt = stamp;
      const element = row.querySelector('.chat-time');
      if (element) element.textContent = chatAge(stamp);
    }
    resort();
  }

  return { create, close, refreshTimes, syncRunning, resort, touch };
}
