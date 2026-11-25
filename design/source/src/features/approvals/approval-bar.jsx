import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import './approval-bar.css';

/* 审批栏：一次写入或命令等待用户确认。原型用演示队列驱动，
   真实版本由 Electron 主进程推送。 */

const ACTION_LABELS = {
  write: '修改文件',
  replace: '修改文件',
  delete: '删除文件',
  move: '移动文件',
  batch: '批量修改',
  exec: '运行命令',
};

const TONE_OF_KIND = {
  write: 'write',
  replace: 'write',
  delete: 'danger',
  move: 'danger',
  batch: 'batch',
  exec: 'exec',
};

const DEFAULT_DIFF_LINES = 300;
const DIFF_CHAR_LIMIT = 60000;

/** 极简逐行 diff：原型只用于展示视觉，不做 LCS。 */
function computeLineDiff(before = '', after = '') {
  const left = String(before).split('\n');
  const right = String(after).split('\n');
  const rows = [];
  const max = Math.max(left.length, right.length);
  let added = 0;
  let removed = 0;
  for (let i = 0; i < max; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === b) {
      if (a !== undefined) rows.push({ type: 'same', text: a, beforeLine: i + 1, afterLine: i + 1 });
      continue;
    }
    if (a !== undefined) { rows.push({ type: 'remove', text: a, beforeLine: i + 1 }); removed += 1; }
    if (b !== undefined) { rows.push({ type: 'add', text: b, afterLine: i + 1 }); added += 1; }
  }
  return { rows, summary: { added, removed } };
}

function DiffStat({ summary }) {
  if (!summary) return null;
  return (
    <span className="approval-stat" aria-label={`新增 ${summary.added} 行，删除 ${summary.removed} 行`}>
      <span className="is-add">+{summary.added}</span>
      <span className="is-remove">−{summary.removed}</span>
    </span>
  );
}

function DiffRow({ entry, onCopyLine }) {
  const lineNumber = entry.afterLine ?? entry.beforeLine;
  const sign = entry.type === 'add' ? '+' : entry.type === 'remove' ? '−' : ' ';
  return (
    <div
      className={`approval-diff-line is-${entry.type}`}
      title={lineNumber ? `点击复制第 ${lineNumber} 行` : undefined}
      onClick={() => { if (lineNumber) onCopyLine?.(lineNumber); }}
    >
      <span className="approval-diff-number" aria-hidden="true">{entry.beforeLine ?? ''}</span>
      <span className="approval-diff-number" aria-hidden="true">{entry.afterLine ?? ''}</span>
      <span className="approval-diff-sign" aria-hidden="true">{sign}</span>
      <span className="approval-diff-text">{entry.text || ' '}</span>
    </div>
  );
}

function DiffBody({ diff, path, onCopyLine }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? diff : diff.slice(0, DEFAULT_DIFF_LINES);
  return (
    <>
      <div className="approval-diff" role="group" aria-label={`${path} 的行级差异`}>
        {rows.map((entry, index) => (
          <DiffRow key={index} entry={entry} onCopyLine={onCopyLine} />
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

function SingleFilePreview({ preview, onCopyPath, onCopyLine }) {
  const path = preview.path || '文件';
  const oversized = (preview.before?.length ?? 0) + (preview.after?.length ?? 0) > DIFF_CHAR_LIMIT;
  const { rows, summary } = useMemo(
    () => (oversized ? { rows: [], summary: null } : computeLineDiff(preview.before, preview.after)),
    [preview.before, preview.after, oversized],
  );
  return (
    <section className="approval-file">
      <div className="approval-file-head">
        <span className="approval-file-path" title={path}>{path}</span>
        <DiffStat summary={summary} />
        <span className="approval-file-actions">
          <button type="button" className="approval-chip" onClick={() => onCopyPath?.(path)}>复制路径</button>
        </span>
      </div>
      <div className="approval-file-body">
        {oversized ? (
          <div className="approval-preview">
            <p className="approval-note approval-preview-wide">
              文件超过 {DIFF_CHAR_LIMIT.toLocaleString('zh-CN')} 字符，未计算 diff；下面是修改前/修改后的纯文本对照。
            </p>
            <pre className="approval-before" aria-label="修改前">{preview.before}</pre>
            <pre className="approval-after" aria-label="修改后">{preview.after}</pre>
          </div>
        ) : preview.before == null && preview.after == null ? (
          <p className="approval-note">这个操作没有内容变更（只移动或重命名文件）。</p>
        ) : (
          <DiffBody diff={rows} path={path} onCopyLine={lineNumber => onCopyLine?.(path, lineNumber)} />
        )}
      </div>
    </section>
  );
}

function BatchPreview({ preview, onCopyPath, onCopyLine }) {
  const [openSections, setOpenSections] = useState(() => new Set());
  const files = preview.files ?? [];
  const entries = files.map(file => {
    const oversized = (file.before?.length ?? 0) + (file.after?.length ?? 0) > DIFF_CHAR_LIMIT;
    const { rows, summary } = oversized ? { rows: [], summary: null } : computeLineDiff(file.before, file.after);
    return { file, rows, summary };
  });
  const totals = entries.reduce((acc, entry) => ({
    added: acc.added + (entry.summary?.added ?? 0),
    removed: acc.removed + (entry.summary?.removed ?? 0),
  }), { added: 0, removed: 0 });
  const skipped = entries.filter(entry => entry.summary === null).length;

  if (!files.length) return <p className="approval-note">这个批量请求没有附带文件明细。</p>;

  function toggle(index) {
    setOpenSections(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
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
        {entries.map(({ file, rows, summary }, index) => {
          const path = file.path || `文件 ${index + 1}`;
          const open = openSections.has(index);
          return (
            <section className="approval-batch-file" key={`${path}:${index}`}>
              <button
                type="button"
                className="approval-batch-head"
                aria-expanded={open}
                onClick={() => toggle(index)}
              >
                <span className="approval-batch-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className="approval-file-path" title={path}>{path}</span>
                <DiffStat summary={summary} />
              </button>
              {open && (
                <div className="approval-file-body">
                  {summary === null
                    ? <p className="approval-note">文件过大，未计算 diff。</p>
                    : <DiffBody diff={rows} path={path} onCopyLine={lineNumber => onCopyLine?.(path, lineNumber)} />}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function Preview({ preview, onCopyPath, onCopyLine }) {
  if (!preview) return null;
  if (preview.kind === 'batch') return <BatchPreview preview={preview} onCopyPath={onCopyPath} onCopyLine={onCopyLine} />;
  if (ACTION_LABELS[preview.kind]) return <SingleFilePreview preview={preview} onCopyPath={onCopyPath} onCopyLine={onCopyLine} />;
  return (
    <div className="approval-preview">
      {preview.before != null && <pre className="approval-before" aria-label="修改前">{preview.before}</pre>}
      {preview.after != null && <pre className="approval-after" aria-label="修改后">{preview.after}</pre>}
    </div>
  );
}

function hasPreviewContent(preview) {
  if (!preview) return false;
  if (preview.kind === 'batch') return true;
  return preview.before != null || preview.after != null;
}

export function ApprovalBar({ requests = [], onDecide, onCopy }) {
  const [toast, setToast] = useState('');
  const timer = useRef(null);
  const bodyId = useId();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const current = requests[0];
  if (!current) return null;

  function flash(message) {
    if (timer.current) clearTimeout(timer.current);
    setToast(message);
    timer.current = setTimeout(() => setToast(''), 2200);
  }

  function copy(text, label) {
    const write = onCopy ? onCopy(text) : navigator.clipboard?.writeText(text);
    Promise.resolve(write).then(() => flash(`已复制 ${label}`)).catch(() => flash('复制失败'));
  }

  const kind = current.preview?.kind ?? (current.capability === 'exec' ? 'exec' : 'write');
  const label = current.capability === 'exec' ? ACTION_LABELS.exec : (ACTION_LABELS[kind] ?? ACTION_LABELS.write);
  const tone = current.capability === 'exec' ? 'exec' : (TONE_OF_KIND[kind] ?? 'write');

  return (
    <section
      className="approval-bar"
      data-tone={tone}
      role="group"
      aria-label="操作审批"
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); onDecide?.(current.id, 'deny'); }
      }}
    >
      <div className="approval-head">
        <span className={`approval-badge is-${tone}`}>{label}</span>
        <strong>{current.message}</strong>
        {requests.length > 1 && <span className="approval-count">还有 {requests.length - 1} 个请求</span>}
      </div>
      {current.detail && <p className="approval-detail" id={bodyId}>{current.detail}</p>}
      {hasPreviewContent(current.preview) && (
        <Preview
          preview={current.preview}
          onCopyPath={path => copy(path, path)}
          onCopyLine={(path, line) => copy(`${path}:${line}`, `${path}:${line}`)}
        />
      )}
      <p className="approval-toast" role="status" aria-live="polite">{toast}</p>
      <div className="approval-actions">
        <button type="button" className="approval-button danger" onClick={() => onDecide?.(current.id, 'deny')}>拒绝</button>
        <button type="button" className="approval-button" onClick={() => onDecide?.(current.id, 'once')}>允许一次</button>
        <button type="button" className="approval-button primary" onClick={() => onDecide?.(current.id, 'session')}>本次会话允许</button>
      </div>
    </section>
  );
}
