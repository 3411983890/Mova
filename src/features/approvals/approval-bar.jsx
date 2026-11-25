// The build uses the classic JSX transform (no esbuild config), so React must
// stay imported even though only JSX is used.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_DIFF_LINES,
  DIFF_CHAR_LIMIT,
  computeLineDiff,
  diffSummary,
  exceedsDiffLimit,
} from './diff.js';
import { revealErrorText } from '../changes/change-format.js';
import './approval-bar.css';

/**
 * In-app approval for a single write or command. Granting a capability still
 * uses the native dialog; this bar only answers one already-authorised step, so
 * the run is never blocked behind an OS modal that cannot be dismissed.
 */

/**
 * Badge text per preview kind. `delete`/`move`/`batch` come from the newer file
 * tools; `icons.js` has no dedicated glyph for them (only generic `trash`,
 * `folder` and `folder-open`), so the badge stays text-only and no unregistered
 * icon name is introduced. An unknown kind is labelled and shown as a plain
 * write, never dropped.
 */
const ACTION_LABELS = {
  write: '修改文件',
  replace: '修改文件',
  delete: '删除文件',
  move: '移动文件',
  batch: '批量修改',
};

function actionOf(request) {
  if (request?.capability === 'cookie') return { label: 'Cookie 登录', tone: 'cookie' };
  if (request?.capability === 'exec') return { label: '运行命令', tone: 'exec' };
  const kind = request?.preview?.kind;
  return { label: ACTION_LABELS[kind] ?? '修改文件', tone: kind ?? 'write' };
}

function hasSelection() {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  try { return (window.getSelection()?.toString() ?? '').length > 0; } catch { return false; }
}

/** Electron's preload clipboard first, then the browser API as a fallback. */
function copyText(text, clipboard) {
  let api = clipboard;
  if (!api && typeof window !== 'undefined') api = window.movaDesktop?.clipboard;
  return Promise.resolve()
    .then(() => {
      if (api?.writeText) return api.writeText(text);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
      throw new Error('no-clipboard');
    })
    .then(() => true)
    .catch(() => false);
}

function useCopyFeedback(clipboard) {
  const [toast, setToast] = useState('');
  const timer = useRef(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function flash(message) {
    if (timer.current) clearTimeout(timer.current);
    setToast(message);
    timer.current = setTimeout(() => setToast(''), 2400);
  }
  async function copy(text, success) {
    const ok = await copyText(text, clipboard);
    flash(ok ? success : '复制失败，请手动选择文本后复制');
  }
  return { toast, copy, flash };
}

function useFileDiff(before, after) {
  const oversized = exceedsDiffLimit(before, after);
  const diff = useMemo(
    () => (oversized ? null : computeLineDiff(before, after)),
    [before, after, oversized],
  );
  const summary = useMemo(() => (diff ? diffSummary(diff) : null), [diff]);
  return { oversized, diff, summary };
}

function DiffStat({ summary }) {
  if (!summary) return <span className="approval-stat is-muted">未计算 diff</span>;
  return (
    <span className="approval-stat">
      <span className="is-add">+{summary.added}</span>
      <span className="is-remove">−{summary.removed}</span>
    </span>
  );
}

/**
 * The main process exposes `files.reveal({ rootId, path })`: the opaque id of
 * the *registered* folder plus a path relative to it. The approval request now
 * carries that id explicitly (`permissions.confirm` adds `rootId` and
 * `rootName`), so the button is live — but only from those fields.
 *
 * `rootIdOf` never derives an id from the preview path. That path starts with
 * the folder's display *name*, and matching a display name back to a registered
 * root would be a guess: two folders can share a basename, and the wrong root
 * would reveal the wrong file. No id in the payload means no button.
 */
function rootIdOf(request) {
  const candidate = request?.rootId ?? request?.preview?.rootId;
  return typeof candidate === 'string' && candidate ? candidate : '';
}

/**
 * `files.reveal` expects a path *inside* the root, but a preview shows
 * `<rootName>/<relPath>` (that is how `previewOf` builds it). Handing the
 * display path to the bridge would resolve to `<root>/<rootName>/<rel>` and fail
 * with `not-found`, so the exact `<rootName>/` prefix is removed here — one
 * occurrence, using the root name the main process sent in the same payload.
 * An explicit `relPath` from a newer payload wins, and when neither exists the
 * function returns '' so the caller hides the button instead of guessing.
 */
function rootRelativePath(request, shownPath) {
  if (typeof shownPath !== 'string' || !shownPath) return '';
  const explicit = request?.relPath ?? request?.preview?.relPath;
  if (typeof explicit === 'string' && explicit) return explicit;
  const rootName = request?.rootName;
  if (typeof rootName === 'string' && rootName && shownPath.startsWith(`${rootName}/`)) {
    return shownPath.slice(rootName.length + 1);
  }
  return '';
}

function RevealButton({ path, revealFile }) {
  if (typeof revealFile !== 'function') return null;
  return (
    <button
      type="button"
      className="approval-chip"
      title={`在资源管理器中显示 ${path}`}
      onClick={() => { Promise.resolve(revealFile(path)).catch(() => {}); }}
    >
      在资源管理器中显示
    </button>
  );
}

function CopyPathButton({ path, onCopyPath }) {
  return (
    <button
      type="button"
      className="approval-chip"
      title={`复制 ${path}`}
      onClick={() => onCopyPath(path)}
    >
      复制路径
    </button>
  );
}

function PlainPairs({ before, after, reason }) {
  return (
    <div className="approval-preview" role="group" aria-label="修改前和修改后">
      {reason && <p className="approval-note approval-preview-wide">{reason}</p>}
      {before != null && <pre className="approval-before" aria-label="修改前">{before}</pre>}
      {after != null && <pre className="approval-after" aria-label="修改后">{after}</pre>}
    </div>
  );
}

function DiffRow({ entry, onCopyLine }) {
  const lineNumber = entry.afterLine ?? entry.beforeLine;
  const sign = entry.type === 'add' ? '+' : entry.type === 'remove' ? '−' : ' ';
  return (
    <div
      className={`approval-diff-line is-${entry.type}`}
      title={lineNumber ? `点击复制第 ${lineNumber} 行` : undefined}
      onClick={() => {
        // Selecting diff text to copy it by hand must not also fire the row copy.
        if (hasSelection() || !lineNumber) return;
        onCopyLine(lineNumber);
      }}
    >
      <span className="approval-diff-number" aria-hidden="true">{entry.beforeLine ?? ''}</span>
      <span className="approval-diff-number" aria-hidden="true">{entry.afterLine ?? ''}</span>
      <span className="approval-diff-sign" aria-hidden="true">{sign}</span>
      <span className="approval-diff-text">{entry.text}</span>
    </div>
  );
}

/**
 * Diff rows with the "first 300 lines" rule. `white-space: pre` keeps every
 * space and tab visible while leaving the text copyable verbatim.
 */
function DiffBody({ diff, path, onCopyLine }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? diff : diff.slice(0, DEFAULT_DIFF_LINES);
  return (
    <>
      <div
        className="approval-diff"
        role="group"
        aria-label={`${path} 的行级差异，点击某一行复制路径和行号`}
      >
        {rows.map((entry, index) => (
          <DiffRow
            key={index}
            entry={entry}
            onCopyLine={lineNumber => onCopyLine(path, lineNumber)}
          />
        ))}
      </div>
      {rows.length < diff.length && (
        <button type="button" className="approval-more" onClick={() => setExpanded(true)}>
          显示全部（共 {diff.length} 行）
        </button>
      )}
    </>
  );
}

function FileBody({ path, before, after, truncated, oversized, diff, onCopyLine }) {
  if (oversized) {
    return (
      <PlainPairs
        before={before}
        after={after}
        reason={`文件超过 ${DIFF_CHAR_LIMIT.toLocaleString('zh-CN')} 字符，未计算 diff；下面是修改前/修改后的纯文本对照。`}
      />
    );
  }
  // A move/rename has no text on either side; an empty diff frame would be noise.
  if (before == null && after == null) {
    return <p className="approval-note">这个操作没有内容变更（只移动或重命名文件）。</p>;
  }
  return (
    <>
      {truncated && (
        <p className="approval-note">
          主进程只发送了预览片段（有行数/字符上限），diff 基于截断后的内容，可能不完整。
        </p>
      )}
      <DiffBody diff={diff} path={path} onCopyLine={onCopyLine} />
    </>
  );
}

/** One file preview: header with path + `+X −Y`, then the diff rows. */
function SingleFilePreview({ preview, revealFile, onCopyPath, onCopyLine }) {
  const path = typeof preview.path === 'string' && preview.path ? preview.path : '文件';
  const { oversized, diff, summary } = useFileDiff(preview.before, preview.after);
  return (
    <section className="approval-file">
      <div className="approval-file-head">
        <span className="approval-file-path" title={path}>{path}</span>
        <DiffStat summary={summary} />
        <span className="approval-file-actions">
          <RevealButton path={path} revealFile={revealFile} />
          <CopyPathButton path={path} onCopyPath={onCopyPath} />
        </span>
      </div>
      <div className="approval-file-body">
        <FileBody
          path={path}
          before={preview.before}
          after={preview.after}
          truncated={preview.truncated === true}
          oversized={oversized}
          diff={diff}
          onCopyLine={onCopyLine}
        />
      </div>
    </section>
  );
}

function BatchFileCard({ entry, index, open, onToggle, revealFile, onCopyPath, onCopyLine }) {
  const path = entry.path || `文件 ${index + 1}`;
  const bodyId = useId();
  return (
    <section className="approval-batch-file">
      <div className="approval-batch-head">
        <button
          type="button"
          className="approval-fold"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className={`approval-caret${open ? ' is-open' : ''}`} aria-hidden="true">▸</span>
          <span className="approval-file-path" title={path}>{path}</span>
          <DiffStat summary={entry.summary} />
        </button>
        <span className="approval-file-actions">
          <RevealButton path={path} revealFile={revealFile} />
          <CopyPathButton path={path} onCopyPath={onCopyPath} />
        </span>
      </div>
      <div className="approval-file-body" id={bodyId} hidden={!open}>
        <FileBody
          path={path}
          before={entry.before}
          after={entry.after}
          truncated={entry.truncated}
          oversized={entry.oversized}
          diff={entry.diff}
          onCopyLine={onCopyLine}
        />
      </div>
    </section>
  );
}

function BatchPreview({ preview, revealFile, onCopyPath, onCopyLine }) {
  const files = useMemo(
    () => (Array.isArray(preview.files) ? preview.files.filter(file => file && typeof file === 'object') : []),
    [preview.files],
  );
  // The first file is open so the common single-file batch reads like before.
  const [openSections, setOpenSections] = useState(() => new Set([0]));

  // One diff per file, computed once: the summary in the title and the rows in
  // the body must agree, and re-running the LCS on every render would be waste.
  const entries = useMemo(() => files.map(file => {
    const before = file.before ?? null;
    const after = file.after ?? null;
    const oversized = exceedsDiffLimit(before, after);
    const diff = oversized ? null : computeLineDiff(before, after);
    return {
      path: typeof file.path === 'string' ? file.path : '',
      before,
      after,
      truncated: file.truncated === true,
      oversized,
      diff,
      summary: diff ? diffSummary(diff) : null,
    };
  }), [files]);

  const totals = entries.reduce(
    (acc, entry) => ({
      added: acc.added + (entry.summary?.added ?? 0),
      removed: acc.removed + (entry.summary?.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );
  const skipped = entries.filter(entry => entry.summary === null).length;

  if (!files.length) {
    return <p className="approval-note">这个批量请求没有附带文件明细。</p>;
  }

  function toggle(index) {
    setOpenSections(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <>
      <p className="approval-batch-summary" aria-live="polite">
        {files.length} 个文件 · <span className="is-add">+{totals.added}</span>{' '}
        <span className="is-remove">−{totals.removed}</span>
        {skipped > 0 && `（${skipped} 个文件超过 ${DIFF_CHAR_LIMIT.toLocaleString('zh-CN')} 字符，未计算 diff）`}
      </p>
      <div className="approval-batch">
        {entries.map((entry, index) => (
          <BatchFileCard
            key={`${entry.path || 'file'}:${index}`}
            entry={entry}
            index={index}
            open={openSections.has(index)}
            onToggle={() => toggle(index)}
            revealFile={revealFile}
            onCopyPath={onCopyPath}
            onCopyLine={onCopyLine}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Renders the preview for one request. Unknown `kind` (a newer main process, or
 * a malformed payload) deliberately falls back to the old two-column
 * before/after view instead of throwing.
 */
function ApprovalPreview({ preview, revealFile, onCopyPath, onCopyLine }) {
  if (preview.kind === 'batch') {
    return <BatchPreview preview={preview} revealFile={revealFile} onCopyPath={onCopyPath} onCopyLine={onCopyLine} />;
  }
  if (ACTION_LABELS[preview.kind]) {
    return (
      <SingleFilePreview
        preview={preview}
        revealFile={revealFile}
        onCopyPath={onCopyPath}
        onCopyLine={onCopyLine}
      />
    );
  }
  return <PlainPairs before={preview.before} after={preview.after} />;
}

function hasPreviewContent(preview) {
  if (!preview || typeof preview !== 'object') return false;
  if (preview.kind === 'batch') return true;
  return preview.before != null || preview.after != null;
}

export function ApprovalBar({ bridge, clipboard, desktop }) {
  const [queue, setQueue] = useState([]);
  const [sending, setSending] = useState(false);
  const { toast, copy, flash } = useCopyFeedback(clipboard);

  useEffect(() => {
    if (!bridge?.onRequest) return undefined;
    const offRequest = bridge.onRequest(request => {
      if (!request?.id) return;
      setQueue(items => (items.some(item => item.id === request.id) ? items : [...items, request]));
    });
    const offClose = bridge.onClose?.(({ id } = {}) => setQueue(items => items.filter(item => item.id !== id)));
    return () => { offRequest?.(); offClose?.(); };
  }, [bridge]);

  if (!queue.length) return null;
  const current = queue[0];
  const preview = current.preview;
  const action = actionOf(current);

  // Reveal is wired only when the bridge exists *and* this request carries a
  // root id and enough information to name a path inside it (see `rootIdOf`
  // and `rootRelativePath`). Otherwise `revealFile` is null and every preview
  // hides the button, which is the honest state rather than a dead control.
  const revealBridge = desktop?.files?.reveal;
  const rootId = rootIdOf(current);
  const revealFile = typeof revealBridge === 'function' && rootId
    ? shownPath => {
      const relPath = rootRelativePath(current, shownPath);
      if (!relPath) {
        flash('无法确定这个文件在项目文件夹内的路径。');
        return Promise.resolve();
      }
      return Promise.resolve(revealBridge({ rootId, path: relPath }))
        .then(result => {
          if (!result?.ok) flash(revealErrorText(result?.error));
        })
        .catch(() => { flash(revealErrorText()); });
    }
    : null;

  async function decide(decision) {
    const id = current.id;
    if (sending) return;
    setSending(true);
    try {
      const result = await bridge.respond(id, decision);
      if (!result?.ok) {
        flash(result?.error === 'expired' ? '审批已过期或已处理。' : '审批答复未送达，请重试。');
        return;
      }
      setQueue(items => items.filter(item => item.id !== id));
    } catch {
      flash('审批答复未送达，请重试。');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="approval-bar" role="group" aria-label="操作审批">
      <div className="approval-head">
        <span className={`approval-badge is-${action.tone}`}>{action.label}</span>
        <strong>{current.message}</strong>
        {queue.length > 1 && <span className="approval-count">还有 {queue.length - 1} 个请求</span>}
      </div>
      {current.detail && <p className="approval-detail">{current.detail}</p>}
      {hasPreviewContent(preview) && (
        <ApprovalPreview
          key={current.id}
          preview={preview}
          revealFile={revealFile}
          onCopyPath={path => copy(path, `已复制 ${path}`)}
          onCopyLine={(path, lineNumber) => copy(`${path}:${lineNumber}`, `已复制 ${path}:${lineNumber}`)}
        />
      )}
      <p className="approval-toast" role="status" aria-live="polite">{toast}</p>
      <div className="approval-actions" aria-busy={sending}>
        <button type="button" className="settings-button danger" onClick={() => decide('deny')}>拒绝</button>
        <button type="button" className="settings-button" onClick={() => decide('once')}>允许一次</button>
        {current.allowSession !== false && <button type="button" className="settings-button primary" onClick={() => decide('session')}>本次会话允许</button>}
      </div>
    </section>
  );
}
