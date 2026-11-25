/**
 * 负责：提供新建 Bot 的三模式交互表单（模板创建 / 一句话自然语言创建 / 自定义配置），
 *   允许 Bot 重名并产出统一的创建载荷给上层注册与持久化流程。
 * 不负责：直接写入数据库、执行 IPC 持久化或生成唯一 UUID（由 Registry 与主进程负责）。
 * 被谁调用：app.js。
 */

import React, { useMemo, useState } from 'react';
import { BallAvatar } from './bot-conversation.jsx';
import { BOT_TEMPLATES, DEFAULT_MODEL, EFFORTS, MODELS, TOOLS } from './bot-directory.js';

const shapes = [{ id: 'blob', label: '圆形' }, { id: 'wedge', label: '三角形' }, { id: 'gem', label: '菱形' }];
const colors = [{ value: '#f3f0ea', label: '暖白' }, { value: '#81d1c2', label: '薄荷' }, { value: '#a7c9f4', label: '浅蓝' }, { value: '#ad91e8', label: '浅紫' }, { value: '#76d1dc', label: '青蓝' }, { value: '#f4d88a', label: '琥珀' }];
const tags = ['通用', '写作', '编程', '设计', '研究', '规划', '效率'];
const MODES = [
  { id: 'template', label: '模板创建' },
  { id: 'nl', label: '一句话创建' },
  { id: 'custom', label: '自定义' },
];
const TONES = [
  { id: 'friendly', label: '温和友好' },
  { id: 'concise', label: '克制干练' },
  { id: 'rigorous', label: '严谨专业' },
  { id: 'creative', label: '启发活泼' },
];
const REPLY_LENGTHS = [
  { id: 'short', label: '简短' },
  { id: 'medium', label: '均衡' },
  { id: 'detailed', label: '详尽' },
];
const PROACTIVITIES = [
  { id: 'quiet', label: '低调少打扰' },
  { id: 'balanced', label: '适中协作' },
  { id: 'proactive', label: '积极主动' },
];

function inferDraftFromNaturalLanguage(promptText) {
  const text = String(promptText || '').trim();
  let tpl = BOT_TEMPLATES[0];
  if (/代码|编程|审查|bug|开发/i.test(text)) tpl = BOT_TEMPLATES[1];
  else if (/产品|调研|需求|分析/i.test(text)) tpl = BOT_TEMPLATES[2];
  else if (/早报|晨报|提醒|每日/i.test(text)) tpl = BOT_TEMPLATES[3];
  else if (/设计|ui|ux|界面|配色/i.test(text)) tpl = BOT_TEMPLATES[4];

  const quoted = /(?:叫|名为|名字是)[「"'\s]*([^\s，。,"'」的]{1,16})/.exec(text);
  const inferredName = quoted ? quoted[1] : tpl.name;
  const tone = /严谨|严肃|专业|客观/.test(text)
    ? 'rigorous'
    : /简洁|简短|干脆|直接/.test(text)
      ? 'concise'
      : /活泼|创意|启发/.test(text)
        ? 'creative'
        : 'friendly';
  const proactivity = /少打扰|安静|别主动/.test(text)
    ? 'quiet'
    : /主动|提醒|跟进|简报/.test(text) || tpl.proactiveEnabled
      ? 'proactive'
      : 'balanced';

  return {
    template: tpl,
    name: inferredName,
    tag: tpl.tag,
    roleTitle: tpl.name,
    description: text || tpl.description,
    model: tpl.model,
    effort: tpl.effort,
    tools: [...tpl.tools],
    appearance: { shape: tpl.shape, emotion: '02', color: tpl.color },
    tone,
    proactivity,
    proactiveEnabled: Boolean(tpl.proactiveEnabled || /提醒|早报|每日|跟进/.test(text)),
  };
}

export function BotBuilder({ onCreate, onCancel }) {
  const [mode, setMode] = useState('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState(BOT_TEMPLATES[0].id);
  const [nlPrompt, setNlPrompt] = useState('');
  const [name, setName] = useState(BOT_TEMPLATES[0].name);
  const [roleTitle, setRoleTitle] = useState(BOT_TEMPLATES[0].name);
  const [tag, setTag] = useState(BOT_TEMPLATES[0].tag);
  const [description, setDescription] = useState(BOT_TEMPLATES[0].description);
  const [muted, setMuted] = useState(false);
  const [model, setModel] = useState(() => (MODELS[DEFAULT_MODEL] ? DEFAULT_MODEL : (Object.keys(MODELS)[0] || DEFAULT_MODEL)));
  const [thinking, setThinking] = useState(false);
  const [effort, setEffort] = useState('medium');
  const [tools, setTools] = useState(() => ['search', 'memory']);
  const [tone, setTone] = useState('friendly');
  const [replyLength, setReplyLength] = useState('medium');
  const [proactivity, setProactivity] = useState('balanced');
  const [proactiveEnabled, setProactiveEnabled] = useState(false);
  const [appearance, setAppearance] = useState({ shape: 'blob', emotion: '02', color: '#f3f0ea' });

  const nlDraft = useMemo(() => inferDraftFromNaturalLanguage(nlPrompt), [nlPrompt]);

  function applyTemplate(tpl) {
    const resolvedModelKey = MODELS[tpl.model] ? tpl.model : (MODELS[DEFAULT_MODEL] ? DEFAULT_MODEL : (Object.keys(MODELS)[0] || tpl.model || DEFAULT_MODEL));
    setSelectedTemplateId(tpl.id);
    setName(tpl.name);
    setRoleTitle(tpl.name);
    setTag(tpl.tag);
    setDescription(tpl.description);
    setModel(resolvedModelKey);
    setThinking(tpl.effort === 'high');
    setEffort(tpl.effort || 'medium');
    setTools([...(tpl.tools || ['search', 'memory'])]);
    setProactiveEnabled(Boolean(tpl.proactiveEnabled));
    setAppearance({ shape: tpl.shape, emotion: '02', color: tpl.color });
  }

  function toggleTool(toolId) {
    setTools(prev => (prev.includes(toolId) ? prev.filter(id => id !== toolId) : [...prev, toolId]));
  }

  const previewAppearance = mode === 'nl' ? nlDraft.appearance : appearance;
  const previewName = mode === 'nl' ? (name.trim() && name !== BOT_TEMPLATES[0].name ? name.trim() : nlDraft.name) : (name.trim() || '新建 Bot');
  const canSubmit = mode === 'nl' ? Boolean(nlPrompt.trim()) : Boolean(name.trim());

  function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;

    if (mode === 'nl') {
      onCreate({
        creationMode: 'nl',
        promptText: nlPrompt.trim(),
        templateId: nlDraft.template.id,
        name: previewName,
        roleTitle: nlDraft.roleTitle,
        tag: nlDraft.tag,
        description: nlDraft.description,
        muted,
        appearance: nlDraft.appearance,
        model: MODELS[nlDraft.model]?.id || MODELS[DEFAULT_MODEL]?.id || Object.values(MODELS)[0]?.id || nlDraft.model,
        providerId: (MODELS[nlDraft.model] || MODELS[DEFAULT_MODEL] || Object.values(MODELS)[0])?.providerId,
        effort: nlDraft.effort,
        tools: nlDraft.tools,
        personaConfig: {
          tone: nlDraft.tone,
          replyLength,
          proactivity: nlDraft.proactivity,
          customInstructions: nlPrompt.trim(),
        },
        proactiveConfig: {
          enabled: nlDraft.proactiveEnabled,
          quietHoursStart: '22:00',
          quietHoursEnd: '08:00',
          maxDaily: 1,
        },
      });
      return;
    }

    onCreate({
      creationMode: mode,
      templateId: mode === 'template' ? selectedTemplateId : undefined,
      name: name.trim(),
      roleTitle: (roleTitle || tag || '通用协作者').trim(),
      tag: tag.trim() || '通用',
      description: description.trim(),
      muted,
      appearance,
      model: MODELS[model]?.id || model,
      providerId: MODELS[model]?.providerId,
      effort: thinking ? effort : 'medium',
      tools: [...tools],
      personaConfig: {
        tone,
        replyLength,
        proactivity,
        customInstructions: description.trim(),
      },
      proactiveConfig: {
        enabled: proactiveEnabled,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
        maxDaily: 1,
      },
    });
  }

  return <form className="bot-builder" onSubmit={handleSubmit}>
    <div className="bot-builder-header">
      <div><h2>新建 Bot</h2><p>支持重名，系统自动分配唯一 ID</p></div>
      <button className="bot-builder-close" type="button" aria-label="关闭" onClick={onCancel}>×</button>
    </div>

    <div className="bot-builder-mode-tabs" role="tablist" aria-label="创建方式">
      {MODES.map(item => <button
        key={item.id}
        type="button"
        role="tab"
        aria-selected={mode === item.id}
        className={`bot-builder-mode-tab${mode === item.id ? ' selected' : ''}`}
        onClick={() => {
          setMode(item.id);
          if (item.id === 'custom' && name === BOT_TEMPLATES[0].name) setName('');
          if (item.id === 'template') applyTemplate(BOT_TEMPLATES.find(t => t.id === selectedTemplateId) || BOT_TEMPLATES[0]);
        }}
      >{item.label}</button>)}
    </div>

    <div className="bot-builder-body">
      <div className="bot-builder-preview">
        <BallAvatar className="bot-builder-ball" appearance={previewAppearance} name={previewName} />
        <span>{previewName}</span>
      </div>

      {mode === 'template' ? <div className="bot-builder-templates" aria-label="Bot 模板列表">
        {BOT_TEMPLATES.map(tpl => <button
          key={tpl.id}
          type="button"
          className={`bot-builder-tpl${selectedTemplateId === tpl.id ? ' selected' : ''}`}
          onClick={() => applyTemplate(tpl)}
        >
          <BallAvatar className="bot-builder-tpl-avatar" appearance={{ shape: tpl.shape, emotion: '02', color: tpl.color }} name={tpl.name} />
          <span className="bot-builder-tpl-copy">
            <strong>{tpl.name}</strong>
            <small>{tpl.description}</small>
          </span>
        </button>)}
      </div> : null}

      {mode === 'nl' ? <div className="bot-builder-fields">
        <label className="bot-builder-nl-label">
          <span>一句话描述</span>
          <textarea
            rows="3"
            value={nlPrompt}
            onChange={event => setNlPrompt(event.target.value)}
            placeholder="例如：帮我建一个叫旅行搭子的规划 Bot，擅长制定日程和行前清单，简洁温柔"
            required
          />
        </label>
        <div className="bot-builder-nl-preview">
          <strong>自动解析预估</strong>
          <span>名称：{previewName} · 专长：{nlDraft.tag} · 模型：{MODELS[nlDraft.model]?.name || nlDraft.model}</span>
          <span>语气：{TONES.find(t => t.id === nlDraft.tone)?.label} · 能力：{nlDraft.tools.map(t => TOOLS[t]?.label || t).join(' / ')}</span>
        </div>
      </div> : null}

      {mode === 'custom' ? <>
        <div className="bot-builder-section">外观形态</div>
        <div className="bot-chips">{shapes.map(shape => <button className={`bot-chip${appearance.shape === shape.id ? ' selected' : ''}`} key={shape.id} type="button" onClick={() => setAppearance({ ...appearance, shape: shape.id })}>{shape.label}</button>)}</div>
        <div className="bot-swatches">{colors.map(color => <button className={`bot-swatch${appearance.color === color.value ? ' selected' : ''}`} key={color.value} type="button" style={{ '--swatch': color.value }} aria-label={color.label} onClick={() => setAppearance({ ...appearance, color: color.value })} />)}</div>
      </> : null}

      <div className="bot-builder-fields">
        <label><span>名称 {mode === 'nl' ? '' : <b>*</b>}</span><input type="text" value={name} onChange={event => setName(event.target.value)} placeholder={mode === 'nl' ? `留空将使用：${nlDraft.name}` : '输入名称（允许重名）'} maxLength="24" required={mode !== 'nl'} /></label>

        {mode !== 'nl' ? <>
          <label><span>专长</span><input type="text" value={tag} onChange={event => setTag(event.target.value)} placeholder="如：研究、编程" list="bot-tag-list" maxLength="16" /></label>
          <datalist id="bot-tag-list">{tags.map(item => <option value={item} key={item} />)}</datalist>
          <label className="bot-builder-model"><span>模型</span><select value={model} onChange={event => setModel(event.target.value)}>{Object.entries(MODELS).map(([id, item]) => <option value={id} key={id}>{item.name}</option>)}</select></label>
        </> : null}

        {mode === 'custom' ? <>
          <label className="bot-mute-row"><input type="checkbox" checked={thinking} onChange={event => setThinking(event.target.checked)} /><span>深度思考</span></label>
          {thinking ? <label className="bot-builder-model"><span>强度</span><select value={effort} onChange={event => setEffort(event.target.value)}>{EFFORTS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label> : null}
          <label className="bot-builder-model"><span>语气</span><select value={tone} onChange={event => setTone(event.target.value)}>{TONES.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          <label className="bot-builder-model"><span>篇幅</span><select value={replyLength} onChange={event => setReplyLength(event.target.value)}>{REPLY_LENGTHS.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          <label className="bot-builder-model"><span>主动性</span><select value={proactivity} onChange={event => setProactivity(event.target.value)}>{PROACTIVITIES.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          <div className="bot-builder-tools">
            <span>工具</span>
            <div className="bot-chips">
              {Object.entries(TOOLS).map(([id, tool]) => <button
                key={id}
                type="button"
                className={`bot-chip${tools.includes(id) ? ' selected' : ''}`}
                onClick={() => toggleTool(id)}
              >{tool.label}</button>)}
            </div>
          </div>
          <label><span>设定</span><textarea rows="2" value={description} onChange={event => setDescription(event.target.value)} placeholder="一句话介绍角色职责与沟通方式" maxLength="160" /></label>
          <label className="bot-mute-row"><input type="checkbox" checked={proactiveEnabled} onChange={event => setProactiveEnabled(event.target.checked)} /><span>允许定时任务与温和主动提醒（避开 22:00-08:00）</span></label>
        </> : null}

        <label className="bot-mute-row"><input type="checkbox" checked={muted} onChange={event => setMuted(event.target.checked)} /><span>默认静音（不弹出桌面提醒）</span></label>
      </div>
    </div>

    <div className="bot-builder-actions">
      <button type="button" onClick={onCancel}>取消</button>
      <button className="bot-builder-submit" type="submit" disabled={!canSubmit}>创建</button>
    </div>
  </form>;
}
