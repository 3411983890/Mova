import type { ChatRequest, MovaClient, ReplyEvent } from '../../services/mova-client';

type TerminalStatus = 'done' | 'stopped' | 'interrupted' | 'error';

export interface ChatReply {
  source: MovaClient['source'];
  status: 'streaming' | TerminalStatus;
  text: string;
  error?: string;
  model?: string;
  timeline?: ReplyEvent[];
}

export function mergeReplyEvent(timeline: ReplyEvent[], event: ReplyEvent) {
  const current = timeline.find(item => item.type === event.type && item.id === event.id);
  if (!current) timeline.push(event);
  else if ((current.type === 'thinking' || current.type === 'text') && 'text' in event) current.text += event.text;
  else if (current.type === 'search' && event.type === 'search') Object.assign(current, event);
  else if (current.type === 'command' && event.type === 'command') Object.assign(current, event);
  else if (current.type === 'tool' && event.type === 'tool') Object.assign(current, event);
  else if (current.type === 'memory-used' && event.type === 'memory-used') Object.assign(current, event);
}

export async function receiveReply(
  client: MovaClient,
  request: ChatRequest,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onError?: (error: unknown) => void,
  onEvent?: (event: ReplyEvent) => void,
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
        onEvent?.(update);
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
