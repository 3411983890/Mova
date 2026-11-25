export interface ChatImage {
  name: string;
  dataUrl: string;
}

/** Before/after snapshot attached to a write-like tool call. */
export interface ToolDiff {
  kind?: string;
  path?: string;
  before: string | null;
  after: string | null;
  truncated?: boolean;
}

/** One goal per conversation, owned by the agent's goal tools. */
export interface ConversationGoal {
  title: string;
  detail: string;
  /** `blocked` means the model reported a blocker; automatic continuation stops. */
  status: 'idle' | 'active' | 'paused' | 'done' | 'blocked';
  /** Only an accepted goal is continued automatically after each reply. */
  accepted?: boolean;
  /** Why it is paused/blocked, or the verified result when done. */
  summary?: string;
}

/** The goal and plan the renderer sends back so tools keep working on the same one. */
export interface ConversationAim {
  goal: ConversationGoal | null;
  plan: { steps: PlanStep[] } | null;
}

export interface PlanStep {
  label: string;
  status: 'pending' | 'active' | 'done';
  meta?: string;
}

/** Provider-reported token usage for one model call. */
export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/**
 * 工具自带的截图（画板 / 浏览器 / 桌面），点击进纯图片灯箱放大。
 * 必须挂在 `tool` 事件上，**不能**用 `{ type: 'image', id }`：后者在 app.js 里会被
 * 当成「用户上传的附件」写进 `turn.imageIds`，污染用户消息气泡。
 */
export interface ToolImage {
  /** 落盘文件名（`<sha256>.png`），同一张图原地更新时不变。 */
  id: string;
  /** 人类可读的截图名，用作 alt 与 aria-label（缺省时渲染层给兜底文案）。 */
  name?: string;
  /** 可直接用作 `<img src>` 的地址，后端给的是 `./chat-images/<id>`。 */
  src: string;
}

export type ReplyEvent =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; round: number; text: string }
  | { type: 'image'; id: string; name: string }
  | {
    type: 'search'; id: string; status: 'running' | 'done' | 'error'; detail?: string;
    /** Legacy single-query shape; `queries` carries every query the model sent in one call. */
    query?: string;
    queries?: string[];
    sources?: { id?: string; title: string; url: string; site?: string; published?: string | null }[];
    /** Retrieval outcome: candidates found, after dedupe, pages read, passages kept. */
    meta?: { candidates?: number; deduped?: number; read?: number; passages?: number; budgetExhausted?: boolean };
  }
  | { type: 'read'; id: string; url: string; status: 'running' | 'done' | 'error'; title?: string; chars?: number; detail?: string }
  | { type: 'memory'; id: string; query: string; status: 'running' | 'done' | 'error'; count?: number; detail?: string }
  | {
    type: 'tool'; id: string; name: string; label: string; status: 'running' | 'done' | 'error' | 'denied'; detail?: string;
    /** `run_command` only: the command line, its working directory, and the captured output. */
    command?: string;
    cwd?: string;
    output?: string[];
    exitCode?: number | null;
    /** Write-like tools: the path that changed and, when available, its before/after snapshot. */
    path?: string;
    diff?: ToolDiff;
    /** Screenshot tools (`*_screenshot`): saved image shown inline under the tool row. */
    image?: ToolImage;
  }
  | { type: 'memory-used'; id: string; memories: { id: string; text: string; source: string | null; projectId: string | null; conversationId: string | null; messageId: string | null }[] };

/**
 * Conversation-level state the agent reports outside the transcript: token usage
 * and the goal/plan it owns through its tools. These never become transcript
 * rows, so they are a separate channel instead of extra `ReplyEvent` members.
 */
export type UsageEvent = { type: 'usage'; model: string; provider: string; call: UsageCounts; run: UsageCounts };
export type GoalEvent = { type: 'goal'; goal: ConversationGoal | null };
export type PlanEvent = { type: 'plan'; plan: { steps: PlanStep[] } | null };
/**
 * 上下文台账的真实口径上报（方案 §5 P0-6）。
 * `estimated: true` 表示这是本地估算，不是 provider 实报，永远不能和 `usage` 的 actual 混列。
 */
export type ContextEvent = {
  type: 'context';
  report: {
    mode: 'off' | 'report' | 'ledger';
    estimated: true;
    messages: { sent: number; total: number };
    tokens: { before: number; after: number };
    layers: { id: string; name: string; tokens: number }[];
    compaction: { covered: number; source: string | null; before: number; after: number | null } | null;
  };
};
export type StateEvent = UsageEvent | GoalEvent | PlanEvent | ContextEvent;

/** Everything the stream can yield besides plain text deltas. */
export type StreamEvent = ReplyEvent | StateEvent;

export function isStateEvent(event: StreamEvent): event is StateEvent {
  return event.type === 'usage' || event.type === 'goal' || event.type === 'plan' || event.type === 'context';
}

export interface ChatRequest {
  mode: 'ChatMova' | 'CodeMova';
  model: string;
  provider?: string;
  thinking?: 'simple' | 'medium' | 'deep';
  search?: boolean;
  /** Retrieval depth, region and language hint for web search (fast/standard/deep). */
  searchDepth?: 'fast' | 'standard' | 'deep';
  searchZone?: 'auto' | 'cn' | 'intl';
  searchLanguage?: 'auto' | 'zh-CN' | 'en';
  attachments?: readonly ChatImage[];
  /** Do not silently retry without the current turn's stored images. */
  requireCurrentImages?: boolean;
  temporary?: boolean;
  permissionPreset?: 'default' | 'auto' | 'full';
  conversationId?: string;
  memoryScope?: { projectId: string | null; includeGlobal: boolean };
  /** Opaque ids of the project roots this conversation may use. */
  projectRootIds?: readonly string[];
  /** User-authored rules for the current project, injected into the system prompt. */
  projectInstructions?: string;
  /** Goal/plan carried over from the previous round, so tools keep writing the same one. */
  aim?: ConversationAim | null;
  messages: readonly { role: 'user' | 'assistant'; text: string; reasoning?: string; model?: string; images?: string[] }[];
}

export interface MovaClient {
  readonly source: 'mock' | 'model';
  streamReply(request: ChatRequest, signal: AbortSignal): AsyncIterable<string | StreamEvent>;
}
