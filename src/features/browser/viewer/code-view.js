// 代码渲染（方案 §3.6）：Shiki 的 JS 正则引擎 + token→DOM。
//
// 约束：IIFE 单文件构建 → 只能静态 import 语言包，不能动态 import / WASM / worker。
// 这里**不用** codeToHtml + innerHTML：`codeToTokens()` 拿到每行 token 后逐个建 span。
// highlighter 在第一次渲染代码文件时才创建（不在模块顶层），避免拖慢启动。

import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import langTsx from '@shikijs/langs/tsx';
import langHtml from '@shikijs/langs/html';
import langJson from '@shikijs/langs/json';
import langPython from '@shikijs/langs/python';
import langRust from '@shikijs/langs/rust';
import langGo from '@shikijs/langs/go';
import langJava from '@shikijs/langs/java';
import langC from '@shikijs/langs/c';
import langShell from '@shikijs/langs/shellscript';
import langYaml from '@shikijs/langs/yaml';
import langSql from '@shikijs/langs/sql';
import langXml from '@shikijs/langs/xml';

export const MAX_HIGHLIGHT_LINES = 5000;

/**
 * 代码语义色（方案 §3.6 的 token 表）。属于内容层语义色，
 * 不参与界面 chrome；`#181818` 上均 ≥ 4.5:1。
 */
export const MOVA_CODE_THEME = Object.freeze({
  name: 'mova-dark',
  type: 'dark',
  colors: { 'editor.foreground': '#d6d6d6', 'editor.background': '#181818' },
  settings: [
    { settings: { foreground: '#d6d6d6', background: '#181818' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#7f8a86', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'variable.language'], settings: { foreground: '#7fa7e8' } },
    { scope: ['string', 'string.template', 'constant.character'], settings: { foreground: '#a8c98a' } },
    { scope: ['constant.numeric', 'constant.language', 'support.constant', 'constant.other'], settings: { foreground: '#d8b06a' } },
    { scope: ['entity.name.function', 'support.function', 'variable.function', 'meta.function-call'], settings: { foreground: '#c9b6f2' } },
    { scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'support.type', 'support.class', 'storage.type.primitive'], settings: { foreground: '#72c7c2' } },
    { scope: ['entity.name.tag', 'support.class.component', 'meta.tag'], settings: { foreground: '#e0a08c' } },
    { scope: ['entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key', 'variable.other.property'], settings: { foreground: '#d3b6f0' } },
    { scope: ['punctuation', 'keyword.operator', 'meta.brace'], settings: { foreground: '#9a9a9a' } },
    { scope: ['string.regexp', 'constant.character.escape', 'constant.other.character-class.regexp'], settings: { foreground: '#d7a06a' } },
  ],
});

const LANGS = [
  langTsx, langHtml, langJson, langPython, langRust, langGo,
  langJava, langC, langShell, langYaml, langSql, langXml,
];

// location.js 已经把扩展名映射成上面这些 grammar 名；别名表只是兜底。
const LANG_ALIAS = Object.freeze({
  ts: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascriptreact: 'javascript',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  scss: 'css',
  less: 'css',
  jsonc: 'json',
  bash: 'shellscript',
  zsh: 'shellscript',
  sh: 'shellscript',
  yml: 'yaml',
  cpp: 'c',
});

let highlighter = null;
let highlighterFailed = false;

function getHighlighter() {
  if (highlighter || highlighterFailed) return highlighter;
  try {
    highlighter = createHighlighterCoreSync({
      langs: LANGS,
      themes: [MOVA_CODE_THEME],
      engine: createJavaScriptRegexEngine(),
      langAlias: { ...LANG_ALIAS },
      warnings: false,
    });
  } catch (error) {
    highlighterFailed = true;
    console.warn('[viewer] 代码高亮初始化失败，退回纯文本：', error?.message);
  }
  return highlighter;
}

/** 语言是否已经内置高亮（供 UI 显示“未内置”提示）。 */
export function hasLanguage(lang) {
  if (!lang) return false;
  const instance = getHighlighter();
  if (!instance) return false;
  try {
    return instance.getLoadedLanguages().includes(String(lang));
  } catch {
    return false;
  }
}

function plainTokens(text) {
  return text.split('\n').map(line => (line ? [{ content: line }] : []));
}

/** 代码 → 每行 token 数组；高亮不可用时退回纯文本。 */
export function highlightLines(text, lang) {
  const source = String(text ?? '');
  const instance = getHighlighter();
  if (!instance) return { lines: plainTokens(source), highlighted: false };
  try {
    const result = instance.codeToTokens(source, { lang: lang || 'text', theme: MOVA_CODE_THEME.name });
    return { lines: result?.tokens || plainTokens(source), highlighted: true };
  } catch {
    return { lines: plainTokens(source), highlighted: false };
  }
}

function tokenSpan(token) {
  const span = document.createElement('span');
  span.textContent = token.content;
  if (token.color) span.style.color = token.color;
  const style = Number(token.fontStyle);
  if (style & 1) span.style.fontStyle = 'italic';
  if (style & 2) span.style.fontWeight = '700';
  if (style & 4) span.style.textDecoration = 'underline';
  return span;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function copyText(value) {
  const desktop = globalThis.window?.movaDesktop?.clipboard;
  if (desktop?.writeText) {
    if (await desktop.writeText(value) === true) return true;
    return false;
  }
  if (!globalThis.navigator?.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ container: HTMLElement }} options
 */
export function createCodeView({ container }) {
  let text = '';
  let wrap = false;
  let timer = null;

  const root = element('div', 'code-view');
  const bar = element('div', 'code-view-bar');
  const langLabel = element('span', 'code-view-lang');
  const meta = element('span', 'code-view-meta');
  const actions = element('div', 'code-view-actions');
  const wrapButton = element('button', 'code-view-button', '换行');
  wrapButton.type = 'button';
  wrapButton.setAttribute('aria-pressed', 'false');
  wrapButton.title = '切换自动换行';
  const copyButton = element('button', 'code-view-button', '复制');
  copyButton.type = 'button';
  copyButton.title = '复制全文';
  const status = element('span', 'code-view-status');
  status.setAttribute('role', 'status');
  actions.append(wrapButton, copyButton, status);
  bar.append(langLabel, meta, actions);

  const note = element('p', 'viewer-note');
  note.hidden = true;

  const scroll = element('div', 'code-view-scroll');
  const body = element('div', 'code-view-body');
  scroll.append(body);
  root.append(bar, note, scroll);
  container.append(root);

  wrapButton.addEventListener('click', () => {
    wrap = !wrap;
    wrapButton.setAttribute('aria-pressed', String(wrap));
    root.classList.toggle('is-wrap', wrap);
  });

  copyButton.addEventListener('click', async () => {
    clearTimeout(timer);
    const ok = await copyText(text);
    status.textContent = ok ? '已复制' : '复制失败，请手动选择';
    timer = setTimeout(() => { status.textContent = ''; }, 2000);
  });

  function renderLines(lines) {
    const fragment = document.createDocumentFragment();
    lines.forEach((tokens, index) => {
      const line = element('div', 'code-line');
      line.id = `L${index + 1}`;
      line.dataset.line = String(index + 1);
      const gutter = element('span', 'code-gutter', String(index + 1));
      gutter.setAttribute('aria-hidden', 'true');
      const code = element('span', 'code-text');
      if (!tokens.length) code.append(document.createTextNode('\n'));
      for (const token of tokens) code.append(tokenSpan(token));
      line.append(gutter, code);
      fragment.append(line);
    });
    body.replaceChildren(fragment);
  }

  return {
    element: root,
    /**
     * @param {{ text: string, language?: string, label?: string, line?: number, note?: string }} input
     */
    render(input = {}) {
      text = String(input.text ?? '');
      const { lines, highlighted } = highlightLines(text, input.language);
      renderLines(lines);
      langLabel.textContent = input.label || input.language || 'text';
      langLabel.title = highlighted ? `已高亮：${input.language}` : '该语言未内置高亮，按纯文本显示';
      meta.textContent = `${lines.length} 行`;
      const messages = [];
      if (input.note) messages.push(input.note);
      if (!highlighted && input.language && input.language !== 'text') messages.push('该语言未内置高亮，已按纯文本显示。');
      note.textContent = messages.join(' ');
      note.hidden = messages.length === 0;
      status.textContent = '';
      if (Number(input.line) > 0) {
        const target = body.querySelector(`#L${Number(input.line)}`);
        if (target) {
          target.scrollIntoView({ block: 'center' });
          target.classList.add('is-flash');
          setTimeout(() => target.classList.remove('is-flash'), 240);
        }
      }
    },
    dispose() {
      clearTimeout(timer);
      root.remove();
    },
  };
}
