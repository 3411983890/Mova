// 通讯录：左侧是全部 Bot，右侧是所选 Bot 的个人主页。
// 数据由 app.js 持有（bot-directory.js），这里只管展示与本页的临时状态。
import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, BellOff, Bin, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CirclePlus, Code, Cpu, FileText, Globe, Image, Message, Pen, Search, Star, Terminal, TriangleAlert, X,
} from '@keyline-icons/react';
import { Star as StarFill } from '@keyline-icons/react/fill';
import { BallAvatar } from '../../../bot-conversation.jsx';
import { EFFORTS, MODELS, TOOLS, USAGE_DAYS, deletionImpact } from '../../../bot-directory.js';
import './contacts.css';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const toolIcons = { search: Globe, files: FileText, code: Code, terminal: Terminal, image: Image, memory: Brain };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

function elapsed(time, suffix = '') {
  const diff = Date.now() - time;
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟${suffix}`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时${suffix}`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天${suffix}`;
  return dateFormat.format(time);
}
function compact(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return value.toLocaleString('zh-CN');
}
const dayLabel = index => index === USAGE_DAYS - 1 ? '今天' : dayFormat.format(Date.now() - (USAGE_DAYS - 1 - index) * DAY);

function BotRow({ bot, selected, active, onSelect }) {
  return <button type="button" className={`contacts-row${selected ? ' is-selected' : ''}`} style={{ '--bot-color': bot.appearance.color }} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
    <BallAvatar className="contacts-row-avatar" {...bot.appearance} active={active} />
    <span className="contacts-row-copy">
      <span className="contacts-row-name"><span>{bot.name}</span>{bot.muted && <BellOff size={12} aria-label="已开启免打扰" />}</span>
      <span className="contacts-row-desc">{bot.description || bot.tag}</span>
    </span>
    <span className="contacts-row-time">{bot.lastUsedAt ? elapsed(bot.lastUsedAt) : '新'}</span>
  </button>;
}

// 小球会回应：悬停开心，点击惊讶一下。
function HeroAvatar({ bot, active }) {
  const [mood, setMood] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="contacts-hero-avatar" aria-label={`和 ${bot.name} 打个招呼`} title="戳一下"
    onPointerEnter={() => setMood(current => current ?? '10')} onPointerLeave={() => { clearTimeout(timer.current); setMood(null); }}
    onClick={() => { setMood('13'); clearTimeout(timer.current); timer.current = setTimeout(() => setMood(null), 1400); }}>
    <BallAvatar {...bot.appearance} emotion={mood ?? bot.appearance.emotion ?? '02'} active={active} />
  </button>;
}

// 模型选择：点开是浮层列表，和输入框里的「选择模型」菜单同一套样式。
function ModelPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const current = MODELS[value] ?? { name: value };
  return <div className="contacts-picker" ref={root}>
    <button type="button" className="contacts-picker-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(state => !state)}>
      <span>{current.name}</span><ChevronDown size={12} />
    </button>
    {open && <div className="contacts-picker-panel" role="menu" aria-label="选择模型">
      <button type="button" className="contacts-picker-head" onClick={() => setOpen(false)}><ChevronLeft size={12} />选择模型</button>
      {Object.entries(MODELS).map(([id, item]) => <button type="button" key={id} role="menuitemradio" aria-checked={id === value} className="contacts-picker-item" onClick={() => { onChange(id); setOpen(false); }}>
        <span>{item.name}</span>
        {id === value && <Check size={13} />}
      </button>)}
    </div>}
  </div>;
}

// 思考强度：完整复刻输入栏的 reasoning-effort 滑杆——canvas 星空渐变、果冻手柄、吸附式拖动。
const EFFORT_SPRING = [[0, 0], [0.02, 0.015], [0.04, 0.0532], [0.06, 0.1065], [0.08, 0.1686], [0.1, 0.2351], [0.13, 0.3363], [0.16, 0.4332], [0.2, 0.5495], [0.24, 0.648], [0.28, 0.7287], [0.33, 0.807], [0.38, 0.8646], [0.44, 0.9128], [0.5, 0.9447], [0.57, 0.968], [0.65, 0.9834], [0.74, 0.9924], [0.85, 0.9975], [1, 1]];
function glideEase(progress) {
  const end = EFFORT_SPRING.findIndex(([x]) => x >= progress);
  if (end <= 0) return end === 0 ? 0 : 1;
  const [x0, y0] = EFFORT_SPRING[end - 1];
  const [x1, y1] = EFFORT_SPRING[end];
  return y0 + (y1 - y0) * (progress - x0) / (x1 - x0);
}

// 与输入栏里的 createEffortField 同一套绘制：渐变底色、流动光带、光斑与 64 颗星。
function createEffortField(canvas, getRatio) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let phase = 0;
  let lastTime = 0;
  const stars = Array.from({ length: 64 }, (_, i) => ({
    x: i * 0.61803398875 % 1,
    y: i * 0.754877666 % 1,
    size: 0.35 + i % 5 * 0.13,
    speed: 0.3 + i % 7 * 0.1,
  }));
  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const draw = (time = 0, still = false, motionBoost = 1) => {
    if (!ctx || width <= 0 || height <= 0) return;
    const ratio = getRatio();
    if (!still) phase += Math.min(Math.max(time - lastTime, 0), 0.05) * (0.16 + ratio * 0.85) * Math.max(1, motionBoost);
    lastTime = time;
    const hue = 210 + ratio * ratio * 63;
    const fill = 32 + (width - 32) * ratio;
    ctx.clearRect(0, 0, width, height);
    const base = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0);
    base.addColorStop(0, '#30343a');
    base.addColorStop(0.28, `hsl(${hue - 12} 38% 47%)`);
    base.addColorStop(0.65, `hsl(${hue} 79% 70%)`);
    base.addColorStop(1, `hsl(${hue + 5} 88% 70%)`);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let band = 0; band < 7; band++) {
      ctx.beginPath();
      for (let x = 0; x <= width + 4; x += 4) {
        const y = height * (0.12 + band * 0.15) + Math.sin(x * 0.034 + phase + band * 1.8) * 5 + Math.sin(x * 0.079 - phase * 0.6 + band) * 2 - x * 0.035;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 2 + band % 3 * 2;
      ctx.strokeStyle = `hsla(${hue + band * 2} 90% 87% / ${0.06 + ratio * 0.025})`;
      ctx.stroke();
    }
    const glowX = fill * (0.6 + Math.sin(phase * 0.7) * 0.12);
    const glow = ctx.createRadialGradient(glowX, height * 0.7, 0, glowX, height * 0.7, 46);
    glow.addColorStop(0, `hsla(${hue - 12} 100% 88% / .35)`);
    glow.addColorStop(1, `hsla(${hue} 100% 80% / 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    for (const [i, star] of stars.entries()) {
      const x = (star.x + phase * star.speed * 0.08) % 1 * width;
      const y = ((star.y - phase * star.speed * 0.04) % 1 + 1) % 1 * height;
      const fade = Math.min(1, x / 55);
      const twinkle = 0.45 + Math.sin(phase * 2 + i * 1.9) * 0.25;
      ctx.fillStyle = `rgba(255,255,255,${fade * twinkle * (0.4 + ratio * 0.6)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, star.size * (1 + ratio * 0.5), star.size * 0.65, -0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    const shade = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0);
    shade.addColorStop(0, 'rgba(36,39,44,.8)');
    shade.addColorStop(0.45, 'rgba(36,39,44,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
  };
  const observer = new ResizeObserver(() => { resize(); draw(lastTime, true); });
  observer.observe(canvas);
  resize();
  return { draw, dispose: () => observer.disconnect() };
}

function EffortSlider({ value, disabled, onChange }) {
  const max = Math.max(1, EFFORTS.length - 1);
  const active = Math.max(0, EFFORTS.findIndex(item => item.id === value));
  const [preview, setPreview] = useState(active);
  const root = useRef(null);
  const canvas = useRef(null);
  const state = useRef(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const selected = Math.round(preview);

  const commit = next => {
    const index = Math.max(0, Math.min(max, Math.round(next)));
    setPreview(index);
    if (EFFORTS[index]?.id !== value) onChange(EFFORTS[index].id);
  };

  // 新建一条补间：从当前比例滑到目标比例（输入栏用的是 0.5s 的弹簧曲线）。
  const moveTo = ratio => {
    const motion = state.current;
    if (!motion) return;
    motion.from = motion.ratio;
    motion.target = ratio;
    motion.start = performance.now();
    motion.duration = 0.5;
  };

  useEffect(() => { setPreview(active); }, [active]);
  useEffect(() => { moveTo(disabled || disabledRef.current ? 0 : preview / max); }, [preview, max, disabled]);

  useEffect(() => {
    const rootEl = root.current;
    const canvasEl = canvas.current;
    if (!rootEl || !canvasEl) return undefined;
    const field = createEffortField(canvasEl, () => state.current?.ratio ?? 0);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = { ratio: disabledRef.current ? 0 : active / max, from: disabledRef.current ? 0 : active / max, target: disabledRef.current ? 0 : active / max, start: 0, duration: 0,
      press: 1, body: 0, lean: 0, boost: 1, dragging: false, bodyGoal: 0, leanGoal: 0 };
    state.current = motion;
    const paint = () => {
      rootEl.style.setProperty('--effort-ratio', String(motion.ratio));
      rootEl.style.setProperty('--effort-press', String(motion.press));
      rootEl.style.setProperty('--effort-jelly-x', String(1 + motion.body));
      rootEl.style.setProperty('--effort-jelly-y', String(1 - motion.body * 0.3));
      rootEl.style.setProperty('--effort-jelly-offset', `${-motion.lean * 9}px`);
      rootEl.style.setProperty('--effort-jelly-skew', `${-motion.lean * 12}deg`);
      rootEl.style.setProperty('--effort-jelly-left', `${50 + motion.lean * 32}%`);
      rootEl.style.setProperty('--effort-jelly-right', `${50 - motion.lean * 24}%`);
    };
    const approach = (current, goal, tau, dt) => current + (goal - current) * (1 - Math.exp(-dt / tau));
    let frame = 0;
    let last = performance.now();
    const step = now => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (motion.duration > 0) {
        const progress = Math.min(1, (now - motion.start) / (motion.duration * 1000));
        motion.ratio = motion.from + (motion.target - motion.from) * glideEase(progress);
        if (progress >= 1) motion.duration = 0;
      } else {
        motion.ratio = motion.target;
      }
      motion.press = approach(motion.press, motion.dragging ? 0.96 : 1, motion.dragging ? 0.08 : 0.24, dt);
      motion.body = approach(motion.body, motion.dragging ? motion.bodyGoal : 0, motion.dragging ? 0.07 : 0.2, dt);
      motion.lean = approach(motion.lean, motion.dragging ? motion.leanGoal : 0, motion.dragging ? 0.07 : 0.2, dt);
      motion.boost = approach(motion.boost, 1, 0.4, dt);
      paint();
      if (!reduced.matches) field.draw(now / 1000, false, motion.boost);
      frame = requestAnimationFrame(step);
    };
    paint();
    field.draw(0, true);
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); field.dispose(); state.current = null; };
    // 只挂载一次；比例变化通过 moveTo 驱动。
  }, []);

  return <div className="contacts-effort-slot">
    <div className="reasoning-effort" ref={root} data-maximum={selected === max || undefined} data-disabled={disabled || undefined} data-dragging={state.current?.dragging || undefined}>
      <div className="reasoning-effort-input">
        <div className="reasoning-effort-track">
          <span className="reasoning-effort-fill" aria-hidden="true"><canvas ref={canvas} /></span>
          <span className="reasoning-effort-dots" aria-hidden="true">{EFFORTS.map(item => <span key={item.id} />)}</span>
        </div>
        <span className="reasoning-effort-thumb" aria-hidden="true" />
        <input type="range" className="reasoning-effort-range" min="0" max={max} step="0.001" value={preview} disabled={disabled}
          aria-label="思考强度" aria-valuetext={EFFORTS[selected]?.label}
          onPointerDown={() => { if (state.current) { state.current.dragging = true; state.current.bodyGoal = 0; state.current.leanGoal = 0; } }}
          onPointerMove={event => {
            const motion = state.current;
            if (!motion?.dragging) return;
            const speed = Math.min(3.5, Math.abs(event.movementX || 0) * 0.35);
            const deformation = Math.min(0.46, 0.045 + speed * 0.17);
            motion.bodyGoal = deformation;
            motion.leanGoal = Math.sign(event.movementX || 0) * deformation;
            motion.boost = 1 + Math.min(2.2, 0.55 + speed * 0.6);
          }}
          onChange={event => setPreview(Number(event.target.value))}
          onPointerUp={event => { if (state.current) state.current.dragging = false; commit(Number(event.target.value)); }}
          onPointerCancel={() => { if (state.current) state.current.dragging = false; }}
          onKeyUp={event => commit(Number(event.target.value))}
          onBlur={event => { if (state.current) state.current.dragging = false; commit(Number(event.target.value)); }} />
      </div>
    </div>
  </div>;
}

function UsageChart({ daily }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(...daily);
  const total = daily.reduce((sum, value) => sum + value, 0);
  if (!total) return <p className="contacts-empty-note">近 {USAGE_DAYS} 天还没有使用记录，发第一条消息试试。</p>;
  const peak = daily.indexOf(max);
  return <div className="contacts-chart">
    <div className="contacts-chart-plot" role="img" aria-label={`近 ${USAGE_DAYS} 天共 ${total} 条消息，${dayLabel(peak)}最多，${max} 条`} onPointerLeave={() => setHover(null)}>
      {daily.map((value, index) => <div className={`contacts-chart-col${hover === index ? ' is-hover' : ''}`} key={index} onPointerEnter={() => setHover(index)}>
        <span className={`contacts-chart-bar${value ? '' : ' is-zero'}`} style={{ height: value ? `max(4px, ${value / max * 100}%)` : undefined }} />
      </div>)}
      {hover !== null && <div className="contacts-chart-tip" data-align={hover < 2 ? 'start' : hover > USAGE_DAYS - 3 ? 'end' : 'center'} style={{ left: `${(hover + .5) / USAGE_DAYS * 100}%` }}>
        <strong>{daily[hover]} 条消息</strong><span>{dayLabel(hover)}</span>
      </div>}
    </div>
    <div className="contacts-chart-axis" aria-hidden="true"><span>{dayLabel(0)}</span><span>{dayLabel(Math.floor(USAGE_DAYS / 2))}</span><span>今天</span></div>
  </div>;
}

function DeleteDialog({ bot, impact, onCancel, onConfirm }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
  const groupNames = impact.groups.map(chat => `「${chat.title}」`).join('、');
  return <dialog ref={ref} className="settings-dialog contacts-delete" aria-labelledby="contacts-delete-title"
    onCancel={event => { event.preventDefault(); onCancel(); }} onClick={event => { if (event.target === ref.current) onCancel(); }}>
    <div className="settings-dialog-head"><h2 id="contacts-delete-title">删除「{bot.name}」？</h2><button type="button" className="memory-icon-button" aria-label="关闭" onClick={onCancel}>×</button></div>
    <div className="settings-dialog-body">
      <div className="contacts-delete-lead"><BallAvatar className="contacts-delete-avatar" {...bot.appearance} emotion="12" /><p>删除后无法恢复。请先确认这会带来的影响：</p></div>
      <ul className="contacts-delete-impact">
        <li><strong>Bot 本身</strong><span>「{bot.name}」会从通讯录和消息列表中移除，它的形象、介绍、模型与工具配置一并清除。</span></li>
        <li><strong>私聊记录</strong><span>{impact.directMessages ? `你和它的私聊会被永久删除，共 ${impact.directMessages} 条聊天记录。` : '你和它还没有私聊，不会有聊天记录被删除。'}</span></li>
        <li><strong>群聊</strong><span>{impact.groups.length ? `它会退出 ${impact.groups.length} 个群聊：${groupNames}。群聊本身和它已发出的消息会保留，但它不会再回复。` : '它没有加入任何群聊，群聊不受影响。'}</span></li>
      </ul>
    </div>
    <div className="settings-dialog-actions"><button type="button" className="settings-button" autoFocus onClick={onCancel}>取消</button><button type="button" className="settings-button danger-solid" onClick={onConfirm}>删除 Bot</button></div>
  </dialog>;
}

function Profile({ bot, chats, bots, active, onBack, onMessage, onOpenChat, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState(false);
  const model = MODELS[bot.model] ?? { name: bot.model, provider: '自定义', note: '' };
  const impact = deletionImpact(bot, chats);
  const activeDays = bot.usage.daily.filter(Boolean).length;
  const stats = [
    { label: '累计消息', value: compact(bot.usage.messages), unit: '条' },
    { label: '对话', value: compact(bot.usage.chats), unit: '个' },
    { label: 'Token 用量', value: compact(bot.usage.tokens), unit: '' },
    { label: `近 ${USAGE_DAYS} 天活跃`, value: activeDays, unit: '天' },
  ];
  const appearanceOf = name => bots.find(item => item.name === name)?.appearance;
  return <section className="contacts-profile" aria-label={`${bot.name} 的个人主页`} style={{ '--bot-color': bot.appearance.color }}>
    <div className="contacts-profile-scroll"><div className="contacts-profile-inner">
      <button type="button" className="contacts-back" onClick={onBack}><ArrowLeft size={16} />通讯录</button>

      <header className="contacts-hero">
        <div className="contacts-hero-glow" aria-hidden="true"><span /><span /></div>
        <HeroAvatar bot={bot} active={active} />
        <div className="contacts-hero-title">
          <h2>{bot.name}</h2>
          <span className="contacts-chip">{bot.tag}</span>
          <span className="contacts-chip contacts-chip-soft"><Cpu size={11} />{model.name}</span>
          {bot.builtin && <span className="contacts-chip">内置</span>}
          {bot.muted && <span className="contacts-chip"><BellOff size={11} />免打扰</span>}
        </div>
        <div className="contacts-hero-actions">
          <button type="button" className={`contacts-star${bot.starred ? ' is-active' : ''}`} aria-pressed={bot.starred} aria-label={bot.starred ? '取消星标' : '星标'} title={bot.starred ? '取消星标' : '星标'} onClick={() => onUpdate({ starred: !bot.starred })}>{bot.starred ? <StarFill size={15} /> : <Star size={15} />}</button>
          <button type="button" className="contacts-primary" aria-label={`给 ${bot.name} 发消息`} title="发消息" onClick={onMessage}><Message size={16} /></button>
        </div>
        <div className="contacts-hero-body">
          {editing
            ? <form className="contacts-intro-form" onSubmit={event => { event.preventDefault(); onUpdate({ description: draft.trim() }); setEditing(false); }}>
              <textarea autoFocus rows="3" maxLength="200" aria-label="个人介绍" placeholder="介绍一下这个 Bot" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); } }} />
              <div><span>{draft.length} / 200</span><button type="button" className="settings-button" onClick={() => setEditing(false)}>取消</button><button type="submit" className="settings-button primary">保存</button></div>
            </form>
            : <p className="contacts-intro">{bot.description || '还没有个人介绍。'}<button type="button" className="contacts-intro-edit" aria-label="编辑个人介绍" title="编辑个人介绍" onClick={() => { setDraft(bot.description || ''); setEditing(true); }}><Pen size={13} /></button></p>}
          <p className="contacts-meta">
            <span title={dateTimeFormat.format(bot.createdAt)}>创建于 {dateFormat.format(bot.createdAt)}</span>
            <span title={bot.lastUsedAt ? dateTimeFormat.format(bot.lastUsedAt) : undefined}>{bot.lastUsedAt ? `最近使用 ${elapsed(bot.lastUsedAt, '前')}` : '尚未使用'}</span>
          </p>
        </div>
      </header>

      <section className="contacts-section" aria-labelledby="contacts-usage-title">
        <div className="contacts-section-head"><h3 id="contacts-usage-title">使用记录</h3><span>统计为本地示例数据</span></div>
        <div className="contacts-stats">{stats.map(item => <div className="contacts-stat" key={item.label}><span>{item.label}</span><strong>{item.value}{item.unit && <small>{item.unit}</small>}</strong></div>)}</div>
        <div className="contacts-card contacts-usage-card"><div className="contacts-card-title"><span>每日消息数</span><span>近 {USAGE_DAYS} 天</span></div><UsageChart daily={bot.usage.daily} /></div>
      </section>

      <section className="contacts-section" aria-labelledby="contacts-ability-title">
        <div className="contacts-section-head"><h3 id="contacts-ability-title">模型与工具</h3><span>{model.name} · {bot.tools.length} 个工具</span></div>
        <div className="contacts-card contacts-config">
          <div className="contacts-config-row">
            <span className="contacts-config-icon"><Cpu size={16} /></span>
            <div className="contacts-config-copy">
              <strong>模型</strong>
              <small>{model.provider}{model.note ? ` · ${model.note}` : ''}</small>
            </div>
            <ModelPicker value={bot.model} onChange={id => onUpdate({ model: id })} />
          </div>
          <div className="contacts-config-row contacts-config-row--effort">
            <span className="contacts-config-icon"><Brain size={16} /></span>
            <span className="contacts-config-title">思考强度</span>
            <span className="contacts-effort-value">{model.thinking ? (EFFORTS.find(item => item.id === bot.effort)?.label ?? '中') : '—'}</span>
            <EffortSlider value={bot.effort} disabled={!model.thinking} onChange={id => onUpdate({ effort: id })} />
          </div>
          <div className="contacts-tools-head"><span>工具</span><small>已启用 {bot.tools.length} / {Object.keys(TOOLS).length}</small></div>
          <div className="contacts-tools">{Object.entries(TOOLS).map(([id, tool]) => {
            const Icon = toolIcons[id] ?? Code;
            const enabled = bot.tools.includes(id);
            return <label key={id} className={`contacts-tool${enabled ? ' is-on' : ''}`}>
              <span className="contacts-tool-icon"><Icon size={15} /></span>
              <span className="contacts-tool-copy"><strong>{tool.label}</strong><small>{tool.detail}</small></span>
              <span className="bot-mute-switch"><input type="checkbox" role="switch" aria-label={`${tool.label}：${tool.detail}`} checked={enabled} onChange={event => onUpdate({ tools: event.target.checked ? Object.keys(TOOLS).filter(key => key === id || bot.tools.includes(key)) : bot.tools.filter(key => key !== id) })} /><span aria-hidden="true" /></span>
            </label>;
          })}</div>
          {!bot.tools.length && <p className="contacts-tools-note">没有启用任何工具，这个 Bot 只进行纯文字对话。</p>}
        </div>
      </section>

      <section className="contacts-section" aria-labelledby="contacts-groups-title">
        <div className="contacts-section-head"><h3 id="contacts-groups-title">所在群聊</h3><span>{impact.groups.length} 个</span></div>
        <div className="contacts-card contacts-card-list">
          {impact.groups.length ? impact.groups.map(chat => <button type="button" className="contacts-group" key={chat.id} onClick={() => onOpenChat(chat.id)}>
            <span className={`bot-group-avatar bot-group-avatar--${Math.min(chat.members.length, 4)}`} aria-hidden="true">{chat.members.slice(0, 4).map((member, index) => <BallAvatar key={`${member}-${index}`} {...appearanceOf(member)} active={active} />)}</span>
            <span className="contacts-group-copy"><strong>{chat.title}</strong><small>{chat.members.length} 位成员 · {chat.members.join('、')}</small></span>
            <ChevronRight size={15} />
          </button>) : <p className="contacts-empty-note">还没有加入任何群聊。</p>}
        </div>
      </section>

      <section className="contacts-section" aria-labelledby="contacts-settings-title">
        <div className="contacts-section-head"><h3 id="contacts-settings-title">设置</h3></div>
        <div className="contacts-card contacts-card-list">
          <label className="contacts-setting">
            <span className="contacts-setting-copy"><strong>免打扰</strong><small>开启后不再弹出这个 Bot 的消息通知，消息仍会正常接收，并在列表里显示静音标记。</small></span>
            <span className="bot-mute-switch"><input type="checkbox" role="switch" checked={bot.muted} onChange={event => onUpdate({ muted: event.target.checked })} /><span aria-hidden="true" /></span>
          </label>
          <div className="contacts-setting contacts-setting-danger">
            <span className="contacts-setting-copy"><strong>删除 Bot</strong>
              {bot.builtin
                ? <small>{bot.name} 是内置的默认助手，无法删除。想减少打扰，可以开启上面的免打扰。</small>
                : <small>永久删除这个 Bot{impact.directMessages ? `和你与它的 ${impact.directMessages} 条私聊记录` : ''}{impact.groups.length ? `，它还会退出 ${impact.groups.length} 个群聊` : ''}。此操作无法撤销，删除前会再次列出全部影响。</small>}
            </span>
            <button type="button" className="contacts-danger" disabled={bot.builtin} onClick={() => setDeleting(true)}><Bin size={14} />删除</button>
          </div>
        </div>
      </section>
    </div></div>
    {deleting && <DeleteDialog bot={bot} impact={impact} onCancel={() => setDeleting(false)} onConfirm={() => { setDeleting(false); onDelete(); }} />}
  </section>;
}

export function Contacts({ active = true, bots, chats, selectedId, onSelect, onMessage, onOpenChat, onUpdate, onDelete, onCreate }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const [sort, setSort] = useState('recent');
  const [detail, setDetail] = useState(false); // 窄窗口下是否停留在主页
  const [searchOpen, setSearchOpen] = useState(false); // 搜索栏默认收起，由右上角的放大镜展开
  const searchField = useRef(null);
  const searchToggle = useRef(null);
  const selected = bots.find(bot => bot.id === selectedId) ?? bots[0];
  const tags = [...new Set(bots.map(bot => bot.tag))];
  const filters = ['全部', ...(bots.some(bot => bot.starred) ? ['星标'] : []), ...tags];
  const currentFilter = filters.includes(filter) ? filter : '全部';
  const needle = query.trim().toLowerCase();
  const visible = bots
    .filter(bot => (currentFilter === '全部' || (currentFilter === '星标' ? bot.starred : bot.tag === currentFilter)) && `${bot.name} ${bot.tag} ${bot.description}`.toLowerCase().includes(needle))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  const split = currentFilter === '全部' && !needle && visible.some(bot => bot.starred);
  const sections = split
    ? [{ title: '星标', items: visible.filter(bot => bot.starred) }, { title: '更多 Bot', items: visible.filter(bot => !bot.starred) }].filter(section => section.items.length)
    : [{ title: needle ? '搜索结果' : currentFilter === '全部' ? '全部 Bot' : currentFilter, items: visible }];

  function moveFocus(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll('.contacts-row')];
    const next = rows[rows.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  }

  // 和「主页」二级菜单的放大镜一致：点一下展开搜索框，再点一下收起并清空。
  useEffect(() => { if (searchOpen) searchField.current?.focus(); }, [searchOpen]);
  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    searchToggle.current?.focus();
  }
  function toggleSearch() {
    if (searchOpen) closeSearch();
    else setSearchOpen(true);
  }

  return <div className={`contacts${detail ? ' is-detail' : ''}`}>
    <aside className="contacts-list" aria-label="全部 Bot">
      <header className="contacts-list-header">
        <h1>通讯录</h1>
        <div className="contacts-list-tools">
          <button ref={searchToggle} type="button" className="contacts-icon-button" aria-label="搜索 Bot" title="搜索 Bot" aria-expanded={searchOpen} aria-controls="contacts-search" onClick={toggleSearch}><Search size={16} /></button>
          <button type="button" className="contacts-icon-button" aria-label="创建 Bot" title="创建 Bot" aria-haspopup="dialog" onClick={event => onCreate(event.currentTarget)}><CirclePlus size={18} /></button>
        </div>
      </header>
      {searchOpen && <label className="contacts-search" id="contacts-search">
        <Search size={15} />
        <input ref={searchField} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeSearch(); } }} placeholder="搜索 Bot" aria-label="搜索 Bot" />
        {query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); searchField.current?.focus(); }}><X size={13} /></button>}
      </label>}
      <div className="contacts-filters" role="group" aria-label="筛选 Bot">{filters.map(item => <button type="button" key={item} aria-pressed={currentFilter === item} onClick={() => setFilter(item)}>{item === '星标' && <StarFill size={11} />}{item}</button>)}</div>
      <div className="contacts-rows" onKeyDown={moveFocus}>
        {visible.length ? sections.map((section, index) => <div className="contacts-rows-section" key={section.title}>
          <div className="contacts-rows-title"><span>{section.title} · {section.items.length}</span>{index === 0 && <button type="button" onClick={() => setSort(sort === 'recent' ? 'name' : 'recent')} title="切换排序方式">{sort === 'recent' ? '按最近使用' : '按名称'}</button>}</div>
          {section.items.map(bot => <BotRow key={bot.id} bot={bot} active={active} selected={bot.id === selected?.id} onSelect={() => { onSelect(bot.id); setDetail(true); }} />)}
        </div>) : <div className="contacts-rows-empty"><p>没有找到相关 Bot</p><button type="button" onClick={() => { setQuery(''); setFilter('全部'); }}>清除筛选</button></div>}
      </div>
    </aside>
    {selected
      ? <Profile key={selected.id} bot={selected} bots={bots} chats={chats} active={active} onBack={() => setDetail(false)}
        onMessage={() => onMessage(selected.id)} onOpenChat={onOpenChat} onUpdate={patch => onUpdate(selected.id, patch)} onDelete={() => { setDetail(false); onDelete(selected.id); }} />
      : <section className="contacts-profile contacts-profile-empty"><TriangleAlert size={20} /><p>通讯录里还没有 Bot</p></section>}
  </div>;
}
