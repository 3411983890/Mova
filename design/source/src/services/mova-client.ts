export interface ChatImage {
  name: string;
  dataUrl: string;
}

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

/** AI 主动发起的提问：卡片临时接管底部输入栏（对话页规范 5.8）。 */
export interface AskQuestion {
  id: string;
  question: string;
  detail?: string;
  /** 省略 = 简答（只有输入框）。 */
  options?: AskOption[];
  /** 多选：需要「提交」确认。 */
  multi?: boolean;
  /** 末尾追加「自定义回答」。 */
  allowCustom?: boolean;
  placeholder?: string;
}

export type ReplyEvent =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; round: number; text: string }
  | { type: 'image'; id: string; name: string; src?: string }
  | { type: 'search'; id: string; query: string; status: 'running' | 'done' | 'error'; detail?: string; sources?: { title: string; url: string; site?: string }[] }
  | { type: 'command'; id: string; title?: string; cwd?: string; commands: string[]; output?: string[]; status?: 'running' | 'done' | 'error' }
  | { type: 'tool'; id: string; icon?: 'run' | 'read' | 'search' | 'bulb' | 'image'; label: string; meta?: string }
  | { type: 'memory-used'; id: string; memories: { id: string; text: string; kind?: string; updatedAt?: string; conversationTitle?: string; conversationId?: string; messageId?: string; status?: 'active' | 'disabled' | 'superseded' }[] }
  | ({ type: 'ask' } & AskQuestion);

export interface ChatRequest {
  mode: 'ChatMova' | 'CodeMova';
  model: string;
  provider?: string;
  thinking?: 'simple' | 'medium' | 'deep';
  search?: boolean;
  attachments?: readonly ChatImage[];
  temporary?: boolean;
  memoryScope?: { projectId: string | null; includeGlobal: boolean };
  messages: readonly { role: 'user' | 'assistant'; text: string; reasoning?: string; model?: string; images?: string[] }[];
}

export interface MovaClient {
  readonly source: 'mock' | 'model';
  streamReply(request: ChatRequest, signal: AbortSignal): AsyncIterable<string | ReplyEvent>;
}
