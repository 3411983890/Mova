import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownContent, safeMarkdownUrl } from './markdown.jsx';
import { openImageLightbox } from '../media/image-lightbox.js';
import { computeLineDiff } from '../approvals/diff.js';
import { shouldRenderImage } from './trace-image.mjs';
import { decideTarget, openFileExternally, openInPanel } from './open-target.mjs';
import './tool-image.css';
import {
  Atom, Brain, ChevronDown, CircleX, FileText, FolderOpen, Lightbulb, Message, PenLine, Search, Terminal,
} from '@keyline-icons/react';

/* ─── Website Brand Icons (16×16 crisp SVGs matching the reference video) ─── */
function SiteIcon({ site }) {
  switch (site) {
    case 'reddit':
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7.2" fill="#FF4500" />
          <circle cx="4.3" cy="8.2" r="1.35" fill="#FF4500" stroke="#1a1a1a" strokeWidth="0.7" />
          <circle cx="11.7" cy="8.2" r="1.35" fill="#FF4500" stroke="#1a1a1a" strokeWidth="0.7" />
          <ellipse cx="8" cy="9.1" rx="4.2" ry="3.1" fill="#1a1a1a" />
          <circle cx="6.45" cy="8.65" r="0.85" fill="#FF4500" />
          <circle cx="9.55" cy="8.65" r="0.85" fill="#FF4500" />
          <path d="M6.4 10.55c.45.42 1.02.63 1.6.63.58 0 1.15-.21 1.6-.63" stroke="#FF4500" strokeWidth="0.85" strokeLinecap="round" />
          <path d="M8 6L8.85 3.65L10.9 4.1" stroke="#1a1a1a" strokeWidth="0.95" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="11.35" cy="4.2" r="0.95" fill="#1a1a1a" />
        </svg>
      );
    case 'linkedin':
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.2" y="1.2" width="13.6" height="13.6" rx="2.6" fill="#3B82F6" />
          <circle cx="5.05" cy="5.0" r="1.05" fill="#14181D" />
          <rect x="4.15" y="6.75" width="1.8" height="5.25" rx="0.3" fill="#14181D" />
          <path d="M7.35 6.75h1.7v.78c.34-.54.96-.92 1.78-.92 1.32 0 2.07.82 2.07 2.38V12h-1.82V9.32c0-.74-.3-1.16-.92-1.16-.66 0-1.01.44-1.01 1.18V12H7.35V6.75Z" fill="#14181D" />
        </svg>
      );
    case 'github':
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 1C4.13 1 1 4.13 1 8c0 3.1 2.01 5.72 4.79 6.65.35.06.48-.15.48-.34 0-.17-.01-.72-.01-1.31-1.76.32-2.21-.43-2.35-.82-.08-.2-.42-.82-.72-.99-.25-.13-.6-.46-.01-.47.55-.01.95.51 1.08.72.63 1.06 1.64.76 2.04.58.06-.46.25-.76.45-.94-1.56-.18-3.19-.78-3.19-3.46 0-.76.27-1.39.72-1.88-.07-.18-.32-.9.07-1.86 0 0 .59-.19 1.93.72a6.5 6.5 0 0 1 3.52 0c1.34-.91 1.93-.72 1.93-.72.39.96.14 1.68.07 1.86.45.49.72 1.12.72 1.88 0 2.69-1.64 3.28-3.2 3.46.25.22.47.64.47 1.3 0 .94-.01 1.69-.01 1.93 0 .19.13.41.48.34A7.003 7.003 0 0 0 15 8c0-3.87-3.13-7-7-7Z"
            fill="#F0F3F6"
          />
        </svg>
      );
    case 'figma':
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7.2" fill="#231918" />
          <path d="M6.2 2.9h1.8v3.4H6.2a1.7 1.7 0 1 1 0-3.4Z" stroke="#E04F44" strokeWidth="1.15" />
          <path d="M8 2.9h1.8a1.7 1.7 0 1 1 0 3.4H8V2.9Z" stroke="#E04F44" strokeWidth="1.15" />
          <path d="M6.2 6.3h1.8v3.4H6.2a1.7 1.7 0 1 1 0-3.4Z" stroke="#E04F44" strokeWidth="1.15" />
          <path d="M6.2 9.7h1.8v1.7a1.7 1.7 0 1 1-1.8-1.7Z" stroke="#E04F44" strokeWidth="1.15" />
          <circle cx="9.75" cy="8" r="1.7" stroke="#E04F44" strokeWidth="1.15" />
        </svg>
      );
    case 'notion':
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.6 3.15 10.65 2.4c.52-.05.98.12 1.36.42l1.62 1.22c.24.19.37.44.37.76v8.28c0 .58-.42 1.02-1.02 1.06l-8.42.54c-.58.04-1.02-.22-1.28-.66L2.15 12.1c-.16-.28-.23-.58-.23-.92V3.95c0-.46.26-.76.68-.8Z" fill="#1a1a1a" stroke="#ececec" strokeWidth="1.15" />
          <path d="M4.2 4.65 12.8 4.1v8.75l-8.6.55V4.65Z" fill="#ececec" />
          <path d="M6.15 11.45V6.3h1.18l2.22 3.42V6.15h1.08v5.15H9.52L7.22 7.82v3.63H6.15Z" fill="#1a1a1a" />
          <path d="M2.35 3.45 4.2 4.65" stroke="#ececec" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case 'x':
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7.2" fill="#222222" />
          <path d="M9.14 7.08 12.78 2.9h-.87L8.74 6.53 6.22 2.9H3.28l3.82 5.48L3.28 12.8h.87l3.34-3.84 2.67 3.84h2.94L9.14 7.08Zm-1.18 1.36-.39-.55-3.09-4.35h1.33l2.5 3.52.39.55 3.25 4.58H10.6L7.96 8.44Z" fill="#eeeeee" />
        </svg>
      );
    default:
      return (
        <svg className="site-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="#9e9e9e" strokeWidth="1.2" />
          <path d="M2 8h12M8 1.5c1.8 1.8 2.7 4 2.7 6.5S9.8 12.7 8 14.5C6.2 12.7 5.3 10.5 5.3 8S6.2 3.3 8 1.5Z" stroke="#9e9e9e" strokeWidth="1.1" />
        </svg>
      );
  }
}

/* ─── Step Leading Icons ─── */
function SearchStepIcon() {
  return <Search size={13} aria-hidden="true" />;
}

function BulbStepIcon() {
  return <Lightbulb size={13} aria-hidden="true" />;
}

function XStepIcon() {
  return <CircleX size={13} aria-hidden="true" />;
}

function RedditStepIcon() {
  return <SiteIcon site="reddit" />;
}

/* Atom / Orbit icon for `思考` */
function ThoughtAtomIcon() {
  return <Atom size={13} aria-hidden="true" />;
}

/* Real site favicon, resolved by the desktop main process and cached per host. */
const faviconCache = new Map();

function hostOf(url) {
  try {
    const link = new URL(url);
    return link.protocol === 'https:' || link.protocol === 'http:' ? link.hostname : '';
  } catch {
    return '';
  }
}

function useSiteFavicon(url) {
  const host = hostOf(url);
  const [icon, setIcon] = useState(() => (host ? faviconCache.get(host) ?? null : null));

  useEffect(() => {
    if (!host) return undefined;
    if (faviconCache.has(host)) {
      setIcon(faviconCache.get(host));
      return undefined;
    }
    const request = window.movaDesktop?.siteIcon;
    if (!request) return undefined;
    let alive = true;
    request(host).then(value => {
      const resolved = value || null;
      faviconCache.set(host, resolved);
      if (alive) setIcon(resolved);
    }).catch(() => { faviconCache.set(host, null); });
    return () => { alive = false; };
  }, [host]);

  return icon;
}

function SiteBadge({ source }) {
  const icon = useSiteFavicon(source?.url);
  if (icon) {
    return <img className="site-icon site-favicon" src={icon} alt="" aria-hidden="true" width="16" height="16" />;
  }
  return <SiteIcon site={source?.site} />;
}

/* File / Document icon for `读取图片` */
function FileDocIcon() {
  return <FileText size={13} aria-hidden="true" />;
}

const ROW_ICONS = {
  run: Terminal,
  read: Message,
  search: SearchStepIcon,
  bulb: BulbStepIcon,
  x: XStepIcon,
  reddit: RedditStepIcon,
  thought: ThoughtAtomIcon,
  image: FileDocIcon,
  folder: FolderOpen,
  file: FileText,
  edit: PenLine,
  denied: CircleX,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Shared 60/120fps reversible progress driver (`p` in `[0, 1]`).
 * Drives `思考`, `运行命令`, `读取图片`, and `来源` with the exact same smooth
 * unrolling curve and mid-flight reversal capability.
 */
function useAnimatedProgress(open, expandMs = 520, collapseMs = 440) {
  const [progress, setProgress] = useState(open ? 1 : 0);
  const animRef = useRef({ raf: 0, p: open ? 1 : 0, target: open ? 1 : 0 });

  useEffect(() => {
    const state = animRef.current;
    state.target = open ? 1 : 0;
    if (state.raf) cancelAnimationFrame(state.raf);

    const startP = state.p;
    const targetP = state.target;
    if (Math.abs(targetP - startP) < 0.001) {
      state.p = targetP;
      setProgress(targetP);
      return;
    }

    const duration = (targetP > startP ? expandMs : collapseMs) * Math.abs(targetP - startP);
    const startTime = performance.now();
    const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const tick = (now) => {
      const elapsed = now - startTime;
      const rawT = clamp(elapsed / Math.max(1, duration), 0, 1);
      const eased = easeInOut(rawT);
      const nextP = startP + (targetP - startP) * eased;
      state.p = nextP;
      setProgress(nextP);

      if (rawT < 1) {
        state.raf = requestAnimationFrame(tick);
      } else {
        state.p = targetP;
        state.raf = 0;
        setProgress(targetP);
      }
    };

    state.raf = requestAnimationFrame(tick);
    return () => {
      if (state.raf) cancelAnimationFrame(state.raf);
    };
  }, [open, expandMs, collapseMs]);

  return progress;
}

/**
 * Measures the natural inner height of an expandable body so its viewport
 * can smoothly interpolate `height: p * naturalHeight` while the inner content
 * unrolls from beneath the header (`translateY(-(1 - p) * offset)` + blur + opacity).
 */
function useMeasuredHeight(deps = []) {
  const innerRef = useRef(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const node = innerRef.current;
    if (!node) return undefined;
    const measure = () => {
      setHeight(node.scrollHeight || node.offsetHeight || 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, deps);

  return [innerRef, height];
}

/* Helper to render inline backtick code pills like `.mova-row-button` */
function renderInlineCode(text) {
  const parts = String(text).split(/(`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={idx} className="thought-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/**
 * 1. `思考` Row:
 * Uses the same zipper/unroll animation as `来源`:
 * - As `p` goes `0 -> 1`, the inline summary on the header smoothly fades/slides out,
 *   while the viewport height grows `0 -> H` and each paragraph unrolls downward from
 *   beneath the `思考` header with staggered `u_i = p * M - (M - 1 - i)`, blur-to-crisp,
 *   and opacity fade!
 */
function ThoughtRow({ item }) {
  const [open, setOpen] = useState(Boolean(item.defaultOpen));
  const p = useAnimatedProgress(open, 500, 420);
  const paragraphs = item.paragraphs || (item.text ? item.text.split(/\n\s*\n/) : []);
  const summaryText = item.summary || (paragraphs[0] ? String(paragraphs[0]).replace(/`/g, '') : '');
  const [innerRef, naturalHeight] = useMeasuredHeight([paragraphs.length]);

  const totalBlocks = Math.max(1, paragraphs.length);
  const s = p * totalBlocks;
  const summaryOpacity = clamp(1 - p * 2.4, 0, 1);
  const summaryShift = -p * 10;
  const currentHeight = p * naturalHeight;

  return (
    <li className="act-item act-trace-block" data-open={open}>
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="trace-lead-icon" data-open={open}>
          <span className="trace-icon-default">
            <ThoughtAtomIcon />
          </span>
          <span className="trace-icon-chevron">
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </span>
        <span className="trace-title">思考</span>
        {summaryText && summaryOpacity > 0.01 && (
          <span
            className="trace-summary-inline"
            style={{
              opacity: summaryOpacity.toFixed(3),
              transform: `translate3d(${summaryShift.toFixed(1)}px, 0, 0)`,
            }}
          >
            <span className="trace-dot">·</span>
            <span className="trace-summary">{summaryText}</span>
          </span>
        )}
      </button>

      <div
        className="trace-unroll-viewport"
        style={{
          height: `${currentHeight.toFixed(2)}px`,
          pointerEvents: p > 0.05 ? 'auto' : 'none',
        }}
        aria-hidden={!open && p < 0.02}
      >
        <div
          ref={innerRef}
          className="thought-body"
          style={{
            transform: `translate3d(0, ${(-(1 - p) * 22).toFixed(2)}px, 0)`,
          }}
        >
          <div className="thought-paragraphs">
            {paragraphs.map((para, idx) => {
              const u = s - (totalBlocks - 1 - idx);
              const itemOpacity = clamp((u + 0.15) / 0.85, 0, 1);
              const itemBlur = (1 - itemOpacity) * 2.2;
              const itemY = (1 - clamp(u, 0, 1)) * -14;

              return (
                <p
                  key={idx}
                  className="thought-paragraph"
                  style={{
                    opacity: itemOpacity.toFixed(3),
                    transform: `translate3d(0, ${itemY.toFixed(2)}px, 0)`,
                    filter: itemBlur > 0.08 ? `blur(${itemBlur.toFixed(2)}px)` : 'none',
                  }}
                >
                  {renderInlineCode(para)}
                </p>
              );
            })}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * 2. `运行命令` Row:
 * Uses the same zipper/unroll animation:
 * - Viewport smoothly interpolates `height: 0 -> H` with top fade mask.
 * - The terminal card unrolls from beneath the `运行命令` header while each
 *   `$ ` command line and stdout line cascades in with staggered slide + blur-to-crisp!
 */
function CommandRow({ item }) {
  const [open, setOpen] = useState(Boolean(item.defaultOpen));
  const [copied, setCopied] = useState(false);
  const p = useAnimatedProgress(open, 500, 420);
  const commands = item.commands || [];
  const output = item.output || [];
  const title = item.title || item.label || '';
  const [innerRef, naturalHeight] = useMeasuredHeight([commands.length, output.length]);

  const totalLines = commands.length + output.length;
  const s = p * Math.max(1, totalLines);
  const currentHeight = p * naturalHeight;
  const cardOpacity = clamp(p * 1.45, 0, 1);
  const cardY = -(1 - p) * 26;
  const cardBlur = (1 - clamp(p * 1.25, 0, 1)) * 2.2;

  const handleCopy = (e) => {
    e.stopPropagation();
    const text = commands.join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="act-item act-trace-block" data-open={open}>
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="trace-lead-icon" data-open={open}>
          <span className="trace-icon-default">
            <Terminal size={14} aria-hidden="true" />
          </span>
          <span className="trace-icon-chevron">
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </span>
        <span className="trace-title">{item.label || '运行命令'}</span>
        {title && title !== item.label && (
          <>
            <span className="trace-dot">·</span>
            <span className="trace-summary">{title}</span>
          </>
        )}
        {item.meta && <span className="act-item-meta">{item.meta}</span>}
      </button>

      <div
        className="trace-unroll-viewport"
        style={{
          height: `${currentHeight.toFixed(2)}px`,
          pointerEvents: p > 0.05 ? 'auto' : 'none',
        }}
        aria-hidden={!open && p < 0.02}
      >
        <div ref={innerRef} className="cmd-card-wrap">
          <div
            className="cmd-card"
            style={{
              opacity: cardOpacity.toFixed(3),
              transform: `translate3d(0, ${cardY.toFixed(2)}px, 0)`,
              filter: cardBlur > 0.08 ? `blur(${cardBlur.toFixed(2)}px)` : 'none',
            }}
          >
            <div className="cmd-input-section">
              <div className="cmd-topbar">
                <div className="cmd-cwd-wrap">
                  <span className="cmd-status-dot" aria-hidden="true" />
                  <span className="cmd-cwd">{item.cwd || "Mova @'"}</span>
                </div>
                <button type="button" className="cmd-copy-btn" onClick={handleCopy}>
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <div className="cmd-lines">
                {commands.map((line, idx) => {
                  const u = s - (totalLines - 1 - idx);
                  const lineOpacity = clamp((u + 0.35) / 0.9, 0, 1);
                  const lineY = (1 - clamp(u, 0, 1)) * -10;
                  return (
                    <div
                      key={idx}
                      className="cmd-line"
                      style={{
                        opacity: lineOpacity.toFixed(3),
                        transform: `translate3d(0, ${lineY.toFixed(2)}px, 0)`,
                      }}
                    >
                      <span className="cmd-prompt">$</span>
                      <span className="cmd-code">{line}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {output.length > 0 && (
              <div className="cmd-output-section">
                {output.map((line, idx) => {
                  const globalIdx = commands.length + idx;
                  const u = s - (totalLines - 1 - globalIdx);
                  const lineOpacity = clamp((u + 0.35) / 0.9, 0, 1);
                  const lineY = (1 - clamp(u, 0, 1)) * -10;
                  return (
                    <div
                      key={idx}
                      className="cmd-output-line"
                      style={{
                        opacity: lineOpacity.toFixed(3),
                        transform: `translate3d(0, ${lineY.toFixed(2)}px, 0)`,
                      }}
                    >
                      {line}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** 展开后先显示多少行 diff，点「显示更多」再按批追加。 */
const EDIT_ROW_LINES = 200;

/**
 * 工具行里的文件路径：左键进右侧面板，Ctrl/⌘ 用系统默认程序打开。
 *
 * 用 span + role="link" 而不是 button：这几行里的路径有时就嵌在 `.trace-head`（本身是 button）内部，
 * 嵌套 button 是非法 HTML，浏览器会把它拆掉，点击行为随之变得不可预测。
 * `stopPropagation()` 是必须的：点路径不该顺手把整块折叠起来。
 */
function FilePathChip({ path }) {
  if (!path) return null;
  const activate = event => {
    event.preventDefault();
    event.stopPropagation();
    if (decideTarget(event) === 'external') {
      void openFileExternally({ raw: path });
      return;
    }
    openInPanel({ kind: 'file', path });
  };
  return (
    <span
      className="trace-filepath is-link"
      role="link"
      tabIndex={0}
      title="左键在右侧打开；Ctrl+点击用系统默认程序打开"
      onClick={activate}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        activate(event);
      }}
    >
      {path}
    </span>
  );
}

/**
 * `写入文件 / 修改文件 / 删除` Row:
 * Uses the same zipper/unroll animation as the command card:
 * - Viewport smoothly interpolates `height: 0 -> H` with top fade mask.
 * - The change card unrolls from beneath the header and each diff line
 *   cascades in with a staggered slide, so a write can be reviewed inline.
 */
function EditRow({ item }) {
  const [open, setOpen] = useState(Boolean(item.defaultOpen));
  const [limit, setLimit] = useState(EDIT_ROW_LINES);
  const p = useAnimatedProgress(open, 500, 420);
  const diff = item.diff || { before: null, after: null };
  // The same snapshot is rendered on every stream tick: diff it once, not per frame.
  const cache = useRef({ before: undefined, after: undefined, rows: [] });
  if (cache.current.before !== diff.before || cache.current.after !== diff.after) {
    cache.current = { before: diff.before, after: diff.after, rows: computeLineDiff(diff.before, diff.after) };
  }
  const rows = cache.current.rows;
  const visible = rows.slice(0, limit);
  const added = rows.reduce((count, row) => count + (row.type === 'add' ? 1 : 0), 0);
  const removed = rows.reduce((count, row) => count + (row.type === 'remove' ? 1 : 0), 0);
  const [innerRef, naturalHeight] = useMeasuredHeight([rows.length, limit]);

  const totalLines = Math.max(1, visible.length);
  const s = p * totalLines;
  const currentHeight = p * naturalHeight;
  const cardOpacity = clamp(p * 1.45, 0, 1);
  const cardY = -(1 - p) * 26;
  const cardBlur = (1 - clamp(p * 1.25, 0, 1)) * 2.2;

  return (
    <li className="act-item act-trace-block" data-open={open}>
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="trace-lead-icon" data-open={open}>
          <span className="trace-icon-default">
            <FileDocIcon />
          </span>
          <span className="trace-icon-chevron">
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </span>
        <span className="trace-title">{item.label || '写入文件'}</span>
        {item.path && !(item.meta || '').includes(item.path) && (
          <>
            <span className="trace-dot">·</span>
            <FilePathChip path={item.path} />
          </>
        )}
        {(added > 0 || removed > 0) && (
          <span className="edit-stat" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
            {added > 0 && <span className="is-add">+{added}</span>}
            {removed > 0 && <span className="is-del">−{removed}</span>}
          </span>
        )}
        {item.meta && <span className="act-item-meta">{item.meta}</span>}
      </button>

      <div
        className="trace-unroll-viewport"
        style={{
          height: `${currentHeight.toFixed(2)}px`,
          pointerEvents: p > 0.05 ? 'auto' : 'none',
        }}
        aria-hidden={!open && p < 0.02}
      >
        <div ref={innerRef} className="edit-card-wrap">
          <div
            className="edit-card"
            style={{
              opacity: cardOpacity.toFixed(3),
              transform: `translate3d(0, ${cardY.toFixed(2)}px, 0)`,
              filter: cardBlur > 0.08 ? `blur(${cardBlur.toFixed(2)}px)` : 'none',
            }}
          >
            <div className="edit-lines">
              {visible.map((row, idx) => {
                const u = s - (totalLines - 1 - idx);
                const lineOpacity = clamp((u + 0.35) / 0.9, 0, 1);
                const lineY = (1 - clamp(u, 0, 1)) * -10;
                const gutter = row.type === 'add' ? row.afterLine : row.beforeLine ?? row.afterLine;
                return (
                  <div
                    key={idx}
                    className="edit-line"
                    data-kind={row.type}
                    style={{
                      opacity: lineOpacity.toFixed(3),
                      transform: `translate3d(0, ${lineY.toFixed(2)}px, 0)`,
                    }}
                  >
                    <span className="edit-gutter">{gutter ?? ''}</span>
                    <span className="edit-sign" aria-hidden="true">
                      {row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' '}
                    </span>
                    <span className="edit-text">{row.text || ' '}</span>
                  </div>
                );
              })}
            </div>
            {rows.length > limit && (
              <button
                type="button"
                className="edit-more"
                onClick={(event) => {
                  event.stopPropagation();
                  setLimit((value) => value + EDIT_ROW_LINES);
                }}
              >
                显示更多（还有 {rows.length - limit} 行）
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * 3. `读取图片` Row:
 * Uses the same zipper/unroll animation:
 * - Viewport smoothly interpolates `height: 0 -> H` with top fade mask.
 * - Image preview card unrolls downward from beneath the `读取图片` header
 *   (`translateY(-(1 - p) * 28px) scale(0.96 -> 1)`) with blur-to-crisp reveal!
 */
function ImageReadRow({ item }) {
  const [open, setOpen] = useState(Boolean(item.defaultOpen));
  const p = useAnimatedProgress(open, 480, 400);
  const filePath = item.path || item.label || '';
  const [innerRef, naturalHeight] = useMeasuredHeight([item.src]);

  const currentHeight = p * (naturalHeight || 200);
  const imgOpacity = clamp((p - 0.08) / 0.78, 0, 1);
  const imgY = -(1 - p) * 28;
  const imgScale = 0.96 + 0.04 * p;
  const imgBlur = (1 - imgOpacity) * 2.6;

  return (
    <li className="act-item act-trace-block" data-open={open}>
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="trace-lead-icon" data-open={open}>
          <span className="trace-icon-default">
            <FileDocIcon />
          </span>
          <span className="trace-icon-chevron">
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </span>
        <span className="trace-title">读取图片</span>
        {filePath && (
          <>
            <span className="trace-dot">·</span>
            <FilePathChip path={filePath} />
          </>
        )}
      </button>

      <div
        className="trace-unroll-viewport"
        style={{
          height: `${currentHeight.toFixed(2)}px`,
          pointerEvents: p > 0.05 ? 'auto' : 'none',
        }}
        aria-hidden={!open && p < 0.02}
      >
        <div ref={innerRef} className="img-read-body">
          <div
            className="img-read-card"
            style={{
              opacity: imgOpacity.toFixed(3),
              transform: `translate3d(0, ${imgY.toFixed(2)}px, 0) scale(${imgScale.toFixed(3)})`,
              transformOrigin: 'left top',
              filter: imgBlur > 0.08 ? `blur(${imgBlur.toFixed(2)}px)` : 'none',
            }}
          >
            <button
              type="button"
              className="img-read-open"
              aria-label={filePath ? `放大查看图片：${filePath}` : '放大查看图片'}
              onClick={() => openImageLightbox(item.src || './assets/model-picker.png', filePath)}
            >
              <img
                src={item.src || './assets/model-picker.png'}
                alt={filePath}
                className="img-read-thumb"
                draggable={false}
                onLoad={() => {
                  if (innerRef.current) {
                    // Trigger ResizeObserver / re-measure once image decodes
                    innerRef.current.dispatchEvent(new Event('resize'));
                  }
                }}
              />
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * 3b. `工具截图` 行：
 * tool 事件自带截图时（画板 / 浏览器 / 桌面截图），在状态行**下方**补一行缩略图：
 * 尺寸有硬上限，点击走和「读取图片」一样的纯图片弹窗；
 * 解码失败只留一行「截图加载失败」，不让整条时间线崩在一张裂图上。
 */
function ToolImageRow({ image }) {
  // 按 src 记住失败：同一 id 更新成另一张图时自动重试，不会一直卡在失败态。
  const [failedSrc, setFailedSrc] = useState(null);
  const label = image.name || '工具截图';
  if (failedSrc === image.src) {
    return <p className="tool-image-failed" role="note">截图加载失败</p>;
  }
  return (
    <div className="tool-image-row">
      <button
        type="button"
        className="tool-image-open"
        aria-label={`放大查看截图：${label}`}
        title={label}
        onClick={() => openImageLightbox(image.src, label)}
      >
        <img
          className="tool-image-thumb"
          src={image.src}
          alt={label}
          loading="lazy"
          draggable={false}
          onError={() => setFailedSrc(image.src)}
        />
      </button>
    </div>
  );
}

/**
 * 4. Animated inline `来源` Row (from reference video):
 * - Collapsed (`p = 0`): `[Icon] [Step text] 来源 [SiteIcons...] v` on a SINGLE line (不换行).
 * - Clicked (`p: 0 -> 1`):
 *   Each website icon peels off from right-to-left (`N-1 -> 0`) out of the inline `来源` strip
 *   and swoops to the FAR LEFT (`detailIconX = 0`) of the row, unrolling the vertical list of
 *   source titles + real clickable URLs directly below the row.
 */
function SourceRow({ item }) {
  const Icon = ROW_ICONS[item.icon] ?? BulbStepIcon;
  const sources = item.sources || [];
  const count = sources.length;

  const rowRef = useRef(null);
  const anchorRef = useRef(null);
  const [anchorLeft, setAnchorLeft] = useState(210);
  const [open, setOpen] = useState(Boolean(item.defaultOpen));
  const p = useAnimatedProgress(open, 540, 460);

  useLayoutEffect(() => {
    const measure = () => {
      if (anchorRef.current) {
        setAnchorLeft(anchorRef.current.offsetLeft);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (rowRef.current) ro.observe(rowRef.current);
    return () => ro.disconnect();
  }, [item.label]);

  const INLINE_H = 22;
  const ROW_H = 26;
  const WORD_AND_GAP = 33;
  const INLINE_PITCH = 18.5;
  const DETAIL_ICON_X = 0;
  const DETAIL_TEXT_X = 24;

  const s = p * count;
  const remainingInline = clamp(count - s, 0, count);
  const chevronLocalX = WORD_AND_GAP + remainingInline * INLINE_PITCH + (remainingInline > 0.15 ? 2 : -2);
  const triggerWidth = Math.ceil(chevronLocalX + 16);
  const detailsHeight = p * (count * ROW_H + 4);

  return (
    <li ref={rowRef} className="act-item act-item-with-sources" data-open={open}>
      <div className="act-item-line">
        <span className="act-item-icon">
          <Icon size={14} aria-hidden="true" />
        </span>
        <span className="act-item-label" onClick={() => setOpen((v) => !v)}>
          {item.label}
        </span>

        {/* Inline `来源` + Chevron on the SAME line (不换行) */}
        <div ref={anchorRef} className="source-anchor">
          <button
            type="button"
            className="source-trigger"
            aria-expanded={open}
            style={{ width: `${triggerWidth}px`, height: `${INLINE_H}px` }}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="source-word">来源</span>
            <span
              className="source-chevron"
              data-open={open}
              style={{ transform: `translate3d(${chevronLocalX}px, -50%, 0) rotate(${open ? 180 : 0}deg)` }}
            >
              <ChevronDown size={12} aria-hidden="true" />
            </span>
          </button>
        </div>

        {item.meta && <span className="act-item-meta">{item.meta}</span>}
      </div>

      {/* Unclipped flying website icons: peel off from inline `来源` and land at the FAR LEFT (`x = 0`) */}
      <div className="source-flying-icons" aria-hidden="true">
        {sources.map((src, i) => {
          const u = s - (count - 1 - i);
          const inlineX = anchorLeft + WORD_AND_GAP + i * INLINE_PITCH;
          let x = inlineX;
          let y = 3;

          if (u > 0) {
            const peelT = clamp(u, 0, 1);
            const tx = peelT * peelT * (3 - 2 * peelT);
            const arcY = Math.sin(peelT * Math.PI) * 5.5;
            x = inlineX + (DETAIL_ICON_X - inlineX) * tx;
            y = 3 + u * ROW_H + arcY;
          }

          return (
            <div
              key={src.id || i}
              className="source-flying-icon"
              style={{
                transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`,
                zIndex: count - i,
              }}
            >
              <SiteBadge source={src} />
            </div>
          );
        })}
      </div>

      {/* Top-clipped detail rows aligned at the FAR LEFT (`x = 24px`, right beside the `x = 0` icon) */}
      <div
        className="source-details-viewport"
        style={{
          height: `${detailsHeight.toFixed(2)}px`,
          pointerEvents: p > 0.05 ? 'auto' : 'none',
        }}
      >
        {sources.map((src, i) => {
          const u = s - (count - 1 - i);
          const rowTop = (u - 1) * ROW_H + 4;
          const opacity = clamp((u - 0.18) / 0.72, 0, 1);
          const blur = (1 - opacity) * 2.2;

          return (
            <a
              key={src.id || i}
              href={safeMarkdownUrl(src.url)}
              target="_blank"
              rel="noopener noreferrer"
              tabIndex={open ? 0 : -1}
              className="source-detail-row"
              style={{
                transform: `translate3d(${DETAIL_TEXT_X}px, ${rowTop.toFixed(2)}px, 0)`,
                opacity: opacity.toFixed(3),
                filter: blur > 0.08 ? `blur(${blur.toFixed(2)}px)` : 'none',
              }}
              title={`${src.title} — ${src.url}`}
              onClick={event => {
                // Desktop: the searched page opens in the right panel, like every
                // other link in an answer. Browser preview keeps target=_blank.
                if (!globalThis.window?.movaDesktop) return;
                event.preventDefault();
                globalThis.window.dispatchEvent(new CustomEvent('mova:open-reference', {
                  detail: { kind: 'url', url: src.url },
                }));
              }}
            >
              <span className="source-detail-title">{src.title}</span>
              {src.url && <span className="source-detail-url">{src.url}</span>}
            </a>
          );
        })}
      </div>

      {detailsHeight > 0.1 && (
        <div
          className="source-flow-spacer"
          style={{ height: `${detailsHeight.toFixed(2)}px` }}
          aria-hidden="true"
        />
      )}
    </li>
  );
}


/**
 * 5. `参考了 N 条记忆` Row：
 * 与 `来源` 完全相同的拉开动效（图标依次剥离到左侧 + 行内展开），
 * 展开后每条记忆显示正文、来源对话与时间，并提供跳转 / 停用 / 编辑。
 */
function MemoryUsedRow({ item }) {
  const memories = item.memories || [];
  const rowRef = useRef(null);
  const anchorRef = useRef(null);
  const [anchorLeft, setAnchorLeft] = useState(210);
  const [open, setOpen] = useState(false);
  const p = useAnimatedProgress(open, 540, 460);

  useLayoutEffect(() => {
    const measure = () => { if (anchorRef.current) setAnchorLeft(anchorRef.current.offsetLeft); };
    measure();
    const ro = new ResizeObserver(measure);
    if (rowRef.current) ro.observe(rowRef.current);
    return () => ro.disconnect();
  }, [memories.length]);

  const INLINE_H = 22;
  const ROW_H = 46;
  const WORD_AND_GAP = 33;
  const INLINE_PITCH = 18.5;
  const DETAIL_TEXT_X = 24;

  const count = memories.length;
  const s = p * count;
  const remainingInline = clamp(count - s, 0, count);
  const chevronLocalX = WORD_AND_GAP + remainingInline * INLINE_PITCH + (remainingInline > 0.15 ? 2 : -2);
  const triggerWidth = Math.ceil(chevronLocalX + 16);
  const detailsHeight = p * (count * ROW_H + 4);

  const view = memory => memory;

  return (
    <li ref={rowRef} className="act-item act-item-with-sources" data-open={open}>
      <div className="act-item-line">
        <span className="act-item-icon"><Brain size={13} aria-hidden="true" /></span>
        <span className="act-item-label" onClick={() => setOpen(v => !v)}>参考了 {count} 条记忆</span>
        <div ref={anchorRef} className="source-anchor">
          <button type="button" className="source-trigger" aria-expanded={open}
            style={{ width: `${triggerWidth}px`, height: `${INLINE_H}px` }} onClick={() => setOpen(v => !v)}>
            <span className="source-word">查看</span>
            <span className="source-chevron" data-open={open}
              style={{ transform: `translate3d(${chevronLocalX}px, -50%, 0) rotate(${open ? 180 : 0}deg)` }}>
              <ChevronDown size={12} aria-hidden="true" />
            </span>
          </button>
        </div>
      </div>

      <div className="source-flying-icons" aria-hidden="true">
        {memories.map((memory, index) => {
          const u = s - (count - 1 - index);
          const inlineX = anchorLeft + WORD_AND_GAP + index * INLINE_PITCH;
          let x = inlineX;
          let y = 3;
          if (u > 0) {
            const peelT = clamp(u, 0, 1);
            const tx = peelT * peelT * (3 - 2 * peelT);
            x = inlineX + (0 - inlineX) * tx;
            y = 3 + u * ROW_H + Math.sin(peelT * Math.PI) * 5.5;
          }
          return (
            <div key={memory.id} className="source-flying-icon" style={{ transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`, zIndex: count - index }}>
              <Brain size={13} aria-hidden="true" />
            </div>
          );
        })}
      </div>

      <div className="source-details-viewport" style={{ height: `${detailsHeight.toFixed(2)}px`, pointerEvents: p > 0.05 ? 'auto' : 'none' }}>
        {memories.map((memory, index) => {
          const current = view(memory);
          const u = s - (count - 1 - index);
          const rowTop = (u - 1) * ROW_H + 4;
          const opacity = clamp((u - 0.18) / 0.72, 0, 1);
          const blur = (1 - opacity) * 2.2;
          return (
            <div key={memory.id} className="memory-used-row" data-disabled={current.status === 'disabled'}
              style={{ transform: `translate3d(${DETAIL_TEXT_X}px, ${rowTop.toFixed(2)}px, 0)`, opacity: opacity.toFixed(3), filter: blur > 0.08 ? `blur(${blur.toFixed(2)}px)` : 'none' }}>
                <p className="memory-used-text">{current.text}</p>
                <div className="memory-used-meta">
                  <span>{current.conversationTitle || current.source || (current.conversationId ? '来源对话' : '来源未记录')}</span>
                  {current.conversationId && <button type="button" className="memory-used-link" onClick={() => window.dispatchEvent(new CustomEvent('mova:open-memory-source', { detail: current }))}>查看来源</button>}
                  {current.updatedAt && <span>{current.updatedAt}</span>}
                  {current.status === 'disabled' && <span className="memory-used-off">已停用</span>}
                </div>
            </div>
          );
        })}
      </div>

      {detailsHeight > 0.1 && <div className="source-flow-spacer" style={{ height: `${detailsHeight.toFixed(2)}px` }} aria-hidden="true" />}
    </li>
  );
}

function Row({ item }) {
  if (item.type === 'thought') {
    return <ThoughtRow item={item} />;
  }
  if (item.type === 'command') {
    return <CommandRow item={item} />;
  }
  if (item.type === 'image') {
    return <ImageReadRow item={item} />;
  }
  if (item.type === 'edit') {
    return <EditRow item={item} />;
  }
  if (item.type === 'memory') {
    return <MemoryUsedRow item={item} />;
  }
  if (item.sources && item.sources.length > 0) {
    return <SourceRow item={item} />;
  }
  const Icon = ROW_ICONS[item.icon] ?? Terminal;
  const statusLine = (
    <>
      <span className="act-item-icon">
        <Icon size={13} aria-hidden="true" />
      </span>
      <span className="act-item-label">{item.label}</span>
      {/* 读/写/搜索过的文件：路径可点（左键右侧打开，Ctrl+点击外部打开）。标题里已含路径时不重复。 */}
      {item.path && !String(item.label || '').includes(item.path) && (
        <>
          <span className="trace-dot">·</span>
          <FilePathChip path={item.path} />
        </>
      )}
      {item.meta && <span className="act-item-meta">{item.meta}</span>}
    </>
  );
  // 没有截图的行保持原样：li 直接横排图标 / 标题 / 说明。
  if (!shouldRenderImage(item)) {
    return <li className="act-item">{statusLine}</li>;
  }
  return (
    <li className="act-item act-item-with-image">
      <div className="act-item-line">{statusLine}</div>
      <ToolImageRow image={item.image} />
    </li>
  );
}

function Activity({ segment }) {
  // Parent trace starts collapsed; one click reveals the detailed steps.
  const [open, setOpen] = useState(false);
  const HeadIcon = ROW_ICONS[segment.icon] ?? Terminal;
  return (
    <div className="act">
      <button type="button" className="act-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <HeadIcon size={14} aria-hidden="true" />
        <span className="act-summary">{segment.summary}</span>
        <ChevronDown className="act-chevron" size={14} aria-hidden="true" data-open={open} />
      </button>
      {open && segment.items.length > 0 && (
        <ul className="act-items">
          {segment.items.map((item, index) => (
            <Row item={item} key={`${segment.id}-${index}`} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Prototype reply: answer paragraphs interleaved with collapsible activity
 * rows, plus a light-sweep hint while the run is still in progress.
 * @param {{status: string, segments?: ({kind: 'text', text: string} | {kind: 'activity', id: string, icon: string, summary: string, items: object[]})[]}} props
 */
export function ThinkingBlock({ status, segments = [] }) {
  return (
    <section className="turn" aria-label="执行过程与回复">
      <div className="answer">
        {segments.map((segment, index) =>
          segment.kind === 'text' ? (
            <MarkdownContent className="turn-answer" key={`text-${index}`} text={segment.text} />
          ) : (
            <Activity segment={segment} key={segment.id} />
          )
        )}
        {status !== 'done' && (
          <p className="thinking-run" aria-live="polite">
            <span className="thinking-sweep">{status === 'searching' ? '正在搜索' : status === 'generating' ? '正在回复' : '正在思考'}</span>
          </p>
        )}
      </div>
    </section>
  );
}
