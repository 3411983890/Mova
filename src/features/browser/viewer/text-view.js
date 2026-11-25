// 纯文本渲染（方案 §3.4）：等宽、可换行、可选行号、复制、截断提示。

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function copyText(value) {
  const desktop = globalThis.window?.movaDesktop?.clipboard;
  if (desktop?.writeText) return (await desktop.writeText(value)) === true;
  if (!globalThis.navigator?.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function createTextView({ container }) {
  let text = '';
  let numbers = false;
  let timer = null;

  const root = element('div', 'text-view');
  const bar = element('div', 'code-view-bar');
  const langLabel = element('span', 'code-view-lang', 'text');
  const meta = element('span', 'code-view-meta');
  const actions = element('div', 'code-view-actions');
  const numbersButton = element('button', 'code-view-button', '行号');
  numbersButton.type = 'button';
  numbersButton.setAttribute('aria-pressed', 'false');
  const wrapButton = element('button', 'code-view-button', '换行');
  wrapButton.type = 'button';
  wrapButton.setAttribute('aria-pressed', 'true');
  const copyButton = element('button', 'code-view-button', '复制');
  copyButton.type = 'button';
  const status = element('span', 'code-view-status');
  status.setAttribute('role', 'status');
  actions.append(numbersButton, wrapButton, copyButton, status);
  bar.append(langLabel, meta, actions);

  const note = element('p', 'viewer-note');
  note.hidden = true;

  const pre = element('pre', 'viewer-text');
  const scroll = element('div', 'code-view-scroll');
  scroll.append(pre);
  root.append(bar, note, scroll);
  container.append(root);

  numbersButton.addEventListener('click', () => {
    numbers = !numbers;
    numbersButton.setAttribute('aria-pressed', String(numbers));
    paint();
  });
  wrapButton.addEventListener('click', () => {
    const next = wrapButton.getAttribute('aria-pressed') !== 'true';
    wrapButton.setAttribute('aria-pressed', String(next));
    root.classList.toggle('is-nowrap', !next);
  });
  copyButton.addEventListener('click', async () => {
    clearTimeout(timer);
    const ok = await copyText(text);
    status.textContent = ok ? '已复制' : '复制失败，请手动选择';
    timer = setTimeout(() => { status.textContent = ''; }, 2000);
  });

  function paint() {
    const lines = text.split('\n');
    if (!numbers) {
      pre.textContent = text;
      meta.textContent = `${lines.length} 行`;
      return;
    }
    const fragment = document.createDocumentFragment();
    lines.forEach((line, index) => {
      const row = element('span', 'text-line');
      const gutter = element('span', 'code-gutter', String(index + 1));
      gutter.setAttribute('aria-hidden', 'true');
      const content = element('span', 'text-line-content', line || ' ');
      row.append(gutter, content);
      fragment.append(row);
    });
    pre.replaceChildren(fragment);
    meta.textContent = `${lines.length} 行`;
  }

  return {
    element: root,
    render(input = {}) {
      text = String(input.text ?? '');
      numbers = false;
      numbersButton.setAttribute('aria-pressed', 'false');
      root.classList.remove('is-nowrap');
      wrapButton.setAttribute('aria-pressed', 'true');
      langLabel.textContent = input.label || 'text';
      note.textContent = input.note || '';
      note.hidden = !input.note;
      status.textContent = '';
      paint();
      if (Number(input.line) > 0) {
        pre.scrollTop = Math.max(0, (Number(input.line) - 1) * 21);
      }
    },
    dispose() {
      clearTimeout(timer);
      root.remove();
    },
  };
}
