/**
 * 负责：渲染「⋯」弹出的 Bot 单聊信息卡与群聊信息管理浮层（群模式切换、稳定 ID 成员增删与角色任命、群共享记忆读写、单 Bot 多话题创建、任务状态控制与删除确认）。
 * 不负责：后端持久化本身（所有操作通过 props 回调至 app.js / desktop 桥接层）。
 * 被谁调用：app.js。
 */
import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Bin, Check, ChevronRight, Folder, Pen, Plus } from '@keyline-icons/react';
import { BallAvatar } from '../bot/bot-conversation.jsx';
import { EFFORTS, MODELS } from '../bot/bot-directory.js';
import './bot-chat-info.css';

const MODES = [
  { id: 'quiet', label: '安静', note: '仅 @ 或回复时说话' },
  { id: 'natural', label: '自然', note: '主回复 + 必要补充' },
  { id: 'discussion', label: '讨论', note: '多视角碰撞 + 共识卡' },
  { id: 'task', label: '任务', note: '主机统筹 + 后台协同' },
];

export function BotChatInfo({
  bot,
  chat = null,
  tasks = [],
  onMute,
  onOpenProfile,
  onNewTopic = null,
  onTaskControl = null,
}) {
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
          {bot.status === 'paused' && <span className="bot-info-chip">已停用</span>}
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
      {chat?.topic && (
        <div className="bot-info-row">
          <span className="bot-info-key">当前话题</span>
          <span className="bot-info-value">{chat.topic}</span>
        </div>
      )}
      <label className="bot-info-row">
        <span className="bot-info-key">免打扰</span>
        <span className="bot-info-switch">
          <input type="checkbox" role="switch" aria-label={`${bot.name} 的免打扰`} checked={Boolean(bot.muted)} onChange={event => onMute(event.target.checked)} />
          <span aria-hidden="true" />
        </span>
      </label>
    </div>
    {tasks?.length > 0 && (
      <div className="bot-info-rows">
        <div className="bot-info-row"><span className="bot-info-key">会话任务 ({tasks.length})</span></div>
        {tasks.slice(0, 2).map(task => (
          <div key={task.id} className="bot-info-row">
            <span className="bot-info-value">{task.title}</span>
            {onTaskControl && (
              <button type="button" className="bot-info-value is-button" onClick={() => onTaskControl(task.id, task.status === 'paused' ? 'running' : 'paused')}>
                {task.status === 'paused' ? '继续' : '暂停'}
              </button>
            )}
          </div>
        ))}
      </div>
    )}
    {onNewTopic && (
      <button type="button" className="bot-info-link" onClick={() => onNewTopic(bot.id)}>
        围绕此 Bot 开启新话题<Plus size={13} />
      </button>
    )}
    <button type="button" className="bot-info-link" onClick={onOpenProfile}>查看完整主页与记忆<ArrowUpRight size={13} /></button>
  </div>;
}

export function GroupChatInfo({
  chat,
  bots,
  groupMemories = [],
  onRename,
  onPlace,
  onMute,
  onDelete,
  onPickPlace,
  onSetGroupMode = null,
  onAddMember = null,
  onRemoveMember = null,
  onAddGroupMemory = null,
  onMentionBot = null,
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);

  // 优先用稳定 ID (`memberBotIds`) 解析群成员，兼容旧名字列表
  const members = chat.memberBotIds?.length
    ? chat.memberBotIds.map(id => bots.find(b => b.id === id) ?? { id, name: id })
    : (chat.members ?? []).map(name => bots.find(bot => bot.id === name || bot.name === name) ?? { name });

  const memberIdSet = new Set(members.map(m => m.id).filter(Boolean));
  const nonMembers = bots.filter(b => b.status === 'active' && !memberIdSet.has(b.id));
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
        {onMentionBot && bot.name ? (
          <button
            type="button"
            className="bot-info-member-pick"
            title={`点击 @${bot.name}`}
            aria-label={`在输入框提及 ${bot.name}`}
            onClick={() => onMentionBot(bot)}
          >
            <BallAvatar {...bot.appearance} />
            <span>{bot.name}</span>
          </button>
        ) : (
          <>
            <BallAvatar {...bot.appearance} />
            <span>{bot.name}</span>
          </>
        )}
        {onRemoveMember && bot.id && members.length > 2 && (
          <button type="button" className="bot-info-remove-member" aria-label={`移除 ${bot.name}`} onClick={() => onRemoveMember(bot.id)}>×</button>
        )}
      </div>)}
    </div>

    {onAddMember && nonMembers.length > 0 && (
      <div className="bot-info-rows">
        <button type="button" className="bot-info-link" onClick={() => setShowAddMember(s => !s)}>
          添加群成员<Plus size={12} />
        </button>
        {showAddMember && nonMembers.map(candidate => (
          <button key={candidate.id} type="button" className="bot-info-value is-button" onClick={() => { onAddMember(candidate.id); setShowAddMember(false); }}>
            <span>+ {candidate.name} ({candidate.tag})</span>
          </button>
        ))}
      </div>
    )}

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

      {onSetGroupMode && (
        <div className="bot-info-row">
          <span className="bot-info-key">群聊模式</span>
          <select
            className="bot-info-input"
            aria-label="群聊模式"
            value={chat.groupMode || 'natural'}
            onChange={e => onSetGroupMode(e.target.value)}
          >
            {MODES.map(m => <option key={m.id} value={m.id}>{m.label} · {m.note}</option>)}
          </select>
        </div>
      )}

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

    {groupMemories.length > 0 && (
      <div className="bot-info-rows">
        <span className="bot-info-key">群共享记忆 ({groupMemories.length})</span>
        {groupMemories.slice(0, 2).map(m => (
          <div key={m.id} className="bot-info-intro" title={m.content}>• {m.summary || m.content.slice(0, 42)}</div>
        ))}
      </div>
    )}

    {onAddGroupMemory && (
      <div className="bot-info-row">
        <input
          className="bot-info-input"
          placeholder="记录一条群共享记忆…"
          value={memoryDraft}
          onChange={e => setMemoryDraft(e.target.value)}
        />
        <button type="button" className="bot-info-value is-button" aria-label="保存群记忆" onClick={() => {
          if (memoryDraft.trim()) { onAddGroupMemory(memoryDraft.trim()); setMemoryDraft(''); }
        }}><Check size={12} /></button>
      </div>
    )}

    <button type="button" className="bot-info-danger" onClick={onDelete}><Bin size={13} />删除群聊</button>
  </div>;
}
