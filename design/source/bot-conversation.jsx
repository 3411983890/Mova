// Adapted from Kobra's @kobra/conversation registry component:
// https://kobra.systems/r/conversation.json. Tailwind utilities are expressed
// as project CSS because this prototype does not use Tailwind.
import React, { useEffect, useRef } from 'react';
import { BellOff } from '@keyline-icons/react';

export function BallAvatar({ className = '', shape = 'blob', emotion = '02', color, active = true, onReady }) {
  const ref = useRef(null);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const ball = window.EmotionBall.create(ref.current, {
      emotion, shape, color, eyeColor: '#1a1a1a', eyeScale: 1.65, lite: true,
      idle: false, autostart: active && !reduced.matches && !document.hidden,
    });
    onReady?.(ball);
    const sync = () => ball.setActive(active && !document.hidden && !reduced.matches);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return () => { document.removeEventListener('visibilitychange', sync); reduced.removeEventListener('change', sync); ball.destroy(); };
  }, [shape, emotion, color, active]);
  return <span className={`bot-ball ${className}`} ref={ref} aria-hidden="true" />;
}

export function Conversation({ children }) {
  return <div data-slot="conversation" className="bot-messages">{children}</div>;
}

export function ConversationBubble({ align = 'start', children }) {
  return <div data-slot="conversation-bubble" data-align={align} className="bot-bubble">{children}</div>;
}

export function ConversationContent({ children }) {
  return <div data-slot="conversation-content" className="bot-bubble-content">{children}</div>;
}

// `muted`：已开启免打扰的私聊 id 集合；`appearanceOf`：按成员名字取通讯录里的形象。
export function BotList({ chats, selected, onSelect, muted, appearanceOf, colorOf }) {
  return chats.map(chat => <button key={chat.id} type="button" className={`bot-list-row${selected === chat.id ? ' selected' : ''}`} onClick={() => onSelect(chat.id)} aria-current={selected === chat.id ? 'true' : undefined}>
    {chat.members ? <span className={`bot-group-avatar bot-group-avatar--${Math.min(chat.members.length, 4)}`} aria-hidden="true">{chat.members.slice(0, 4).map((member, index) => <BallAvatar key={`${member}-${index}`} {...appearanceOf?.(member)} />)}</span> : <BallAvatar className="bot-list-avatar" {...chat.appearance} />}
    <span className="bot-list-copy"><span className="bot-list-name"><span>{chat.title}</span>{muted?.has(chat.id) && <BellOff className="bot-list-muted" size={12} aria-label="已开启免打扰" />}</span><span className="bot-list-preview">{chat.messages.at(-1)?.text || '开始一段新对话'}</span></span>
  </button>);
}

export function BotConversation({ messages, appearance, botName = 'MovaBot' }) {
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  return <div className="bot-conversation-inner"><div className="bot-date">对话预览</div><Conversation>
    {messages.map(message => <div className={`bot-message ${message.role === 'user' ? 'bot-message--user' : ''}`} key={message.id}>
      {message.role !== 'user' && <BallAvatar className="bot-message-avatar" {...appearance} />}
      <ConversationBubble align={message.role === 'user' ? 'end' : 'start'}>
        {message.role !== 'user' && <span className="bot-sender">{message.sender || botName}</span>}
        <ConversationContent>{message.text}</ConversationContent>
      </ConversationBubble>
    </div>)}
  </Conversation><div ref={end} /></div>;
}
