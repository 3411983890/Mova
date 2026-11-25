/**
 * 负责：渲染 MovaBot 对话列表（置顶与未读角标、单聊 40px 球体与群成员头像拼接）以及对话流区域
 *   （群聊共识/投票卡、小程序直达卡片、运行时审批卡）。
 * 不负责：后端持久化与路由调度逻辑（仅消费视图模型与回调）。
 * 被谁调用：app.js、src/features/botchat/bot-chat-info.jsx、src/features/contacts/contacts.jsx、src/features/bot/bot-builder.jsx。
 */
import React, { useEffect, useRef } from 'react';
import { splitBotMessage } from './bot-message-text.mjs';
import { AskCard } from '../ask/ask-card.jsx';
import { BellOff, Check, Pin, ShieldCheck } from '@keyline-icons/react';

export function BallAvatar({ className = '', shape = 'blob', emotion = '02', color, active = true }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!window.EmotionBall?.create) return undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const ball = window.EmotionBall.create(ref.current, {
      emotion, shape, color, eyeColor: '#1a1a1a', eyeScale: 1.65, lite: true,
      idle: false, autostart: active && !reduced.matches && !document.hidden,
    });
    const sync = () => ball.setActive(active && !document.hidden && !reduced.matches);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      ball.destroy();
    };
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

export function BotList({
  chats,
  selected,
  onSelect,
  muted,
  appearanceOf,
  appearanceById,
}) {
  const visibleChats = Array.isArray(chats) ? chats : [];

  return <React.Fragment>
    {visibleChats.map(chat => {
      const isGroup = chat.type === 'group'
        || (chat.type !== 'private' && Array.isArray(chat.members) && chat.members.length > 1);
      const memberKeys = chat.memberBotIds?.length ? chat.memberBotIds : (chat.members || []);
      const lastMsg = chat.messages?.at(-1);
      const preview = lastMsg ? (lastMsg.text ?? lastMsg.content ?? '开始一段新对话') : '开始一段新对话';

      return (
        <button
          key={chat.id}
          type="button"
          className={`bot-list-row${selected === chat.id ? ' selected' : ''}`}
          onClick={() => onSelect(chat.id)}
          aria-current={selected === chat.id ? 'true' : undefined}
        >
          {isGroup
            ? <span className={`bot-group-avatar bot-group-avatar--${Math.min(Math.max(1, memberKeys.length), 4)}`} aria-hidden="true">
                {memberKeys.slice(0, 4).map((member, index) => {
                  const id = typeof member === 'string' ? member : member.memberId;
                  const app = appearanceById?.(id) ?? appearanceOf?.(id);
                  return <BallAvatar key={`${id}-${index}`} {...app} />;
                })}
              </span>
            : <BallAvatar className="bot-list-avatar" {...chat.appearance} />}
          <span className="bot-list-copy">
            <span className="bot-list-name">
              <span>{chat.title}</span>
              {chat.pinned && <Pin size={11} aria-label="已置顶" />}
              {muted?.has(chat.id) && <BellOff className="bot-list-muted" size={12} aria-label="已开启免打扰" />}
              {chat.isWorking && <span className="bot-list-working-badge" title="正在工作">工作中</span>}
              {chat.unread > 0 && <span className="bot-list-unread">{chat.unread > 99 ? '99+' : chat.unread}</span>}
            </span>
            <span className="bot-list-preview">{preview}</span>
          </span>
        </button>
      );
    })}
    {visibleChats.length === 0 && <p className="bot-list-empty">暂无会话</p>}
  </React.Fragment>;
}

function ConsensusCard({ card, messageId, onVoteConsensus }) {
  return (
    <div className="bot-structured-card bot-consensus-card" role="region" aria-label={card.title}>
      <div className="bot-card-head">
        <strong>{card.title}</strong>
        {card.confirmedAsTask && <span className="bot-card-tag is-done">已转为任务</span>}
      </div>
      {card.summary && <p className="bot-card-summary">{card.summary}</p>}
      {card.consensusItems?.length > 0 && (
        <ul className="bot-card-list">
          {card.consensusItems.map((item, idx) => <li key={idx}><Check size={12} /><span>{item}</span></li>)}
        </ul>
      )}
      {card.divergenceQuestion && <div className="bot-card-question">{card.divergenceQuestion}</div>}
      <div className="bot-card-options">
        {(card.options || []).map(opt => {
          const selected = card.selectedOptionId === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              className={`bot-card-option${selected ? ' is-selected' : ''}`}
              onClick={() => onVoteConsensus?.({ messageId, selectedOptionId: opt.id, confirmTask: false })}
            >
              <span>{opt.label}</span>
              {selected && <Check size={13} />}
            </button>
          );
        })}
      </div>
      {!card.confirmedAsTask && (
        <div className="bot-card-footer">
          <button
            type="button"
            className="bot-card-primary"
            onClick={() => onVoteConsensus?.({
              messageId,
              selectedOptionId: card.selectedOptionId || card.recommendedOptionId || card.options?.[0]?.id,
              confirmTask: true,
            })}
          >
            确认并转为可执行任务
          </button>
        </div>
      )}
    </div>
  );
}

function MiniAppDirectCard({ card, onOpenMiniApp }) {
  const routes = (card.quickRoutes || []).slice(0, 3);
  return (
    <div className="bot-structured-card bot-miniapp-card" role="region" aria-label={`小程序 ${card.name}`}>
      <div className="bot-card-head">
        <strong>{card.name}</strong>
        <span className="bot-card-tag">v{card.version}</span>
      </div>
      {card.description && <p className="bot-card-summary">{card.description}</p>}
      {card.metrics?.length > 0 && (
        <div className="bot-miniapp-metrics">
          {card.metrics.slice(0, 2).map((m, idx) => (
            <div key={idx} className="bot-miniapp-metric">
              <span>{m.label}</span>
              <strong>{m.value}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="bot-card-actions">
        {routes.map(route => (
          <button
            key={route.id}
            type="button"
            className="bot-card-option"
            onClick={() => onOpenMiniApp?.({ appId: card.appId, routeId: route.id, mode: 'side' })}
          >
            {route.title}
          </button>
        ))}
        <button
          type="button"
          className="bot-card-primary"
          onClick={() => onOpenMiniApp?.({ appId: card.appId, routeId: routes[0]?.id || 'overview', mode: 'full' })}
        >
          完整视图
        </button>
      </div>
    </div>
  );
}

export function BotConversation({
  chat = null,
  messages = [],
  appearance,
  botName = 'MovaBot',
  bots = [],
  pendingApprovals = [],
  onVoteConsensus = null,
  onOpenMiniApp = null,
  onResolveApproval = null,
  onMentionBot = null,
  onAnswerQuestion = null,
}) {
  const end = useRef(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages?.length]);

  // 严格过滤：任何 visibility === 'internal' 的事件绝不会作为可见消息渲染。
  const visibleMessages = (messages || []).filter(m => m.visibility !== 'internal').flatMap(message => {
    if (message.role === 'user' || message.senderType === 'user') return [message];
    const parts = splitBotMessage(message.text ?? message.content ?? '');
    if (!parts.length) return [message];
    return parts.map((text, index) => ({
      ...message,
      id: index === parts.length - 1 ? message.id : `${message.id}-part-${index}`,
      text,
      structuredPayload: index === parts.length - 1 ? message.structuredPayload : null,
    }));
  });

  const byId = new Map(bots.map(b => [b.id, b]));
  const nameCounts = new Map();
  for (const b of bots) {
    nameCounts.set(b.name, (nameCounts.get(b.name) || 0) + 1);
  }

  return (
    <div className="bot-conversation-inner">
      {pendingApprovals?.length > 0 && (
        <div className="bot-approvals-banner" role="region" aria-label="待确认的高风险操作">
          {pendingApprovals.map(apr => (
            <div key={apr.id} className="bot-approval-card">
              <div className="bot-approval-head">
                <ShieldCheck size={14} />
                <strong>请求执行高风险动作：{apr.toolName}</strong>
              </div>
              <p>{apr.actionSummary}</p>
              <div className="bot-approval-actions">
                <button type="button" className="bot-card-primary" onClick={() => onResolveApproval?.(apr.id, 'approved')}>批准这次</button>
                <button type="button" className="bot-card-option" onClick={() => onResolveApproval?.(apr.id, 'rejected')}>拒绝</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Conversation>
        {visibleMessages.map(message => {
          const isUser = message.role === 'user' || message.senderType === 'user';
          const senderBot = !isUser ? byId.get(message.senderId) : null;
          const senderLabel = message.senderNameSnapshot || senderBot?.name || message.sender || botName;
          const msgAppearance = senderBot?.appearance || appearance;
          const msgText = message.text ?? message.content ?? '';
          const payload = message.structuredPayload;
          const canMention = Boolean(!isUser && chat?.type === 'group' && onMentionBot && senderBot);

          return (
            <div className={`bot-message ${isUser ? 'bot-message--user' : ''}`} key={message.id}>
              {!isUser && (canMention ? (
                <button
                  type="button"
                  className="bot-message-avatar-btn"
                  title={`点击 @${senderLabel}`}
                  aria-label={`在输入框提及 ${senderLabel}`}
                  onClick={() => onMentionBot(senderBot)}
                >
                  <BallAvatar className="bot-message-avatar" {...msgAppearance} />
                </button>
              ) : (
                <BallAvatar className="bot-message-avatar" {...msgAppearance} />
              ))}
              <ConversationBubble align={isUser ? 'end' : 'start'}>
                {!isUser && (
                  <span
                    className={canMention ? 'bot-sender is-mentionable' : 'bot-sender'}
                    title={canMention ? `点击 @${senderLabel}` : undefined}
                    onClick={canMention ? () => onMentionBot(senderBot) : undefined}
                  >
                    {senderLabel}
                    {(nameCounts.get(senderBot?.name) || 0) > 1 && senderBot && (
                      <em className="bot-sender-id"> #{senderBot.id.slice(-6)}</em>
                    )}
                  </span>
                )}
                {msgText && <ConversationContent>{msgText}</ConversationContent>}
                {payload?.type === 'question_card' && (
                  <div className="bot-question-card">
                    {visibleMessages.some(item => item.replyToMessageId === message.id && (item.role === 'user' || item.senderType === 'user'))
                      ? <p>{payload.question}（已回答）</p>
                      : <AskCard ask={{ ...payload, id: message.id }} onSubmit={answer => onAnswerQuestion?.(message, answer)} onSkip={() => onAnswerQuestion?.(message, '暂时跳过这个问题，请勿猜测或执行尚未确认的修改。')} />}
                  </div>
                )}
                {payload?.type === 'consensus_card' && (
                  <ConsensusCard card={payload} messageId={message.id} onVoteConsensus={(opts) => onVoteConsensus?.({ conversationId: chat?.id, ...opts })} />
                )}
                {payload?.type === 'mini_app_card' && (
                  <MiniAppDirectCard card={payload} onOpenMiniApp={onOpenMiniApp} />
                )}
              </ConversationBubble>
            </div>
          );
        })}
      </Conversation>
      <div ref={end} />
    </div>
  );
}
