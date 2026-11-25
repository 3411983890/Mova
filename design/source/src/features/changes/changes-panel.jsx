import React, { useMemo, useState } from 'react';
import './changes-panel.css';

/* 改动历史：某个已登记文件夹的文件改动流水，右侧抽屉。
   原型使用演示数据，真实版本读 changes.list / changes.diff。 */

const DEMO_CHANGES = [
  {
    id: 'c1',
    kind: 'write',
    path: 'src/features/chat/chat-transcript.tsx',
    at: Date.now() - 6 * 60 * 1000,
    decision: '已允许',
    added: 5,
    removed: 4,
    before: [
      'export function ChatTranscript({ turns, viewport, busy }) {',
      '  const listRef = useRef(null);',
      '  useEffect(() => scrollToBottom(listRef, viewport), [turns.length]);',
      '  return <ol ref={listRef} className="transcript">{turns.map(renderTurn)}</ol>;',
      '}',
    ].join('\n'),
    after: [
      'export function ChatTranscript({ turns, viewport, busy, onRetry }) {',
      '  const listRef = useRef(null);',
      '  const stick = useStickToBottom(listRef, viewport);',
      '  useEffect(() => stick(), [turns.length]);',
      '  return <ol ref={listRef} className="transcript">{turns.map(turn => renderTurn(turn, onRetry))}</ol>;',
      '}',
    ].join('\n'),
  },
  {
    id: 'c2',
    kind: 'write',
    path: 'styles.css',
    at: Date.now() - 42 * 60 * 1000,
    decision: '已允许',
    added: 3,
    removed: 1,
    before: '.chat-row { grid-template-columns: minmax(0, 1fr) 54px; }',
    after: '.chat-row { grid-template-columns: minmax(0, 1fr) auto; padding-right: 4px; }',
  },
  {
    id: 'c3',
    kind: 'exec',
    path: 'pnpm test -- --run',
    at: Date.now() - 3 * 60 * 60 * 1000,
    decision: '已拒绝',
    added: 0,
    removed: 0,
  },
];

const KIND_LABEL = { write: '修改文件', exec: '运行命令', delete: '删除文件', move: '移动文件', batch: '批量修改' };

function timeAgo(at) {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function lineDiff(before = '', after = '') {
  const left = String(before).split('\n');
  const right = String(after).split('\n');
  const rows = [];
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    if (left[i] === right[i]) {
      if (left[i] !== undefined) rows.push({ type: 'same', text: left[i], beforeLine: i + 1, afterLine: i + 1 });
      continue;
    }
    if (left[i] !== undefined) rows.push({ type: 'remove', text: left[i], beforeLine: i + 1 });
    if (right[i] !== undefined) rows.push({ type: 'add', text: right[i], afterLine: i + 1 });
  }
  return rows;
}

function Diff({ before, after, path }) {
  const rows = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <div className="approval-bar changes-diff">
      <div className="approval-diff" role="group" aria-label={`${path} 的行级差异`}>
        {rows.map((row, index) => (
          <div className={`approval-diff-line is-${row.type}`} key={index}>
            <span className="approval-diff-number" aria-hidden="true">{row.beforeLine ?? ''}</span>
            <span className="approval-diff-number" aria-hidden="true">{row.afterLine ?? ''}</span>
            <span className="approval-diff-sign" aria-hidden="true">{row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ' '}</span>
            <span className="approval-diff-text">{row.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChangesPanel({ root, onClose }) {
  const [openId, setOpenId] = useState('');
  const [filter, setFilter] = useState('all');
  const changes = useMemo(
    () => DEMO_CHANGES.filter(item => (filter === 'all' ? true : filter === 'write' ? item.kind !== 'exec' : item.kind === 'exec')),
    [filter],
  );

  return (
    <>
      <div className="changes-backdrop" onClick={onClose} />
      <aside className="changes-panel" role="dialog" aria-modal="false" aria-label={`${root.name} 的改动历史`}>
        <header className="changes-head">
          <div>
            <h3>改动历史</h3>
            <p className="changes-subtitle" title={root.path}>{root.name} · {root.path}</p>
          </div>
          <button type="button" className="changes-close" aria-label="关闭改动历史" onClick={onClose}>×</button>
        </header>

        <div className="changes-filter" role="tablist" aria-label="筛选改动类型">
          {[['all', '全部'], ['write', '文件改动'], ['exec', '命令']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className="changes-filter-button"
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
          <span className="changes-hint">只显示最近 100 条</span>
        </div>

        <div className="changes-list">
          {changes.length === 0 && <p className="changes-empty">还没有符合条件的改动。</p>}
          {changes.map(change => {
            const open = openId === change.id;
            return (
              <article className={`changes-item ${open ? 'is-open' : ''}`} key={change.id}>
                <button type="button" className="changes-item-head" aria-expanded={open} onClick={() => setOpenId(open ? '' : change.id)}>
                  <span className={`changes-kind is-${change.kind}`}>{KIND_LABEL[change.kind] ?? change.kind}</span>
                  <span className="changes-path" title={change.path}>{change.path}</span>
                  {change.kind !== 'exec' && (
                    <span className="changes-stat">
                      <span className="is-add">+{change.added}</span>
                      <span className="is-remove">−{change.removed}</span>
                    </span>
                  )}
                  <span className="changes-time">{timeAgo(change.at)}</span>
                </button>
                {open && (
                  <div className="changes-body">
                    <p className="changes-meta">
                      {timeAgo(change.at)} · {change.decision}
                    </p>
                    {change.kind === 'exec'
                      ? <pre className="changes-command">{change.path}</pre>
                      : <Diff before={change.before} after={change.after} path={change.path} />}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </aside>
    </>
  );
}
