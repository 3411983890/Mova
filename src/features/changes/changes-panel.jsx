// The build uses the classic JSX transform (no esbuild config), so React must
// stay imported even though only JSX is used.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_DIFF_LINES,
  DIFF_CHAR_LIMIT,
  computeLineDiff,
  diffSummary,
  exceedsDiffLimit,
} from '../approvals/diff.js';
import {
  changeErrorText,
  formatBytes,
  formatChangeTime,
  kindLabel,
  kindTone,
  revealErrorText,
} from './change-format.js';
import './changes-panel.css';

/**
 * "改动历史" for one registered project folder.
 *
 * The main process keeps a per-root history file and exposes it through
 * `bridge.changes.list` / `bridge.changes.diff`; this panel only displays what
 * that bridge returns. Every bridge call is treated as optional: a renderer
 * running against an older preload (no `changes`, no `files.reveal`) must show a
 * plain note instead of throwing, and must hide the reveal action entirely.
 */

const LIST_HINT = '只显示最近 100 条';

/** One row of the diff, using the approval bar's existing diff classes. */
function DiffRow({ entry }) {
  const sign = entry.type === 'add' ? '+' : entry.type === 'remove' ? '−' : ' ';
  return (
    <div className={`approval-diff-line is-${entry.type}`}>
      <span className="approval-diff-number" aria-hidden="true">{entry.beforeLine ?? ''}</span>
      <span className="approval-diff-number" aria-hidden="true">{entry.afterLine ?? ''}</span>
      <span className="approval-diff-sign" aria-hidden="true">{sign}</span>
      <span className="approval-diff-text">{entry.text}</span>
    </div>
  );
}

/**
 * Diff rows with the same "first 300 lines" fold as the approval bar. The
 * wrapper carries `approval-bar` on purpose: the diff palette, the two line
 * number columns and the row backgrounds all come from `approval-bar.css`, so
 * this panel never grows a second set of colours that could drift from it.
 */
function DiffBody({ diff, path }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? diff : diff.slice(0, DEFAULT_DIFF_LINES);
  return (
    <div className="approval-bar changes-diff">
      <div className="approval-diff" role="group" aria-label={`${path} 的行级差异`}>
        {rows.map((entry, index) => <DiffRow key={index} entry={entry} />)}
      </div>
      {rows.length < diff.length && (
        <button type="button" className="approval-more" onClick={() => setExpanded(true)}>
          显示全部（共 {diff.length} 行）
        </button>
      )}
    </div>
  );
}

/** `+X −Y` for the selected change, computed from the same rows that render. */
function DiffStat({ diff }) {
  const summary = useMemo(() => diffSummary(diff), [diff]);
  return (
    <span className="approval-stat">
      <span className="is-add">+{summary.added}</span>
      <span className="is-remove">−{summary.removed}</span>
    </span>
  );
}

function DetailHead({ entry, canReveal, onReveal }) {
  return (
    <div className="changes-detail-head">
      <div className="changes-detail-title">
        <span className={`changes-kind is-${kindTone(entry.kind)}`}>{kindLabel(entry.kind)}</span>
        <span className="changes-detail-path" title={entry.path}>{entry.path}</span>
      </div>
      <p className="changes-detail-meta">
        <span>{formatChangeTime(entry.time)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatBytes(entry.bytes)}</span>
      </p>
      {canReveal && (
        <button
          type="button"
          className="settings-button changes-reveal"
          title={`在资源管理器中显示 ${entry.path}`}
          onClick={onReveal}
        >
          在资源管理器中显示
        </button>
      )}
    </div>
  );
}

export function ChangesPanel({ root, bridge, onClose }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const requestRef = useRef(0);
  const [list, setList] = useState({ status: 'loading', changes: [], error: '' });
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState({ status: 'idle', entry: null, diff: null, truncated: false, error: '' });
  const [revealNote, setRevealNote] = useState('');

  const changesBridge = bridge?.changes;
  const canList = typeof changesBridge?.list === 'function';
  const canReveal = typeof bridge?.files?.reveal === 'function';
  const rootId = root?.id;

  useEffect(() => {
    if (!canList || !rootId) return undefined;
    let alive = true;
    setList({ status: 'loading', changes: [], error: '' });
    Promise.resolve()
      .then(() => changesBridge.list({ rootId }))
      .then(result => {
        if (!alive) return;
        if (result?.ok) {
          const raw = Array.isArray(result.value?.changes) ? result.value.changes : [];
          const changes = raw.filter(change => change && typeof change === 'object');
          setList({ status: 'ready', changes, error: '' });
        } else {
          setList({ status: 'error', changes: [], error: changeErrorText(result?.error) });
        }
      })
      .catch(() => {
        if (alive) setList({ status: 'error', changes: [], error: changeErrorText() });
      });
    return () => { alive = false; };
  }, [canList, changesBridge, rootId]);

  // Esc closes the dialog. Registered in the capture phase so the settings
  // shell's own Escape handler (which would close the whole settings view
  // underneath this modal) never sees the key.
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // Move focus into the dialog so the keyboard lands here, not on the row
  // behind the overlay. The trigger is refocused by the caller on close.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  async function openChange(change) {
    const changeId = change?.id;
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    setSelectedId(changeId);
    setRevealNote('');
    setDetail({ status: 'loading', entry: change, diff: null, truncated: false, error: '' });

    if (typeof changesBridge?.diff !== 'function' || !rootId) {
      setDetail({ status: 'error', entry: change, diff: null, truncated: false, error: '这个版本还不支持查看改动详情。' });
      return;
    }

    let result;
    try {
      result = await changesBridge.diff({ rootId, changeId });
    } catch {
      result = undefined;
    }
    // A slower answer for an earlier click must not overwrite the newer one.
    if (requestRef.current !== ticket) return;

    if (!result?.ok) {
      setDetail({ status: 'error', entry: change, diff: null, truncated: false, error: changeErrorText(result?.error) });
      return;
    }

    const value = result.value ?? {};
    const before = typeof value.before === 'string' ? value.before : null;
    const after = typeof value.after === 'string' ? value.after : null;
    const entry = { ...change, ...value };
    if (exceedsDiffLimit(before, after)) {
      setDetail({
        status: 'too-large',
        entry,
        diff: null,
        truncated: false,
        error: `文件超过 ${DIFF_CHAR_LIMIT.toLocaleString('zh-CN')} 字符，没有计算 diff。`,
      });
      return;
    }
    setDetail({
      status: 'ready',
      entry,
      diff: computeLineDiff(before, after),
      truncated: value.truncated === true,
      error: '',
      empty: before == null && after == null,
    });
  }

  async function reveal() {
    const path = detail.entry?.path;
    if (!canReveal || !path || !rootId) return;
    let result;
    try {
      result = await bridge.files.reveal({ rootId, path });
    } catch {
      result = undefined;
    }
    if (result?.ok) setRevealNote('已在资源管理器中定位。');
    else setRevealNote(revealErrorText(result?.error));
  }

  const changes = list.changes;

  function listBody() {
    if (!canList) {
      return <p className="changes-note">这个版本还没有接入改动历史，暂时看不到记录。</p>;
    }
    if (list.status === 'loading') return <p className="changes-note">正在读取改动历史…</p>;
    if (list.status === 'error') {
      return <p className="changes-error" role="alert">{list.error}</p>;
    }
    if (!changes.length) {
      return <p className="changes-note">这个文件夹还没有改动记录。模型写入或修改文件后会出现在这里。</p>;
    }
    return (
      <ul className="changes-list-items">
        {changes.map((change, index) => {
          const key = change.id ?? `${change.path ?? 'change'}:${index}`;
          const selected = change.id === selectedId;
          return (
            <li key={key}>
              <button
                type="button"
                className={`changes-item${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => { void openChange(change); }}
              >
                <span className="changes-item-top">
                  <span className={`changes-kind is-${kindTone(change.kind)}`}>{kindLabel(change.kind)}</span>
                  <span className="changes-item-time">{formatChangeTime(change.time)}</span>
                </span>
                <span className="changes-item-path" title={change.path}>{change.path || '路径未知'}</span>
                <span className="changes-item-bytes">{formatBytes(change.bytes)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  function detailBody() {
    if (detail.status === 'idle') {
      return <p className="changes-note">从左边选一条改动，查看逐行差异。</p>;
    }
    if (detail.status === 'loading') return <p className="changes-note">正在读取这条改动…</p>;
    if (detail.status === 'error') {
      return (
        <>
          <p className="changes-error" role="alert">{detail.error}</p>
          {detail.entry && (
            <p className="changes-note">这条记录：{detail.entry.path || '路径未知'}</p>
          )}
        </>
      );
    }
    if (detail.status === 'too-large') {
      return (
        <>
          <DetailHead entry={detail.entry} canReveal={canReveal} onReveal={() => { void reveal(); }} />
          {revealNote && <p className="changes-note" role="status">{revealNote}</p>}
          <p className="changes-note">{detail.error}</p>
        </>
      );
    }

    const entry = detail.entry;
    return (
      <>
        <DetailHead entry={entry} canReveal={canReveal} onReveal={() => { void reveal(); }} />
        {revealNote && <p className="changes-note" role="status">{revealNote}</p>}
        {detail.truncated && (
          <p className="changes-note">主进程只发送了预览片段，diff 基于截断后的内容，可能不完整。</p>
        )}
        {detail.empty ? (
          <p className="changes-note">这个操作没有内容变更（只移动或重命名文件）。</p>
        ) : (
          <>
            <p className="approval-bar changes-diff changes-detail-stat"><DiffStat diff={detail.diff} /></p>
            <DiffBody diff={detail.diff} path={entry.path || '文件'} />
          </>
        )}
      </>
    );
  }

  const content = (
    <div
      className="changes-overlay"
      // A click on the backdrop closes; a click inside the panel must not,
      // because dragging to select diff text ends with a click event too.
      onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <div
        className="changes-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="changes-head">
          <div className="changes-head-text">
            <h2 className="changes-title" id={titleId}>
              改动历史 · {root?.name || '项目文件夹'}
            </h2>
            {root?.path && <p className="changes-subtitle" title={root.path}>{root.path}</p>}
          </div>
          <button type="button" className="changes-close" aria-label="关闭改动历史" onClick={() => onClose?.()}>
            ✕
          </button>
        </header>

        <div className="changes-body">
          <section className="changes-list" aria-label="改动列表">
            <p className="changes-count" aria-live="polite">
              {list.status === 'ready' ? `共 ${changes.length} 条 · ${LIST_HINT}` : LIST_HINT}
            </p>
            {listBody()}
          </section>
          <section className="changes-detail" aria-label="改动详情">
            {detailBody()}
          </section>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? null : createPortal(content, document.body);
}
