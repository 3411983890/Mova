import { Fragment, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Brain } from '@keyline-icons/react';
import { notify } from '../ui/toast.js';
import { MarkdownContent } from './markdown.jsx';
import { ThinkingBlock } from '../../../thinking-block.jsx';
import type { ChatReply } from './chat-reply';
import type { ReplyEvent } from '../../services/mova-client';

export interface ChatTurn {
  /** Persistent unique ID, also used verbatim as the user message DOM ID. */
  id?: string;
  /** 发送时间（毫秒），用于消息下方的「星期X HH:MM」。 */
  at?: number;
  text: string;
  thinking?: ComponentProps<typeof ThinkingBlock>;
  reply?: ChatReply;
  imageIds?: string[];
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
  | { type: 'command'; title?: string; cwd?: string; commands: string[]; output: string[] }
  | { type: 'tool'; icon: string; label: string; meta?: string }
  | { type: 'memory'; memories: { id: string; text: string; kind?: string; updatedAt?: string; conversationTitle?: string; conversationId?: string; messageId?: string; status?: string }[] }
  | { icon: 'search'; label: string; meta?: string; sources?: { id: string; title: string; url: string; site: string }[] };
type Segment = { kind: 'text'; text: string } | { kind: 'activity'; id: string; icon: string; summary: string; items: TraceItem[] };

function traceSegments(timeline: ReplyEvent[]): Segment[] {
  const result: Segment[] = [];
  for (const event of timeline) {
    if (event.type === 'text') {
      result.push({ kind: 'text', text: event.text });
      continue;
    }
    // 提问由底部问答卡片承接（规范 5.8），不进入执行过程。
    if (event.type === 'ask') continue;
    let step = result.at(-1);
    // 记忆参考单独成组：它通常出现在正文之后，读起来是「这条回复用了什么」。
    if (step?.kind !== 'activity' || event.type === 'memory-used') {
      step = { kind: 'activity', id: event.id, icon: 'search', summary: event.type === 'memory-used' ? '参考的记忆' : '思考与操作', items: [] };
      result.push(step);
    }
    if (event.type === 'thinking') {
      step.items.push({ type: 'thought', text: event.text, summary: event.text.trim().slice(0, 100) });
    } else if (event.type === 'image') {
      step.items.push({ type: 'image', path: event.name, src: event.src ?? `./chat-images/${event.id}` });
    } else if (event.type === 'command') {
      step.items.push({ type: 'command', title: event.title, cwd: event.cwd, commands: event.commands, output: event.output ?? [] });
    } else if (event.type === 'tool') {
      step.items.push({ type: 'tool', icon: event.icon ?? 'run', label: event.label, meta: event.meta });
    } else if (event.type === 'memory-used') {
      step.items.push({ type: 'memory', memories: event.memories });
    } else {
      step.items.push({
        icon: 'search',
        label: `AnySearch · ${event.query}`,
        meta: event.status === 'running' ? '正在搜索' : event.status === 'error' ? event.detail || '搜索失败'
          : event.sources?.length ? `${event.sources.length} 条来源` : '没有结果',
        sources: event.sources?.map(source => ({ ...source, id: source.url, site: '' })),
      });
    }
  }
  return result;
}

function AssistantReply({ reply, id, onRetry, busy, at }: {
  reply: ChatReply; id: string; onRetry?: () => void; busy?: boolean; at?: number;
}) {
  const last = reply.timeline?.at(-1);
  const traceStatus = reply.status !== 'streaming' ? 'done'
    : last?.type === 'search' && last.status === 'running' ? 'searching'
    : last?.type === 'text' ? 'generating' : 'thinking';
  return (
    <section id={id} tabIndex={-1} className="assistant-reply transcript-message" aria-label={reply.source === 'mock' ? '模拟回复' : '助手回复'}>
      {reply.source === 'mock' && <p className="assistant-reply-label">模拟回复</p>}
      {reply.timeline
        ? <ThinkingBlock status={traceStatus} segments={traceSegments(reply.timeline)} />
        : reply.text && <MarkdownContent className="turn-answer" text={reply.text} />}
      <p className={reply.status === 'done' || (reply.timeline && reply.status === 'streaming') ? 'visually-hidden' : 'assistant-reply-status'} role="status">
        {reply.status === 'error' && reply.error ? reply.error : labels[reply.status]}
      </p>
      <AssistantActions reply={reply} text={reply.text} at={at} onRegenerate={onRetry} />
    </section>
  );
}


/* ── 消息操作行图标（内联 SVG，避免额外的图标依赖） ─────────────── */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IconCopy = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1.6" {...stroke} /><path d="M10.5 5.5V4.2A1.7 1.7 0 0 0 8.8 2.5H4.7A1.7 1.7 0 0 0 3 4.2v6.1a1.7 1.7 0 0 0 1.7 1.7h.8" {...stroke} /></svg>;
const IconRegenerate = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7" {...stroke} /><path d="M13 3v3.2h-3.2" {...stroke} /></svg>;
const IconRollback = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.2 4.2 3 7.4l3.2 3.2" {...stroke} /><path d="M3 7.4h6.2A3.8 3.8 0 0 1 13 11.2" {...stroke} /></svg>;
const IconMore = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.15" fill="currentColor" /><circle cx="8" cy="8" r="1.15" fill="currentColor" /><circle cx="12.5" cy="8" r="1.15" fill="currentColor" /></svg>;
const IconBranch = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="4.6" cy="3.8" r="1.6" {...stroke} /><circle cx="4.6" cy="12.2" r="1.6" {...stroke} /><circle cx="11.4" cy="6.2" r="1.6" {...stroke} /><path d="M4.6 5.4v5.2M4.6 9.1c2.4 0 4-1 5.2-2.9" {...stroke} /></svg>;
const IconShare = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 9.6V2.6M5.4 5.1 8 2.5l2.6 2.6" {...stroke} /><path d="M11.9 9v3.4a1.6 1.6 0 0 1-1.6 1.6H5.7a1.6 1.6 0 0 1-1.6-1.6V9" {...stroke} /></svg>;
const IconEdit = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.4 2.9 13 5.5 6.2 12.3l-3.1.6.6-3.1 6.7-6.9Z" {...stroke} /></svg>;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export function formatMessageTime(value?: number | string) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${WEEKDAYS[date.getDay()]} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function copyText(text: string) {
  const body = String(text || '').trim();
  if (!body) return;
  navigator.clipboard?.writeText(body).then(
    () => notify('已复制到剪贴板。'),
    () => notify('复制失败，请手动选择文本。', { tone: 'error' }),
  );
}

/* 助手消息的操作行：悬停显示；点「…」时省略号收起、分支与分享滑入，时间右移。 */
function AssistantActions({ reply, text, at, onRegenerate }: { reply: ChatReply; text: string; at?: number; onRegenerate?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const time = formatMessageTime(at);
  const terminal = ['stopped', 'interrupted', 'error'].includes(reply.status);
  if (terminal) {
    return <div className="msg-actions msg-actions-assistant">
      <button type="button" className="msg-action" aria-label="重新生成" title="重新生成" onClick={onRegenerate}><IconRegenerate /></button>
      {time && <span className="msg-time">{time}</span>}
    </div>;
  }
  return <div className="msg-actions msg-actions-assistant" data-expanded={expanded || undefined}>
    <button type="button" className="msg-action" aria-label="复制回复" title="复制" onClick={() => copyText(text)}><IconCopy /></button>
    <button type="button" className="msg-action" aria-label="重新生成" title="重新生成" onClick={onRegenerate}><IconRegenerate /></button>
    <button type="button" className="msg-action" aria-label="回退到这里" title="回退" onClick={() => notify('已回退到这条回复之前。')}><IconRollback /></button>
    <button type="button" className="msg-action" aria-label="查看用到的记忆" title="记忆" onClick={() => notify('这条回复使用了 3 条记忆，见回复下方「参考的记忆」。')}><Brain size="1em" aria-hidden="true" /></button>
    <span className="msg-extra" aria-hidden={!expanded}>
      <button type="button" className="msg-action" aria-label="创建分支" title="分支" tabIndex={expanded ? 0 : -1} onClick={() => notify('已从这条回复创建分支。')}><IconBranch /></button>
      <button type="button" className="msg-action" aria-label="分享" title="分享" tabIndex={expanded ? 0 : -1} onClick={() => notify('分享链接已复制。')}><IconShare /></button>
    </span>
    <button type="button" className="msg-action msg-more" aria-label="更多操作" aria-expanded={expanded} title="更多" onClick={() => setExpanded(value => !value)}><IconMore /></button>
    {time && <span className="msg-time">{time}</span>}
  </div>;
}

function UserActions({ text, at, onRewrite }: { text: string; at?: number; onRewrite?: () => void }) {
  const time = formatMessageTime(at);
  return <div className="msg-actions msg-actions-user">
    {time && <span className="msg-time">{time}</span>}
    <button type="button" className="msg-action" aria-label="复制这条消息" title="复制" onClick={() => copyText(text)}><IconCopy /></button>
    <button type="button" className="msg-action" aria-label="重写这条消息" title="重写" onClick={onRewrite}><IconEdit /></button>
  </div>;
}

const PAGE_SIZE = 60;
const messageId = (turn: ChatTurn, index: number) => turn.id || `message-${index}`;

export function ChatTranscript({
  turns,
  viewport,
  onRetry,
  onRewrite,
  busy = false,
}: {
  turns: readonly ChatTurn[];
  viewport: HTMLElement;
  onRetry?: (index: number) => void;
  onRewrite?: (index: number) => void;
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
            <div className="user-turn">
              <div id={id} tabIndex={-1} className="user-message transcript-message">{turn.text || '已发送图片'}</div>
              <UserActions text={turn.text} at={turn.at} onRewrite={onRewrite ? () => onRewrite(index) : undefined} />
            </div>
            {turn.thinking && <div id={turn.reply ? undefined : `${id}-assistant`} tabIndex={-1} className="thinking-mount transcript-message">
              <p className="assistant-reply-label">示例回复与执行过程</p>
              <ThinkingBlock {...turn.thinking} />
            </div>}
            {turn.reply && <AssistantReply reply={turn.reply} id={`${id}-assistant`} busy={busy} at={turn.at}
              onRetry={onRetry ? () => onRetry(index) : undefined} />}
          </Fragment>
        );
      })}
    </>
  );
}
