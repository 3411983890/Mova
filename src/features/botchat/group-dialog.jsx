/**
 * 负责：新建 Bot 群聊对话框，支持按稳定 Bot ID 选择成员（对同名 Bot 自动展示短 ID 与标签消歧）、选择群聊模式与工作目录。
 * 不负责：群聊持久化逻辑（通过 onCreate 回调传递给 app.js 与后端 runtime）。
 * 被谁调用：app.js。
 */
import React, { useEffect, useState } from 'react';
import { Hash } from '@keyline-icons/react';
import { BallAvatar } from '../bot/bot-conversation.jsx';
import { WorkspaceLocation } from '../cloud-connections/workspace-location.jsx';
import './group-dialog.css';

const CONFETTI_COLORS = ['#f9705c', '#5b95f0', '#3fbe86', '#f5b13f', '#9a72ee', '#35c3bd'];
const GROUP_MODE_OPTIONS = [
  { id: 'natural', label: '自然（默认）' },
  { id: 'quiet', label: '安静（仅 @）' },
  { id: 'discussion', label: '讨论（多方发言）' },
  { id: 'task', label: '任务（主持人协同）' },
];

function Confetti({ x, y, seed }) {
  const pieces = React.useMemo(() => Array.from({ length: 18 }, (_, index) => {
    const angle = (index / 18) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 30 + Math.random() * 28;
    return {
      key: `${seed}-${index}`,
      color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance - 6,
      dx2: Math.cos(angle) * distance * 1.12,
      dy2: Math.sin(angle) * distance + 24,
      spin: Math.random() * 540 - 270,
      spin2: Math.random() * 720 - 360,
      width: 4 + Math.random() * 4,
      height: 5 + Math.random() * 6,
      duration: 620 + Math.random() * 320,
    };
  }), [seed]);
  return <span className="group-confetti" style={{ left: `${x}px`, top: `${y}px` }} aria-hidden="true">
    {pieces.map(piece => <i key={piece.key} style={{
      '--c': piece.color,
      '--dx': `${piece.dx.toFixed(1)}px`,
      '--dy': `${piece.dy.toFixed(1)}px`,
      '--dx2': `${piece.dx2.toFixed(1)}px`,
      '--dy2': `${piece.dy2.toFixed(1)}px`,
      '--spin': `${piece.spin.toFixed(0)}deg`,
      '--spin2': `${piece.spin2.toFixed(0)}deg`,
      width: `${piece.width.toFixed(1)}px`,
      height: `${piece.height.toFixed(1)}px`,
      animationDuration: `${piece.duration.toFixed(0)}ms`,
    }} />)}
  </span>;
}

export function GroupBuilder({ bots, onCreate, onCancel, location }) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [groupMode, setGroupMode] = useState('natural');
  const [picked, setPicked] = useState([]);
  const [place, setPlace] = useState(null);
  const [error, setError] = useState('');
  const [bursts, setBursts] = useState([]);

  useEffect(() => {
    if (!bursts.length) return undefined;
    const timer = setTimeout(() => setBursts([]), 1100);
    return () => clearTimeout(timer);
  }, [bursts]);

  const toggle = (id, element) => {
    setError('');
    const adding = !picked.includes(id);
    setPicked(list => adding ? [...list, id] : list.filter(item => item !== id));
    if (adding && element && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const rect = element.getBoundingClientRect();
      setBursts(list => [...list, { id, seed: Date.now() + Math.random(), x: rect.left + rect.width / 2, y: rect.top + 24 }]);
    }
  };

  const submit = event => {
    event.preventDefault();
    const title = name.trim();
    if (!title) { setError('给群聊起个名字'); return; }
    if (picked.length < 2) { setError('至少选择 2 个 Bot 才能建群'); return; }
    onCreate({ name: title, topic: topic.trim(), groupMode, members: picked, place });
  };

  const nameCounts = new Map();
  for (const bot of bots) nameCounts.set(bot.name, (nameCounts.get(bot.name) || 0) + 1);

  return <form className="group-dialog-form" onSubmit={submit}>
    <header className="group-dialog-head">
      <h2 id="group-dialog-title">新建群聊</h2>
      <button type="button" className="group-dialog-close" aria-label="关闭" onClick={onCancel}>×</button>
    </header>

    <div className="group-dialog-body">
      <label className="group-field">
        <span className="group-field-label">群聊名称</span>
        <span className="group-name-field">
          <Hash size={14} />
          <input autoFocus maxLength="30" value={name} placeholder="例如：周报小组" onChange={event => { setName(event.target.value); setError(''); }} />
        </span>
      </label>

      <section className="group-section" aria-label="工作位置">
        <div className="group-section-head">
          <span className="group-field-label">工作位置</span>
        </div>
        <WorkspaceLocation {...location} value={place} onChange={setPlace}
          onPickFolders={location?.pickFolder ? () => location.pickFolder(setPlace) : undefined} />
      </section>

      <label className="group-field">
        <span className="group-field-label">群聊话题 / 模式</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            className="group-name-field"
            style={{ flex: 1, color: '#f0f0f0', fontSize: '12px' }}
            maxLength="60"
            value={topic}
            placeholder="可选：如产品规划、代码审计"
            onChange={e => setTopic(e.target.value)}
          />
          <select
            className="group-name-field"
            style={{ width: '130px', color: '#f0f0f0', fontSize: '12px' }}
            aria-label="初始群聊模式"
            value={groupMode}
            onChange={e => setGroupMode(e.target.value)}
          >
            {GROUP_MODE_OPTIONS.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
          </select>
        </div>
      </label>

      <section className="group-section" aria-labelledby="group-members-label">
        <div className="group-section-head">
          <span className="group-field-label" id="group-members-label">成员</span>
          <span className="group-section-note">已选 {picked.length} 个 · 至少 2 个</span>
        </div>
        <div className="group-members">
          {bots.filter(b => b.status !== 'archived').map(bot => {
            const active = picked.includes(bot.id);
            const isDup = (nameCounts.get(bot.name) || 0) > 1;
            return <button type="button" key={bot.id} className={`group-member${active ? ' is-picked' : ''}`} aria-pressed={active} onClick={event => toggle(bot.id, event.currentTarget)}>
              <BallAvatar {...bot.appearance} />
              <span>{bot.name}{isDup ? `#${bot.id.slice(-4)}` : ''}</span>
            </button>;
          })}
        </div>
      </section>

      {error && <p className="group-dialog-error" role="alert">{error}</p>}
    </div>

    <footer className="group-dialog-actions">
      <button type="button" className="group-dialog-cancel" onClick={onCancel}>取消</button>
      <button type="submit" className="group-dialog-submit">创建群聊</button>
    </footer>

    {bursts.map(burst => <Confetti key={burst.seed} x={burst.x} y={burst.y} seed={burst.seed} />)}
  </form>;
}
