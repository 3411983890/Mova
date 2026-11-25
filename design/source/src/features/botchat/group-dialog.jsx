// 新建群聊：参考「新建项目」的结构——名称、成员、工作位置。
import React, { useEffect, useState } from 'react';
import { Folder, Hash } from '@keyline-icons/react';
import { BallAvatar } from '../../../bot-conversation.jsx';
import './group-dialog.css';

// 选中成员时放出彩带：沿用 emotion-ball 的六色调色板与爆发式扩散。
const CONFETTI_COLORS = ['#f9705c', '#5b95f0', '#3fbe86', '#f5b13f', '#9a72ee', '#35c3bd'];

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

export function GroupBuilder({ bots, onCreate, onCancel, onPickPlace }) {
  const [name, setName] = useState('');
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
      // 以头像中心为原点记录视口坐标，彩带用 fixed 定位，不会被弹窗滚动区裁掉。
      const rect = element.getBoundingClientRect();
      setBursts(list => [...list, { id, seed: Date.now() + Math.random(), x: rect.left + rect.width / 2, y: rect.top + 24 }]);
    }
  };

  const submit = event => {
    event.preventDefault();
    const title = name.trim();
    if (!title) { setError('给群聊起个名字'); return; }
    if (picked.length < 2) { setError('至少选择 2 个 Bot 才能建群'); return; }
    onCreate({ name: title, members: picked, place });
  };

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

      <section className="group-section" aria-labelledby="group-members-label">
        <div className="group-section-head">
          <span className="group-field-label" id="group-members-label">成员</span>
          <span className="group-section-note">已选 {picked.length} 个 · 至少 2 个</span>
        </div>
        <div className="group-members">
          {bots.map(bot => {
            const active = picked.includes(bot.id);
            return <button type="button" key={bot.id} className={`group-member${active ? ' is-picked' : ''}`} aria-pressed={active} onClick={event => toggle(bot.id, event.currentTarget)}>
              <BallAvatar {...bot.appearance} />
              <span>{bot.name}</span>
            </button>;
          })}
        </div>
      </section>

      <section className="group-section">
        <div className="group-section-head">
          <span className="group-field-label">工作位置</span>
        </div>
        <button type="button" className="group-place" aria-haspopup="dialog" onClick={() => onPickPlace(place, setPlace)}>
          <Folder size={12} />
          <span>{place ? place.name : '未设置'}</span>
          <em>{place?.kind === 'project' ? '项目' : place ? '文件夹' : '可选'}</em>
        </button>
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
