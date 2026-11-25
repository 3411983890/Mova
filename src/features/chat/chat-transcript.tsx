import { Fragment, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { MarkdownContent } from './markdown.jsx';
import { fileRefOfLabel, parseUserText } from './quote-source.js';
import { ThinkingBlock } from './thinking-block.jsx';
import { openImageLightbox } from '../media/image-lightbox.js';
import { toolStatusMeta, toolStatusRow } from './trace-image.mjs';
import type { ChatReply, ReplyEvent, ToolImage } from './chat-reply';
import { cloudProviderLabel } from '../cloud-connections/workspace-location.mjs';
import type { ToolDiff } from '../../services/mova-client';

/** 用户上传并发送的图片：气泡上方的方形缩略图，点击后放大查看。 */
export interface ChatTurnImage {
  src: string;
  alt?: string;
}

export interface ChatTurn {
  /** Persistent unique ID, also used verbatim as the user message DOM ID. */
  id?: string;
  /** 发送时间（毫秒），用于消息下方的「星期X HH:MM」。 */
  at?: number;
  text: string;
  thinking?: ComponentProps<typeof ThinkingBlock>;
  reply?: ChatReply;
  imageIds?: string[];
  /** 这一轮用户发出的图片，由 app.js 按已确认的图片 ID 或本地原图解析。 */
  images?: readonly ChatTurnImage[];
  /** 这一轮附带的非图片文件（名字 + 类别）。正文已经进了模型上下文，这里只做回显。 */
  files?: ReadonlyArray<{ name: string; kind: string }>;
  /** 自动推进产生的轮次：不是用户说的话，只显示一行灰色说明。 */
  internal?: boolean;
  note?: string;
}

const labels: Record<ChatReply['status'], string> = {
  streaming: '正在生成…',
  done: '生成完毕',
  stopped: '已停止生成',
  interrupted: '上次生成已中断',
  error: '回复生成失败，请重新发送消息',
};

type TraceItem =
  | { type: 'thought'; text: string; summary: string }
  | { type: 'image'; path: string; src: string }
  | { type: 'command'; label: string; meta?: string; cwd?: string; commands: string[]; output: string[] }
  | { type: 'edit'; label: string; meta?: string; path: string; diff: ToolDiff }
  | { type: 'memory'; memories: { id: string; text: string; source?: string | null; conversationId?: string | null; messageId?: string | null }[] }
  | { icon: string; label: string; meta?: string; path?: string; sources?: { id: string; title: string; url: string; site: string }[]; image?: ToolImage };
type Segment = { kind: 'text'; text: string } | { kind: 'activity'; id: string; icon: string; summary: string; items: TraceItem[] };

/** 搜索事件的完整形状：新事件带 queries + meta，旧事件只有 query/sources，两种都要渲染。 */
type SearchTraceEvent = {
  type: 'search';
  id: string;
  status?: 'running' | 'done' | 'error';
  query?: string;
  queries?: string[];
  detail?: string;
  meta?: { candidates?: number; deduped?: number; read?: number; passages?: number };
  sources?: { id?: string; url: string; title?: string; site?: string }[];
};

/** 正文读取事件（web_read）：一行进度，不展开卡片。 */
type ReadTraceEvent = {
  type: 'read';
  id: string;
  status?: 'running' | 'done' | 'error';
  url?: string;
  title?: string;
  chars?: number;
  detail?: string;
};

/**
 * 时间线里可能出现的事件。`ReplyEvent` 由主进程的类型定义维护，新形状还没并进去，
 * 所以这里补齐搜索/读取两种，让分段器在旧类型下也能安全处理新事件。
 */
type TraceEvent = Exclude<ReplyEvent, { type: 'search' }> | SearchTraceEvent | ReadTraceEvent;


/** 搜索行的说明：`已读 N 页 · N 条来源`；进行中/失败时优先给状态。 */
function searchMetaText(event: SearchTraceEvent) {
  if (event.status === 'running') return '正在搜索';
  if (event.status === 'error') return event.detail || '搜索失败';
  const read = typeof event.meta?.read === 'number' && event.meta.read > 0 ? event.meta.read : 0;
  const count = event.sources?.length ?? 0;
  const parts: string[] = [];
  if (read) parts.push(`已读 ${read} 页`);
  if (count) parts.push(`${count} 条来源`);
  return parts.join(' · ') || '没有结果';
}

/** 搜索行的标题：多查询时给条数 + 第一条，单查询时给查询本身（兼容旧的 query 字段）。 */
function searchLabel(event: SearchTraceEvent) {
  const queries = (event.queries ?? []).filter(query => typeof query === 'string' && query.trim());
  if (queries.length > 1) return `${queries.length} 个查询 · ${queries[0]} 等`;
  return queries[0] || event.query || '联网搜索';
}

export function traceSegments(timeline: ReplyEvent[]): Segment[] {
  const result: Segment[] = [];
  for (const event of timeline as readonly TraceEvent[]) {
    if (event.type === 'text') {
      result.push({ kind: 'text', text: event.text });
      continue;
    }
    let step = result.at(-1);
    if (step?.kind !== 'activity') {
      step = { kind: 'activity', id: event.id, icon: 'search', summary: '思考与操作', items: [] };
      result.push(step);
    }
    if (event.type === 'thinking') {
      step.items.push({ type: 'thought', text: event.text, summary: event.text.trim().slice(0, 100) });
    } else if (event.type === 'image') {
      step.items.push({ type: 'image', path: event.name, src: `./chat-images/${event.id}` });
    } else if (event.type === 'tool') {
      const meta = toolStatusMeta(event);
      const output = Array.isArray(event.output) ? event.output : [];
      if (event.name === 'run_command' && (event.command || output.length)) {
        // 展开后是终端卡片：命令行 + 工作目录 + 实际输出。
        step.items.push({
          type: 'command', label: event.label, meta,
          cwd: event.cwd, commands: event.command ? [event.command] : [], output,
        });
      } else if (event.diff && (event.diff.before != null || event.diff.after != null)) {
        // 展开后是变更卡片：文件路径 + 逐行 diff。
        step.items.push({
          type: 'edit', label: event.label, meta,
          path: event.path || event.diff.path || '', diff: event.diff,
        });
      } else {
        // 普通状态行：形状与截图附件都由 trace-image.mjs 的纯函数决定（测试直接打它）。
        step.items.push(toolStatusRow(event));
      }
    } else if (event.type === 'memory') {
      step.items.push({
        icon: 'search',
        label: `长期记忆 · ${event.query}`,
        meta: event.status === 'running' ? '正在查找' : event.status === 'error' ? event.detail || '查找失败'
          : event.count ? `${event.count} 条记忆` : '没有结果',
      });
    } else if (event.type === 'memory-used') {
      step.items.push({ type: 'memory', memories: event.memories });
    } else if (event.type === 'read') {
      // 读取正文：标题优先，拿不到标题就显示 URL。
      step.items.push({
        icon: 'search',
        label: `读取 · ${event.title || event.url || '网页'}`,
        meta: event.status === 'running' ? '正在读取'
          : event.status === 'error' ? event.detail || '读取失败'
            : typeof event.chars === 'number' && event.chars > 0 ? `${event.chars} 字` : event.detail || '没有取到正文',
      });
    } else if (event.type === 'search') {
      // 多源检索：sources 仍是 {id,url,title,site}，旧事件没有 id/site 时按 url 补齐。
      const sources = (event.sources ?? []).map(source => ({
        id: source.id || source.url,
        title: source.title || source.url,
        url: source.url,
        site: source.site ?? '',
      }));
      step.items.push({
        icon: 'search',
        label: searchLabel(event),
        meta: searchMetaText(event),
        sources: sources.length ? sources : undefined,
      });
    }
  }
  return result;
}

function AssistantReply({ reply, id, at, onRetry, onNotify, busy }: {
  reply: ChatReply; id: string; at?: number; onRetry?: () => void;
  onNotify?: (message: string, options?: { tone?: 'error' }) => void; busy?: boolean;
}) {
  const last = reply.timeline?.at(-1) as TraceEvent | undefined;
  const traceStatus = reply.status !== 'streaming' ? 'done'
    : (last?.type === 'search' || last?.type === 'read' || last?.type === 'memory') && last.status === 'running' ? 'searching'
    : last?.type === 'text' ? 'generating' : 'thinking';
  return (
    <section id={id} tabIndex={-1} className="assistant-reply transcript-message" aria-label={reply.source === 'mock' ? '模拟回复' : '助手回复'}>
      {reply.source === 'mock' && <p className="assistant-reply-label">模拟回复</p>}
      {reply.source === 'cloud' && <p className="assistant-reply-label">{['云端执行', cloudProviderLabel(reply.cloudProvider)].filter(Boolean).join(' · ')}</p>}
      {reply.timeline
        ? <ThinkingBlock status={traceStatus} segments={traceSegments(reply.timeline)} />
        : reply.text && <MarkdownContent className="turn-answer" text={reply.text} />}
      <p className={reply.status === 'done' || (reply.timeline && reply.status === 'streaming') ? 'visually-hidden' : 'assistant-reply-status'} role="status">
        {reply.status === 'error' && reply.error ? reply.error : labels[reply.status]}
      </p>
      <AssistantActions reply={reply} text={reply.text} at={at} busy={busy} onRegenerate={onRetry} onNotify={onNotify} />
    </section>
  );
}

/* ── 消息操作行图标（内联 SVG，避免额外的图标依赖） ─────────────── */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IconCopy = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1.6" {...stroke} /><path d="M10.5 5.5V4.2A1.7 1.7 0 0 0 8.8 2.5H4.7A1.7 1.7 0 0 0 3 4.2v6.1a1.7 1.7 0 0 0 1.7 1.7h.8" {...stroke} /></svg>;
const IconRegenerate = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7" {...stroke} /><path d="M13 3v3.2h-3.2" {...stroke} /></svg>;
const IconEdit = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.4 2.9 13 5.5 6.2 12.3l-3.1.6.6-3.1 6.7-6.9Z" {...stroke} /></svg>;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export function formatMessageTime(value?: number | string) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${WEEKDAYS[date.getDay()]} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 小标与日期同设计稿：图标行常驻，时间在悬停/聚焦或展开时出现。 */
function copyText(text: string, onNotify?: (message: string, options?: { tone?: 'error' }) => void) {
  const body = String(text || '').trim();
  if (!body) return;
  const done = () => onNotify?.('已复制到剪贴板。');
  const failed = () => onNotify?.('复制失败，请手动选择文本。', { tone: 'error' });
  navigator.clipboard?.writeText(body).then(done, failed) ?? failed();
}

function AssistantActions({ reply, text, at, busy, onRegenerate, onNotify }: {
  reply: ChatReply; text: string; at?: number; busy?: boolean;
  onRegenerate?: () => void; onNotify?: (message: string, options?: { tone?: 'error' }) => void;
}) {
  const time = formatMessageTime(at);
  const terminal = ['stopped', 'interrupted', 'error'].includes(reply.status);
  if (terminal) {
    return <div className="msg-actions msg-actions-assistant">
      {onRegenerate && <button type="button" className="msg-action" aria-label="重新生成" title="重新生成" disabled={busy} onClick={onRegenerate}><IconRegenerate /></button>}
      {time && <span className="msg-time">{time}</span>}
    </div>;
  }
  return <div className="msg-actions msg-actions-assistant">
    <button type="button" className="msg-action" aria-label="复制回复" title="复制" onClick={() => copyText(text, onNotify)}><IconCopy /></button>
    {onRegenerate && <button type="button" className="msg-action" aria-label="重新生成" title="重新生成" disabled={busy} onClick={onRegenerate}><IconRegenerate /></button>}
    {time && <span className="msg-time">{time}</span>}
  </div>;
}

function UserActions({ text, at, onRewrite, onNotify }: {
  text: string; at?: number; onRewrite?: () => void;
  onNotify?: (message: string, options?: { tone?: 'error' }) => void;
}) {
  const time = formatMessageTime(at);
  return <div className="msg-actions msg-actions-user">
    {time && <span className="msg-time">{time}</span>}
    <button type="button" className="msg-action" aria-label="复制这条消息" title="复制" onClick={() => copyText(text, onNotify)}><IconCopy /></button>
    {onRewrite && <button type="button" className="msg-action" aria-label="重写这条消息" title="重写" onClick={onRewrite}><IconEdit /></button>}
  </div>;
}

const PAGE_SIZE = 60;
const messageId = (turn: ChatTurn, index: number) => turn.id || `message-${index}`;

/** 气泡上方的方形缩略图；点击任意一张都会打开同一个纯图片弹窗。 */
function UserImages({ images, anchorId }: { images: readonly ChatTurnImage[]; anchorId?: string }) {
  return <div id={anchorId} tabIndex={anchorId ? -1 : undefined} className="user-message-images">
    {images.map((image, index) => (
      <button
        key={`${image.src}-${index}`}
        type="button"
        className="user-message-image"
        aria-label={image.alt ? `查看图片：${image.alt}` : '查看图片'}
        onClick={() => openImageLightbox(image.src, image.alt)}
      >
        <img src={image.src} alt={image.alt || '用户上传的图片'} loading="lazy" draggable={false} />
      </button>
    ))}
  </div>;
}

/**
 * 用户气泡正文：开头的连续 `[引用 · 来源] 内容` 行渲染成引用块，其余按原文显示。
 * 解析不匹配时整段原样输出（`turn.text` 不变，复制仍是完整文本）。
 */
export function UserMessageText({ text }: { text: string }) {
  const parsed = parseUserText(text);
  if (!parsed.matched || !parsed.quotes.length) return <>{text}</>;
  return (
    <>
      {parsed.quotes.map((quote, index) => {
        const fileRef = fileRefOfLabel(quote.label);
        return (
          <span className="user-quote" key={`${index}-${quote.label}`} title={quote.text}>
            {fileRef ? (
              <button
                type="button"
                className="user-quote-source user-quote-link"
                title={`在右侧打开 ${fileRef.path}`}
                onClick={() => {
                  const path = fileRef.line > 0 ? `${fileRef.path}#L${fileRef.line}` : fileRef.path;
                  globalThis.window?.dispatchEvent(new CustomEvent('mova:open-reference', { detail: { kind: 'file', path } }));
                }}
              >
                引用 · {quote.label}
              </button>
            ) : (
              <span className="user-quote-source">引用 · {quote.label}</span>
            )}
            <span className="user-quote-text">{quote.text}</span>
          </span>
        );
      })}
      {parsed.body.trim() ? <>{parsed.body}</> : null}
    </>
  );
}

export function ChatTranscript({
  turns,
  viewport,
  onRetry,
  onRewrite,
  onNotify,
  busy = false,
}: {
  turns: readonly ChatTurn[];
  viewport: HTMLElement;
  onRetry?: (index: number) => void;
  onRewrite?: (index: number) => void;
  onNotify?: (message: string, options?: { tone?: 'error' }) => void;
  busy?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [jumpVersion, setJumpVersion] = useState(0);
  const start = Math.max(0, turns.length - visibleCount);
  const follow = useRef(true);
  const previousCount = useRef(0);
  const pendingJump = useRef<string | null>(null);
  const initialHashHandled = useRef(false);
  const preserveScroll = useRef<{ height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    function onScroll() {
      follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
    }
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [viewport]);

  useLayoutEffect(() => {
    function reveal(id: unknown) {
      if (typeof id !== 'string' || !id) return;
      const index = turns.findIndex((turn, i) => {
        const base = messageId(turn, i);
        return id === base || id === `${base}-assistant`;
      });
      if (index < 0) return;
      initialHashHandled.current = true;
      follow.current = false;
      preserveScroll.current = null;
      pendingJump.current = id;
      setVisibleCount(count => Math.max(count, turns.length - index));
      setJumpVersion(version => version + 1);
    }
    function fromHash() {
      try { reveal(decodeURIComponent(window.location.hash.slice(1))); } catch { /* Malformed URL hash. */ }
    }
    function fromEvent(event: Event) {
      reveal((event as CustomEvent<{ messageId?: string }>).detail?.messageId);
    }
    window.addEventListener('hashchange', fromHash);
    window.addEventListener('mova:reveal-message', fromEvent);
    if (!initialHashHandled.current) fromHash();
    return () => {
      window.removeEventListener('hashchange', fromHash);
      window.removeEventListener('mova:reveal-message', fromEvent);
    };
  }, [turns]);

  useLayoutEffect(() => {
    const target = pendingJump.current && document.getElementById(pendingJump.current);
    if (target && viewport.contains(target)) {
      pendingJump.current = null;
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
    } else if (preserveScroll.current) {
      const old = preserveScroll.current;
      viewport.scrollTop = old.top + viewport.scrollHeight - old.height;
      preserveScroll.current = null;
    } else if (!pendingJump.current && (follow.current || turns.length > previousCount.current)) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    previousCount.current = turns.length;
  }, [viewport, turns, visibleCount, jumpVersion]);

  function loadEarlier() {
    follow.current = false;
    preserveScroll.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setVisibleCount(count => count + PAGE_SIZE);
  }

  return (
    <>
      {start > 0 && <button type="button" className="transcript-load-earlier" onClick={loadEarlier}>加载更早消息</button>}
      {turns.slice(start).map((turn, offset) => {
        const index = start + offset;
        const id = messageId(turn, index);
        return (
          <Fragment key={id}>
            {turn.internal ? (
              <p className="turn-auto-note" role="note">{turn.note || '自动继续'}</p>
            ) : (
              <div className="user-turn">
                {turn.images?.length ? <UserImages images={turn.images} anchorId={turn.text ? undefined : id} /> : null}
                {/* 非图片附件只回显名字与类别：正文已经在上下文里，这里再展开一遍没有意义，
                    但用户必须能在历史里看到「我确实发过这个文件」。 */}
                {turn.files?.length ? (
                  <ul className="user-files" aria-label="本次附加的文件">
                    {turn.files.map((file, fileIndex) => (
                      <li key={`${file.name}-${fileIndex}`} className="user-file" title={file.name}>
                        <span className="user-file-kind">{file.kind}</span>
                        <span className="user-file-name">{file.name}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {turn.text || (!turn.images?.length && !turn.files?.length)
                  ? <div id={id} tabIndex={-1} className="user-message transcript-message">
                      {turn.text ? <UserMessageText text={turn.text} /> : '已发送图片'}
                    </div>
                  : null}
                <UserActions text={turn.text} at={turn.at} onNotify={onNotify}
                  onRewrite={onRewrite ? () => onRewrite(index) : undefined} />
              </div>
            )}
            {turn.thinking && <div id={turn.reply ? undefined : `${id}-assistant`} tabIndex={-1} className="thinking-mount transcript-message">
              <p className="assistant-reply-label">示例回复与执行过程</p>
              <ThinkingBlock {...turn.thinking} />
            </div>}
            {turn.reply && <AssistantReply reply={turn.reply} id={`${id}-assistant`} busy={busy} at={turn.at} onNotify={onNotify}
              onRetry={onRetry ? () => onRetry(index) : undefined} />}
          </Fragment>
        );
      })}
    </>
  );
}
