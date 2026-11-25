import type {
  ChatRequest, MovaClient, ReplyEvent, StateEvent, StreamEvent, ToolImage,
} from '../../services/mova-client';

/**
 * 时间线事件就是主进程的 `ReplyEvent`：tool 行的可选 `image`（截图）已在 wire 类型里，
 * 合并行为不因此改变——同一 type+id 仍是原地覆盖，`image` 被 `Object.assign` 自然保留。
 */
export type { ReplyEvent, ToolImage };

/** tool 行的窄化别名（保留给渲染层按需使用）。 */
export type ToolReplyEvent = Extract<ReplyEvent, { type: 'tool' }>;

/**
 * State events (usage / goal / plan) are conversation-level, not transcript rows.
 * Declared locally so this module keeps type-only imports and stays runnable
 * under the Node test runner, which cannot resolve an extensionless .ts path.
 */
const isStateEvent = (event: StreamEvent): event is StateEvent =>
  event.type === 'usage' || event.type === 'goal' || event.type === 'plan' || event.type === 'context';

type TerminalStatus = 'done' | 'stopped' | 'interrupted' | 'error';

export interface ChatReply {
  source: MovaClient['source'] | 'cloud';
  status: 'streaming' | TerminalStatus;
  text: string;
  error?: string;
  model?: string;
  cloudProvider?: string;
  timeline?: ReplyEvent[];
}

/** Transcript rows only: the caller routes state events elsewhere. */
export function mergeReplyEvent(timeline: ReplyEvent[], event: ReplyEvent) {
  const current = timeline.find(item => item.type === event.type && item.id === event.id);
  if (!current) timeline.push(event);
  else if ((current.type === 'thinking' || current.type === 'text') && 'text' in event) current.text += event.text;
  else if (current.type === 'search' && event.type === 'search') Object.assign(current, event);
  else if (current.type === 'read' && event.type === 'read') Object.assign(current, event);
  else if (current.type === 'memory' && event.type === 'memory') Object.assign(current, event);
  else if (current.type === 'memory-used' && event.type === 'memory-used') Object.assign(current, event);
  else if (current.type === 'tool' && event.type === 'tool') Object.assign(current, event);
}

export async function receiveReply(
  client: MovaClient,
  request: ChatRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onError?: (error: unknown) => void,
  onEvent?: (event: StreamEvent) => void,
  onState?: (event: StateEvent) => void,
): Promise<TerminalStatus> {
  try {
    signal.throwIfAborted();
    let hasText = false;
    for await (const update of client.streamReply(request, signal)) {
      signal.throwIfAborted();
      if (typeof update === 'string') {
        if (!update) continue;
        hasText ||= Boolean(update.trim());
        onDelta(update);
      } else {
        if (update.type === 'text') {
          hasText ||= Boolean(update.text.trim());
          onDelta(update.text);
        }
        // Usage, goal and plan are conversation state, not transcript rows.
        if (isStateEvent(update)) onState?.(update);
        else onEvent?.(update);
      }
    }
    signal.throwIfAborted();
    return hasText ? 'done' : 'error';
  } catch (error) {
    if (signal.aborted) return 'stopped';
    onError?.(error);
    return 'error';
  }
}
