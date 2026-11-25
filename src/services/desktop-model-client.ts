import type { ChatRequest, MovaClient, ReplyEvent, StreamEvent } from './mova-client';

type ModelResult<T = void> = { ok: true; value: T } | { ok: false; error: string; message?: string };

export interface ModelEntry {
  id: string;
  name: string;
  vision: boolean;
  efforts: string[];
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: 'openai' | 'anthropic';
  models: ModelEntry[];
  hasKey?: boolean;
  updatedAt?: number;
}

export interface ProvidersState {
  providers: ModelProvider[];
  active: { providerId: string; modelId: string };
  searchConfigured: boolean;
}

export interface DesktopProviders {
  list(): Promise<ModelResult<ProvidersState>>;
  save(input: Partial<ModelProvider> & { key?: string }): Promise<ModelResult<{ provider: ModelProvider; active: ProvidersState['active'] }>>;
  remove(id: string): Promise<ModelResult<{ providers: ModelProvider[]; active: ProvidersState['active'] }>>;
  fetch(input: { id?: string; name?: string; baseUrl?: string; protocol?: string; key?: string }): Promise<ModelResult<ModelEntry[]>>;
  defaults(id: string): Promise<ModelResult<ModelEntry[]>>;
  setActive(active: { providerId: string; modelId: string }): Promise<ModelResult<ProvidersState['active']>>;
}

export interface DesktopModel {
  saveSearch(key: string): Promise<ModelResult>;
  testSearch(key: string): Promise<ModelResult<number>>;
  complete(id: string, request: ChatRequest): Promise<ModelResult>;
  cancel(id: string): Promise<ModelResult>;
  /** Carries both transcript rows and conversation state (usage, goal, plan). */
  onDelta(id: string, callback: (event: StreamEvent) => void): () => void;
}

export interface DesktopProjectFolder {
  /** Stable opaque identity derived from the normalized absolute path. */
  id: string;
  /** Directory basename (the absolute path for a filesystem root). */
  name: string;
  /** Native absolute path, never a browser-relative upload path. */
  path: string;
}

export interface DesktopProjects {
  /** Opens the native multi-directory picker; cancellation resolves to []. */
  pickFolders(): Promise<DesktopProjectFolder[]>;
}

export interface PermissionCapabilities {
  read: boolean;
  write: boolean;
  exec: boolean;
}

export interface PermissionRoot {
  /** Opaque id derived from the normalized absolute path. */
  id: string;
  name: string;
  path: string;
  capabilities: PermissionCapabilities;
  autoAccept: Pick<PermissionCapabilities, 'write' | 'exec'>;
  updatedAt: number;
}

/** Composer-level approval mode; it never widens folder or capability grants. */
export type PermissionPreset = 'default' | 'auto' | 'full';

export interface DesktopPermissions {
  list(): Promise<ModelResult<{ version: number; preset?: PermissionPreset; roots: PermissionRoot[] }>>;
  /** Registers a folder that already belongs to a project; access stays off. */
  register(input: { folders: { path: string; name?: string }[] }): Promise<ModelResult<{ version: number; preset?: PermissionPreset; roots: PermissionRoot[] }>>;
  /** Granting shows a native confirmation; revoking never asks. */
  set(input: { rootId: string; capability: keyof PermissionCapabilities; value: boolean }): Promise<ModelResult<PermissionRoot>>;
  setAutoAccept(input: { rootId: string; capability: 'write' | 'exec'; value: boolean }): Promise<ModelResult<PermissionRoot>>;
  /** Current approval mode plus the per-call policy it implies. */
  getPreset(): Promise<ModelResult<{ preset: PermissionPreset; autoAccept: Pick<PermissionCapabilities, 'write' | 'exec'> }>>;
  /** Choosing `full` asks for a native confirmation in the main process. */
  setPreset(preset: PermissionPreset): Promise<ModelResult<{ preset: PermissionPreset; roots: PermissionRoot[] }>>;
  revoke(rootId: string): Promise<ModelResult<PermissionRoot>>;
  /** Clears the root's grants and forgets the registration entirely. */
  forget(rootId: string): Promise<ModelResult<{ version: number; preset?: PermissionPreset; roots: PermissionRoot[] }>>;
  /** Opens a registered folder in the system file manager (user-initiated). */
  reveal(rootId: string): Promise<ModelResult<{ revealed: boolean }>>;
}

/** One file inside a batch preview. Same shape as a single-file preview. */
export interface ApprovalPreviewFile {
  path: string;
  before: string | null;
  after: string | null;
  truncated?: boolean;
}

/**
 * What the main process sends for review. `kind` is `'write' | 'replace' |
 * 'delete' | 'move'` for one file and `'batch'` for several (`files`, with
 * `path` summarising the count). It is typed as `string` on purpose: a newer
 * main process may send a kind this renderer does not know yet, and the bar has
 * to fall back to the plain before/after view instead of failing.
 */
export interface ApprovalPreview {
  kind: string;
  /** `<rootName>/<relPath>`, or `<N 个文件>` for a batch. */
  path: string;
  before: string | null;
  after: string | null;
  /** True when the main process sent only the first lines of the file. */
  truncated?: boolean;
  /**
   * Root-relative path, when the main process chooses to send it. Older
   * payloads only carry the display path (`path`, prefixed with the root name).
   */
  relPath?: string;
  /** Present only when `kind === 'batch'`. */
  files?: ApprovalPreviewFile[];
}

export interface ApprovalRequest {
  id: string;
  kind: 'approval';
  title?: string;
  message: string;
  detail?: string;
  capability?: 'write' | 'exec';
  /** Opaque id of the registered root; `files.reveal` needs it. */
  rootId?: string;
  /** Display name of that root, used to strip the prefix from `preview.path`. */
  rootName?: string;
  preview?: ApprovalPreview | null;
  timeoutMs?: number;
}

export interface DesktopApprovals {
  respond(id: string, decision: 'deny' | 'once' | 'session'): Promise<ModelResult>;
  onRequest(callback: (request: ApprovalRequest) => void): () => void;
  onClose(callback: (payload: { id: string }) => void): () => void;
}

/** One recorded file change inside a registered root. */
export interface DesktopChangeEntry {
  /** Opaque id for `changes.diff`; only meaningful within its root. */
  id: string;
  /** Epoch milliseconds of the write. */
  time: number;
  /** Path relative to the root, as the file tools reported it. */
  path: string;
  /** `write` | `create` | `replace` | `delete` | `move` | `undo` (open on purpose). */
  kind: string;
  /** Bytes in the stored snapshot; 0 for a delete. */
  bytes: number;
}

/** One change with its before/after snapshots, for the diff view. */
export interface DesktopChangeDetail {
  id: string;
  time: number;
  path: string;
  kind: string;
  /** `null` on the side where no file existed (create/delete/move). */
  before: string | null;
  after: string | null;
  /** True when the main process sent only the first lines of either side. */
  truncated: boolean;
}

/**
 * Change history for one registered folder. `list` is capped by the main
 * process (most recent 100); `diff` re-reads one entry by id so the renderer
 * never holds the whole history in memory. Errors are codes:
 * `not-registered` | `not-found` | `history-unreadable` | `path-escape` |
 * `unauthorized`.
 */
export interface DesktopChangesClient {
  list(input: { rootId: string }): Promise<ModelResult<{ changes: DesktopChangeEntry[] }>>;
  diff(input: { rootId: string; changeId: string }): Promise<ModelResult<DesktopChangeDetail>>;
}

/** File-level actions inside a registered root; the path must stay inside it. */
export interface DesktopFilesClient {
  /** Opens the system file manager with the file selected (user-initiated). */
  reveal(input: { rootId: string; path: string }): Promise<ModelResult<{ revealed: true }>>;
}

export interface DesktopBridge {
  projects: DesktopProjects;
  permissions?: DesktopPermissions;
  approvals?: DesktopApprovals;
  /** Optional: absent on a preload that predates the change history. */
  changes?: DesktopChangesClient;
  /** Optional: absent on a preload that predates file-level reveal. */
  files?: DesktopFilesClient;
  siteIcon?(host: string): Promise<string | null>;
  providers: DesktopProviders;
  model: DesktopModel;
}

const errors = {
  auth: '模型服务拒绝了 API 密钥，请到设置中检查。',
  not_configured: '请先在设置 → 模型中添加提供商并保存 API 密钥。',
  invalid_key: '请输入有效的 API 密钥。',
  credential: '无法读取或保存密钥，请重新配置。',
  not_found: '模型服务找不到接口或模型，请检查 API 地址与模型 ID。',
  rate_limit: '模型服务已限流，请稍后重试。',
  upstream: '模型服务暂时出错，请稍后重试。',
  timeout: '模型响应超时，请重试。',
  network: '无法连接模型服务，请检查 API 地址和网络。',
  empty: '模型未返回正文，请重试。',
  interrupted: '模型连接在回复完成前断开。',
  protocol: '模型服务返回了无法处理的响应。',
  request: '模型服务拒绝了这条请求。',
  history: '会话包含无效消息，无法构建上下文。请检查消息后重试。',
  input_too_long: '单条消息超过当前 60,000 字符安全预算，请拆分发送；原始聊天不会被删除。',
  busy: '当前生成请求较多，请稍后重试。',
  image_type: '图片格式不受支持，请使用 PNG、JPEG、WebP 或 GIF。',
  image_size: '每次最多发送 4 张图片，每张不超过 4 MB。',
  image_unsupported: '当前模型不支持图片，请在输入框切换模型。',
  image_missing: '原图不可用，请重新上传图片后发送。',
  tool_limit: '本轮工具输出过多，已停止；请缩小任务范围或分几轮继续。',
  model_access: '当前 API 密钥没有权限使用此模型。请切换模型，或在提供商处调整密钥权限。',
  model_region: '当前出口不支持此模型。请切换模型，或在提供商处调整出口设置。',
  invalid_url: '请输入有效的 API 地址（以 http:// 或 https:// 开头）。',
  duplicate: '已经有同名的提供商了，请换一个显示名称。',
  no_models: '请至少保留一个模型。',
  provider_limit: '最多添加 12 个提供商。',
  empty_catalog: '提供商的模型列表为空，请检查 API 地址、协议和密钥。',
} as const;

export class ModelConnectionError extends Error {
  constructor(code: string) {
    super(Object.hasOwn(errors, code) ? errors[code as keyof typeof errors] : '模型请求失败，请重试。');
  }
}

export function createDesktopMovaClient(bridge: DesktopModel): MovaClient {
  return {
    source: 'model',
    async *streamReply(request, signal) {
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const pending: StreamEvent[] = [];
      let ended = false;
      let failure: ModelConnectionError | undefined;
      let wake: (() => void) | undefined;
      const unsubscribe = bridge.onDelta(id, event => {
        pending.push(event);
        wake?.();
      });
      const cancel = () => { void bridge.cancel(id).catch(() => {}); };
      const onAbort = () => { cancel(); wake?.(); };
      signal.addEventListener('abort', onAbort, { once: true });
      void bridge.complete(id, request).then(result => {
        if (!result.ok) {
          const error = new ModelConnectionError(result.error);
          // 主进程会带上更具体的原因（重试次数、是否保留进度）；有就用它。
          if (typeof result.message === 'string' && result.message.trim()) error.message = result.message;
          failure = error;
        }
      }).catch(() => {
        failure = new ModelConnectionError('network');
      }).finally(() => {
        ended = true;
        wake?.();
      });
      try {
        while (true) {
          signal.throwIfAborted();
          if (pending.length) {
            yield pending.shift()!;
          } else if (ended) {
            if (failure) throw failure;
            return;
          } else {
            await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
          }
        }
      } finally {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        if (!ended && !signal.aborted) cancel();
      }
    },
  };
}
