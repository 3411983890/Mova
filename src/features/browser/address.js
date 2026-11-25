// 地址栏 = 位置栏 + 面包屑（方案 §3.3）。
//
// 三种稳定态共用同一个胶囊（26px / 11px / #2b2b2b，数值不变）：
//   web  → 仍然是一个 URL 输入框（现状）
//   file → `项目 › src › app.js`，末段 aria-current，上级段可点进目录
//   dir  → `项目 › src` + 尾部弱化条目数
// 窄宽时从左折叠成 `…`（点击弹出被折叠的段）；聚焦/点击空白变回输入框，
// Enter 打开、Esc 还原。这里只负责渲染与态切换，路径解析交给 side-browser。

import { icon } from '../../shared/icons.js';
import { DIR, WEB, breadcrumbOf, editValueOf, foldBreadcrumb, kindIcon, truncateText } from './location.js';

const SEPARATOR = '›';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{
 *   form: HTMLFormElement,
 *   input: HTMLInputElement,
 *   icon: HTMLElement,
 *   onNavigate?: (loc: object) => void,
 *   onSubmit?: (value: string) => void,
 * }} options
 */
export function mountAddress({ form, input, icon: initialIcon, onNavigate, onSubmit }) {
  const nav = element('nav', 'browser-crumbs');
  nav.setAttribute('aria-label', '当前位置');
  nav.hidden = true;
  form.insertBefore(nav, input);

  const menu = element('div', 'browser-crumbs-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '被折叠的路径');
  form.append(menu);

  let currentIcon = initialIcon || null;
  let iconName = '';
  let location = null;
  let rootName = '';
  let entryCount = -1;
  let editing = false;
  let placeholderOverride = '';
  let crumbsInView = [];

  function setIcon(kind) {
    const name = kindIcon(kind);
    if (!currentIcon || name === iconName) return;
    iconName = name;
    let next;
    try {
      next = icon(name);
    } catch {
      return; // 缺图标不影响功能，保留旧图标。
    }
    next.classList.add('browser-address-icon');
    next.setAttribute('aria-hidden', 'true');
    currentIcon.replaceWith(next);
    currentIcon = next;
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    nav.querySelector('.browser-crumb-more')?.setAttribute('aria-expanded', 'false');
  }

  function openMenu(anchor, hiddenCrumbs) {
    menu.replaceChildren();
    for (const crumb of hiddenCrumbs) {
      const item = element('button', 'browser-crumbs-menu-item', crumb.label);
      item.type = 'button';
      item.title = crumb.label;
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        if (crumb.loc) onNavigate?.(crumb.loc);
      });
      menu.append(item);
    }
    menu.hidden = false;
    anchor?.setAttribute('aria-expanded', 'true');
  }

  function makeMoreGroup() {
    const group = element('span', 'browser-crumb-group is-ellipsis');
    group.hidden = true;
    const more = element('button', 'browser-crumb-more', '…');
    more.type = 'button';
    more.title = '显示被折叠的路径';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!menu.hidden) { closeMenu(); return; }
      // 以 DOM 实际折叠结果为准：字符预算折叠的段没有节点，像素折叠的段 hidden。
      const shown = new Set(
        [...nav.querySelectorAll('.browser-crumb-group[data-crumb-index]')]
          .filter(node => !node.hidden)
          .map(node => Number(node.dataset.crumbIndex)),
      );
      const hiddenCrumbs = crumbsInView.filter((_, index) => !shown.has(index));
      openMenu(more, hiddenCrumbs);
    });
    group.append(more, element('span', 'browser-crumb-sep', SEPARATOR));
    return group;
  }

  function renderCrumbs() {
    nav.replaceChildren();
    const crumbs = breadcrumbOf(location, { rootName });
    // 很深的路径先按字符预算收一刀，避免为几十个节点反复测量。
    const folded = crumbs.length > 10 ? foldBreadcrumb(crumbs, 60) : { visible: crumbs.map(crumb => ({ type: 'crumb', crumb })) };
    crumbsInView = folded.visible.filter(node => node.type === 'crumb').map(node => node.crumb);
    let moreGroup = null;
    folded.visible.forEach(node => {
      if (node.type === 'ellipsis') {
        moreGroup = makeMoreGroup();
        nav.append(moreGroup);
        return;
      }
      const { crumb } = node;
      const index = crumbsInView.indexOf(crumb);
      const group = element('span', 'browser-crumb-group');
      group.dataset.crumbIndex = String(index);
      if (crumb.current) {
        const current = element('span', 'browser-crumb is-current', truncateText(crumb.label, 80));
        current.setAttribute('aria-current', 'page');
        current.title = crumb.label;
        group.append(current);
      } else {
        const button = element('button', 'browser-crumb', crumb.label);
        button.type = 'button';
        button.title = `打开 ${crumb.label}`;
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (crumb.loc) onNavigate?.(crumb.loc);
        });
        group.append(button, element('span', 'browser-crumb-sep', SEPARATOR));
      }
      nav.append(group);
    });
    if (!moreGroup) {
      // 字符预算没折叠时也要有 `…` 节点，供像素折叠使用（插在根名之后）。
      moreGroup = makeMoreGroup();
      nav.insertBefore(moreGroup, nav.children[1] || null);
    }
    if (location.kind === DIR) {
      const count = element('span', 'browser-crumb-count');
      count.dataset.count = String(entryCount);
      count.textContent = entryCount >= 0 ? `${entryCount} 项` : '';
      count.hidden = entryCount < 0;
      nav.append(count);
    }
    fit();
  }

  /** 从左侧折叠：根名与末段保留，中间按可用宽度逐个收回。 */
  function fit() {
    if (nav.hidden) return;
    const groups = [...nav.querySelectorAll('.browser-crumb-group[data-crumb-index]')];
    const more = nav.querySelector('.browser-crumb-group.is-ellipsis');
    if (!more) return;
    if (groups.length <= 2) {
      more.hidden = true;
      return;
    }
    const middle = groups.slice(1, -1);
    if (!middle.length) return;
    const overflow = () => nav.scrollWidth > nav.clientWidth + 1;
    middle.forEach(group => { group.hidden = false; });
    more.hidden = false;
    if (!overflow()) {
      more.hidden = true;
      return;
    }
    middle.forEach(group => { group.hidden = true; });
    for (let index = middle.length - 1; index >= 0; index -= 1) {
      middle[index].hidden = false;
      if (overflow()) middle[index].hidden = true;
      else break;
    }
  }

  function setInputValue() {
    input.value = editValueOf(location);
  }

  function showInput() {
    nav.hidden = true;
    menu.hidden = true;
    input.hidden = false;
  }

  function showCrumbs() {
    input.hidden = true;
    nav.hidden = false;
    renderCrumbs();
  }

  function applyPlaceholder(value) {
    input.placeholder = value || placeholderOverride || '网址或文件位置';
  }

  function enterEdit() {
    if (!location || editing) return;
    if (location.kind === WEB) {
      input.focus();
      input.select?.();
      return;
    }
    editing = true;
    form.classList.add('is-editing');
    showInput();
    input.value = editValueOf(location);
    applyPlaceholder(location.kind === DIR ? '相对路径，例如 src' : '相对路径，例如 src/app.js');
    input.focus();
    input.select?.();
  }

  function exitEdit(options = {}) {
    if (!editing) return;
    editing = false;
    form.classList.remove('is-editing');
    applyPlaceholder('');
    if (options.keepFocus === true) input.blur();
    if (!location || location.kind === WEB) {
      setInputValue();
      input.hidden = false;
      nav.hidden = true;
      return;
    }
    setInputValue();
    showCrumbs();
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    if (editing) {
      editing = false;
      form.classList.remove('is-editing');
    }
    onSubmit?.(value);
  });

  input.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    exitEdit({ keepFocus: true });
  });

  input.addEventListener('blur', () => {
    // 提交由 submit 处理；失焦只是还原稳定态。
    setTimeout(() => {
      if (document.activeElement === input) return;
      if (!editing) return;
      exitEdit();
    }, 0);
  });

  form.addEventListener('click', event => {
    if (event.target.closest('[data-share]')) return;
    if (event.target.closest('.browser-crumb-more')) return;
    if (event.target.closest('.browser-crumb:not(.is-current)')) return;
    if (event.target.closest('.browser-crumbs-menu')) return;
    if (!location || location.kind === WEB) return;
    if (event.target === input) return;
    event.preventDefault();
    enterEdit();
  });

  form.addEventListener('focusin', event => {
    if (event.target !== input) return;
    if (!location || location.kind === WEB) return;
    if (!editing) enterEdit();
  });

  document.addEventListener('pointerdown', event => {
    if (menu.hidden) return;
    if (form.contains(event.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu();
  });

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  observer?.observe(form);

  return {
    /** 位置或元信息变化后调用；`options.rootName` / `options.entryCount`。 */
    setLocation(loc, options = {}) {
      location = loc || null;
      if (options.rootName !== undefined) rootName = options.rootName;
      if (options.entryCount !== undefined) entryCount = Number(options.entryCount);
      if (options.placeholder !== undefined) {
        placeholderOverride = options.placeholder || '';
        applyPlaceholder('');
      }
      editing = false;
      form.classList.remove('is-editing');
      closeMenu();
      if (!location) {
        setIcon('web');
        input.value = '';
        nav.hidden = true;
        input.hidden = false;
        applyPlaceholder('');
        return;
      }
      setIcon(location.kind);
      if (location.kind === WEB) {
        input.value = location.url;
        nav.hidden = true;
        input.hidden = false;
        applyPlaceholder('');
        return;
      }
      setInputValue();
      showCrumbs();
    },
    setEntryCount(count) {
      entryCount = Number(count);
      if (!nav.hidden) renderCrumbs();
    },
    clear() {
      this.setLocation(null);
    },
    isEditing() {
      return editing;
    },
    enterEdit,
    exitEdit,
    fit,
    focus() {
      input.focus();
    },
    dispose() {
      observer?.disconnect();
      menu.remove();
      nav.remove();
    },
  };
}
