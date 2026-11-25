import React, { useEffect, useRef, useState } from 'react';
import { BallAvatar } from './bot-conversation.jsx';

/** One avatar per working Bot, across all conversations; only real runtime status is shown. */
export function BotActivity({ entries = [], bots = [] }) {
  const [selected, setSelected] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const close = useRef(null);
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.botId) continue;
    const group = groups.get(entry.botId) || { ...entry, tasks: [] };
    group.tasks.push(entry);
    groups.set(entry.botId, group);
  }
  const current = groups.get(selected);
  useEffect(() => {
    if (selected) close.current?.focus();
    const outside = event => {
      if (!root.current?.contains(event.target)) setSelected(null);
    };
    const escape = event => {
      if (event.key === 'Escape') { setSelected(null); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [selected]);
  useEffect(() => {
    if (selected && !entries.some(entry => entry.botId === selected)) {
      setSelected(null);
      trigger.current?.focus();
    }
  }, [entries, selected]);
  if (!groups.size) return null;
  return <div className="bot-activity" ref={root}>
    <div className="bot-activity-avatars" aria-label="正在工作的 Bot">
      {[...groups.values()].map(entry => <button
        key={entry.botId} type="button" className="bot-activity-avatar"
        title={`${entry.botName} · 工作中`} aria-label={`查看 ${entry.botName} 正在做什么`}
        aria-haspopup="dialog" aria-expanded={selected === entry.botId}
        aria-controls={selected === entry.botId ? 'bot-activity-dialog' : undefined}
        onClick={event => { trigger.current = event.currentTarget; setSelected(selected === entry.botId ? null : entry.botId); }}
      >
        <BallAvatar {...bots.find(bot => bot.id === entry.botId)?.appearance} />
        <span className="bot-activity-dot" />
      </button>)}
    </div>
    {current && <section id="bot-activity-dialog" className="bot-activity-dialog" role="dialog" aria-label={`${current.botName} 的工作进展`}>
      <header><strong>{current.botName}</strong><button ref={close} type="button" aria-label="关闭工作进展" onClick={() => { setSelected(null); trigger.current?.focus(); }}>×</button></header>
      {current.tasks.map((task, index) => <div className="bot-activity-task" key={`${task.conversationId}-${index}`}>
        <span>{task.conversationTitle || 'Bot 会话'}</span>
        <p>{task.statusText || '正在处理任务'}</p>
      </div>)}
    </section>}
  </div>;
}
