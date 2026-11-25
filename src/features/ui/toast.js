import './toast.css';

/* 右下角提示（toast）：成功、失败、状态反馈统一走这里，页面内不再插入提示行。
   同一时刻最多堆叠 3 条，5 秒自动消失；悬停暂停计时。 */

const MAX_VISIBLE = 3;
let stack;

function ensureStack() {
  if (stack?.isConnected) return stack;
  stack = document.createElement('div');
  stack.className = 'mova-toast-stack';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-atomic', 'false');
  document.body.append(stack);
  return stack;
}

function dismiss(node) {
  if (!node?.isConnected) return;
  node.dataset.leaving = 'true';
  const remove = () => node.remove();
  node.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 260);
}

/** @param {string} message @param {{ tone?: 'default'|'ok'|'error', duration?: number }} options */
export function notify(message, options = {}) {
  const text = String(message ?? '').trim();
  if (!text) return undefined;
  const host = ensureStack();
  const node = document.createElement('div');
  node.className = 'mova-toast';
  node.dataset.tone = options.tone ?? 'default';
  const body = document.createElement('span');
  body.className = 'mova-toast-text';
  body.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'mova-toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss(node));
  node.append(body, close);
  host.append(node);

  while (host.children.length > MAX_VISIBLE) dismiss(host.firstElementChild);

  let timer = setTimeout(() => dismiss(node), options.duration ?? 3000);
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', () => { timer = setTimeout(() => dismiss(node), 1600); });
  return node;
}

export const notifyOk = message => notify(message, { tone: 'ok' });
export const notifyError = message => notify(message, { tone: 'error' });
