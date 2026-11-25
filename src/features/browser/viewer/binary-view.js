// 二进制信息页（方案 §3.4）：类型、大小、前 2KB 十六进制 + 在资源管理器中显示。
import { icon } from '../../../shared/icons.js';
import { formatSize } from '../location.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hex(value) {
  return value.toString(16).padStart(2, '0');
}

function dump(bytes) {
  const rows = [];
  const limit = Math.min(bytes.length, 2048);
  for (let offset = 0; offset < limit; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, limit));
    const hexPart = [...chunk].map(hex).join(' ').padEnd(47, ' ');
    const asciiPart = [...chunk].map(byte => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart}  ${asciiPart}`);
  }
  return rows.join('\n');
}

export function createBinaryView({ container, onReveal }) {
  const root = element('div', 'binary-view');
  const card = element('div', 'binary-card');
  const heading = element('div', 'binary-head');
  const glyph = (() => {
    try { return icon('file'); } catch { return element('i', 'binary-icon'); }
  })();
  glyph.classList.add('binary-icon');
  glyph.setAttribute('aria-hidden', 'true');
  const title = element('strong', 'binary-title');
  heading.append(glyph, title);
  const meta = element('dl', 'binary-meta');
  const hexBlock = element('pre', 'binary-hex');
  const actions = element('div', 'binary-actions');
  const reveal = element('button', 'binary-button', '在资源管理器中显示');
  reveal.type = 'button';
  reveal.addEventListener('click', () => onReveal?.());
  actions.append(reveal);
  card.append(heading, meta, hexBlock, actions);
  root.append(card);
  container.append(root);

  return {
    element: root,
    render(input = {}) {
      title.textContent = input.name || '二进制文件';
      meta.replaceChildren();
      const rows = [
        ['类型', input.mime || 'application/octet-stream'],
        ['大小', formatSize(input.bytes)],
      ];
      if (input.truncated) rows.push(['预览', `前 ${formatSize(2048)} 的十六进制`]);
      for (const [key, value] of rows) {
        meta.append(element('dt', null, key), element('dd', null, value));
      }
      const bytes = base64ToBytes(input.base64);
      hexBlock.textContent = bytes.length ? dump(bytes) : '（空文件）';
      reveal.hidden = !onReveal;
    },
    dispose() {
      root.remove();
    },
  };
}
