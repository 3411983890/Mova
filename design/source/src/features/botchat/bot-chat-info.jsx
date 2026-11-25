// Bot / 群聊信息浮层的内容。「⋯」弹出的卡片就是这里渲染的。
import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Folder, Pen, Bin } from '@keyline-icons/react';
import { BallAvatar } from '../../../bot-conversation.jsx';
import { EFFORTS, MODELS } from '../../../bot-directory.js';
import './bot-chat-info.css';

function Stack({ members, color, size = 44 }) {
  return <span className="bot-stack" style={{ '--group-color': color }} aria-hidden="true">
    {members.slice(0, 4).map((bot, index) => <BallAvatar key={`${bot?.id ?? index}`} {...bot?.appearance} />)}
  </span>;
}

export function BotChatInfo({ bot, onMute, onOpenProfile }) {
  if (!bot) return null;
  const model = MODELS[bot.model] ?? { name: bot.model };
  const effort = EFFORTS.find(item => item.id === bot.effort)?.label;
  return <div className="bot-info" data-kind="bot">
    <div className="bot-info-head">
      <BallAvatar className="bot-info-avatar" {...bot.appearance} />
      <div className="bot-info-ident">
        <h2 className="bot-info-name" id="bot-popover-title">{bot.name}</h2>
        <div className="bot-info-chips">
          <span className="bot-info-chip">{bot.tag}</span>
          {bot.builtin && <span className="bot-info-chip">内置</span>}
          {bot.muted && <span className="bot-info-chip">免打扰</span>}
        </div>
      </div>
    </div>
    <p className="bot-info-intro">{bot.description || '还没有个人介绍。'}</p>
    <div className="bot-info-rows">
      <div className="bot-info-row">
        <span className="bot-info-key">模型</span>
        <span className="bot-info-value">{model.name}{model.thinking && effort ? <em> · 思考{effort}</em> : null}</span>
      </div>
      <label className="bot-info-row">
        <span className="bot-info-key">免打扰</span>
        <span className="bot-info-switch">
          <input type="checkbox" role="switch" aria-label={`${bot.name} 的免打扰`} checked={Boolean(bot.muted)} onChange={event => onMute(event.target.checked)} />
          <span aria-hidden="true" />
        </span>
      </label>
    </div>
    <button type="button" className="bot-info-link" onClick={onOpenProfile}>查看完整主页<ArrowUpRight size={13} /></button>
  </div>;
}

export function GroupChatInfo({ chat, bots, onRename, onPlace, onMute, onDelete, onPickPlace }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const members = (chat.members ?? []).map(name => bots.find(bot => bot.name === name) ?? { name });
  const place = chat.place;

  useEffect(() => { setDraft(chat.title); }, [chat.title]);

  const saveName = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== chat.title) onRename(next);
    else setDraft(chat.title);
  };

  return <div className="bot-info" data-kind="group">
    <div className="bot-info-members" aria-label={`群聊成员，共 ${members.length} 个`}>
      {members.map((bot, index) => <div className="bot-info-member" key={`${bot.id ?? bot.name}-${index}`}>
        <BallAvatar {...bot.appearance} />
        <span>{bot.name}</span>
      </div>)}
    </div>

    <div className="bot-info-rows">
      <div className="bot-info-row">
        <span className="bot-info-key">群名</span>
        {renaming
          ? <input className="bot-info-input" autoFocus maxLength="30" value={draft} aria-label="群聊名称"
            onChange={event => setDraft(event.target.value)}
            onBlur={saveName}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); saveName(); }
              if (event.key === 'Escape') { event.stopPropagation(); setDraft(chat.title); setRenaming(false); }
            }} />
          : <button type="button" className="bot-info-value is-button" onClick={() => { setDraft(chat.title); setRenaming(true); }} title="重命名群聊">
            <span id="bot-popover-title">{chat.title}</span><Pen size={12} />
          </button>}
      </div>

      <div className="bot-info-row is-place">
        <span className="bot-info-key">工作位置</span>
        <button type="button" className="bot-info-value is-button" aria-haspopup="dialog" onClick={() => onPickPlace(place, onPlace)}>
          <Folder size={12} />
          <span>{place ? place.name : '未设置'}</span>
          <ChevronRight size={12} className="bot-info-caret" />
        </button>
      </div>

      <label className="bot-info-row">
        <span className="bot-info-key">免打扰</span>
        <span className="bot-info-switch">
          <input type="checkbox" role="switch" aria-label="群聊免打扰" checked={Boolean(chat.muted)} onChange={event => onMute(event.target.checked)} />
          <span aria-hidden="true" />
        </span>
      </label>
    </div>

    <button type="button" className="bot-info-danger" onClick={onDelete}><Bin size={13} />删除群聊</button>
  </div>;
}
