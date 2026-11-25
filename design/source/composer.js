import { mountDeepAgentComposer } from './vendor/leibox/DeepAgentComposerEngine.js';
import darkStyles from './composer-dark.css?inline';

const darkTokens = {
  '--theme-accent': '#94aee9',
  '--theme-accent-hover': '#afc2f1',
  '--theme-bg': '#272727',
  '--theme-sidebar': '#222222',
  '--theme-elevated': '#2e2e2e',
  '--theme-fg': '#efefee',
  '--theme-text-secondary': '#a6a6a6',
  '--theme-border': '#434343',
  '--theme-hover': '#393939',
  '--theme-selection': '#3c4756',
};

export function mountComposer(target, options) {
  const instance = mountDeepAgentComposer(target, options);
  for (const [property, value] of Object.entries(darkTokens)) {
    instance.element.style.setProperty(property, value);
  }

  // Deep Agent uses an open shadow root and separate layers for popovers.
  for (const layer of instance.root.children) {
    if (layer.localName === 'div') layer.classList.add('dark');
  }

/* 输入栏图标：替换成更大、更圆润饱满的一组（加号 / 发送 / 停止）。 */
const BIG_ICONS = {
  plus: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none"><path d="M10 4.9v10.2M4.9 10h10.2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" /></svg>',
  send: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none"><path d="M10 15.2V4.9M5.6 9.3 10 4.9l4.4 4.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>',
  stop: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="5.4" y="5.4" width="9.2" height="9.2" rx="2.8" fill="currentColor" /></svg>',
};

function decorateComposerIcons(root) {
  const paint = () => {
    const add = root.querySelector('[aria-label="添加文件"]');
    if (add && add.dataset.movaIcon !== 'plus') { add.innerHTML = BIG_ICONS.plus; add.dataset.movaIcon = 'plus'; }
    const send = root.querySelector('.composer-send-btn');
    if (send) {
      const kind = /stop/.test(send.className) ? 'stop' : 'send';
      if (send.dataset.movaIcon !== kind) { send.innerHTML = BIG_ICONS[kind]; send.dataset.movaIcon = kind; }
    }
  };
  paint();
  const observer = new MutationObserver(paint);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-label'] });
  return () => observer.disconnect();
}

/* 权限按钮：标签一旦放不下（被截断）就收成单个图标，见 composer-dark.css 的 [data-mova-fit]。 */
function bindApprovalTriggerFit(root) {
  let frame = 0;

  const measure = () => {
    frame = 0;
    const trigger = [...root.querySelectorAll('.morph-menu-compact button')]
      .find(button => button.querySelector(':scope > span.truncate'));
    const label = trigger?.querySelector(':scope > span.truncate');
    if (!trigger || !label) return;

    // 已收起时先把标签放回布局里，才能量出“完整文字是否放得下”。
    const wasIcon = trigger.dataset.movaFit === 'icon';
    if (wasIcon) trigger.dataset.movaFit = 'wide';
    const clipped = label.scrollWidth > label.clientWidth + 1;
    const next = clipped ? 'icon' : 'wide';
    if (trigger.dataset.movaFit !== next) trigger.dataset.movaFit = next;

    const hint = clipped ? label.textContent.trim() : '';
    if (hint ? trigger.title !== hint : trigger.hasAttribute('title')) {
      if (hint) trigger.title = hint;
      else trigger.removeAttribute('title');
    }
  };

  const queue = () => { if (!frame) frame = requestAnimationFrame(measure); };

  // 输入栏宽度变化（窗口缩放、侧栏拖拽）和工具栏重渲染都要重新量一次。
  const surface = root.querySelector('[data-message-composer-surface]');
  const resize = new ResizeObserver(queue);
  if (surface) resize.observe(surface);
  else resize.observe(root.host);
  const mutations = new MutationObserver(queue);
  mutations.observe(root, { subtree: true, childList: true, characterData: true });
  queue();

  return () => { resize.disconnect(); mutations.disconnect(); if (frame) cancelAnimationFrame(frame); };
}
  const theme = target.ownerDocument.createElement('style');
  theme.textContent = darkStyles;
  instance.root.append(theme);
  decorateComposerIcons(instance.root);
  bindApprovalTriggerFit(instance.root);

  // 对话区变窄时收起「请求批准」，只留加号、模型选择与发送。
  const host = instance.root.host || instance.element;
  const syncCompact = () => {
    const width = host.getBoundingClientRect().width;
    if (!width) return;
    host.classList.toggle('mova-composer-no-approval', width < 400);
  };
  syncCompact();
  new ResizeObserver(syncCompact).observe(host);
  return instance;
}
