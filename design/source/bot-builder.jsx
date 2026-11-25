import React, { useState } from 'react';
import { BallAvatar } from './bot-conversation.jsx';
import { DEFAULT_MODEL, EFFORTS, MODELS } from './bot-directory.js';

const shapes = [{ id: 'blob', label: '圆形' }, { id: 'wedge', label: '三角形' }, { id: 'gem', label: '菱形' }];
const colors = [{ value: '#f3f0ea', label: '暖白' }, { value: '#a7c9f4', label: '浅蓝' }, { value: '#78b8ef', label: '蓝色' }, { value: '#76d1dc', label: '天青' }, { value: '#81d1c2', label: '青绿' }, { value: '#81cd99', label: '薄荷绿' }, { value: '#a7d87e', label: '绿色' }, { value: '#d2db83', label: '黄绿' }, { value: '#f4d88a', label: '浅黄' }, { value: '#f1b775', label: '橙色' }, { value: '#ee988c', label: '珊瑚色' }, { value: '#e7829a', label: '玫红' }, { value: '#ed91b9', label: '粉色' }, { value: '#d5a4dc', label: '淡紫' }, { value: '#ad91e8', label: '紫色' }, { value: '#9ba8e8', label: '蓝紫' }];
const tags = ['通用', '写作', '编程', '设计', '研究'];

export function BotBuilder({ onCreate, onCancel }) {
  const [shape, setShape] = useState('blob');
  const emotion = '02';
  const [color, setColor] = useState('#f3f0ea');
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [description, setDescription] = useState('');
  const [muted, setMuted] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState('medium');
  const appearance = { shape, emotion, color };
  const thinking = Boolean(MODELS[model]?.thinking);
  return <form className="bot-builder" onSubmit={event => { event.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), tag: tag.trim(), description: description.trim(), muted, appearance, model, effort: thinking ? effort : 'medium' }); }}>
    <header className="bot-builder-header"><h2 id="bot-builder-title">{name.trim() || '创建 Bot'}</h2><button type="button" className="bot-builder-close" aria-label="关闭" onClick={onCancel}>×</button></header>
    <div className="bot-builder-body">
      <section className="bot-portrait" aria-label="Bot 形象设置">
        <div className="bot-color-ring" role="group" aria-label="选择颜色">
          <BallAvatar className="bot-builder-ball" {...appearance} />
          <div className="bot-color-orbit">{colors.map((item, index) => { const angle = index * Math.PI * 2 / colors.length - Math.PI / 2; return <button type="button" key={item.value} className="bot-color-button" style={{ left: `${50 + 43 * Math.cos(angle)}%`, top: `${50 + 43 * Math.sin(angle)}%` }} aria-label={item.label} title={item.label} aria-pressed={color === item.value} onClick={() => setColor(item.value)}><span style={{ backgroundColor: item.value }} /></button>; })}</div>
        </div>
        <div className="bot-shape-arc" role="group" aria-label="选择形状">{shapes.map(item => <button type="button" key={item.id} className="bot-choice-button" aria-label={item.label} title={item.label} aria-pressed={shape === item.id} onClick={() => setShape(item.id)}><BallAvatar shape={item.id} emotion={emotion} color={color} /></button>)}</div>
      </section>
      <div className="bot-builder-fields">
        <label><span>名字 <b aria-hidden="true">*</b></span><input required maxLength="30" value={name} onChange={event => setName(event.target.value)} placeholder="给 Bot 起个名字" /></label>
        <label><span>标签</span><select value={tag} onChange={event => setTag(event.target.value)}><option value="">选择标签</option>{tags.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <div className="bot-builder-model">
          <span id="bot-model-label">模型</span>
          <div>
            <div className="bot-model-options" role="radiogroup" aria-labelledby="bot-model-label">
              {Object.entries(MODELS).map(([id, item]) => <button type="button" key={id} role="radio" aria-checked={model === id} className="bot-model-option" onClick={() => setModel(id)}>
                <strong>{item.name}{item.thinking && <em>思考</em>}</strong>
                <small>{item.note}</small>
              </button>)}
            </div>
            <div className={`bot-effort${thinking ? '' : ' is-off'}`} role="radiogroup" aria-label="思考强度">
              <span>思考强度</span>
              {EFFORTS.map(item => <button type="button" key={item.id} role="radio" aria-checked={thinking && effort === item.id} disabled={!thinking} title={item.note} onClick={() => setEffort(item.id)}>{item.label}</button>)}
            </div>
          </div>
        </div>
        <label><span>描述</span><textarea rows="2" maxLength="200" value={description} onChange={event => setDescription(event.target.value)} placeholder="介绍一下这个 Bot" /></label>
        <label className="bot-mute-row"><strong>免打扰</strong><span className="bot-mute-switch"><input type="checkbox" role="switch" checked={muted} onChange={event => setMuted(event.target.checked)} /><span aria-hidden="true" /></span></label>
      </div>
    </div>
    <footer className="bot-builder-actions"><button type="button" onClick={onCancel}>取消</button><button type="submit" className="bot-builder-submit">创建 Bot</button></footer>
  </form>;
}
