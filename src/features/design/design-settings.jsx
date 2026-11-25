import React, { useEffect, useState } from 'react';
import { notify } from '../ui/toast.js';

export function DesignSettings({ bridge }) {
  const [settings, setSettings] = useState(null), [error, setError] = useState('');
  useEffect(() => { let live = true; bridge?.settings().then(r => { if (!live) return; if (r.ok) setSettings(r.value); else setError(r.error); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [bridge]);
  async function patch(key, value) { try { const r = await bridge.configure({ [key]: value }); if (!r.ok) throw new Error(r.error); setSettings(r.value); window.dispatchEvent(new CustomEvent('mova:design-settings', { detail: r.value })); } catch (e) { notify(e.message, { tone: 'error' }); } }
  const row = (title, description, control) => <div className="settings-row"><div className="settings-row-text"><strong>{title}</strong><p>{description}</p></div>{control}</div>;
  const toggle = key => <button type="button" className="settings-switch" role="switch" aria-label={key === 'enabled' ? '启用设计画板' : '允许 AI 编辑画板'} aria-checked={!!settings?.[key]} disabled={!settings} onClick={() => void patch(key, !settings[key])}><span /></button>;
  return <>
    <section className="settings-section"><h3 className="settings-section-title">设计画板</h3><div className="settings-card">
      {row('启用设计画板', '在对话旁创建和编辑界面，与 AI 使用同一份设计文档。', toggle('enabled'))}
      {row('编辑引擎', '使用 OpenPencil 的真实画布、图层、选区和编辑能力。', <span className="settings-section-note">{settings?.engine || (bridge ? '正在读取…' : '需要桌面版')}</span>)}
    </div></section>
    <section className="settings-section"><h3 className="settings-section-title">AI 协作</h3><div className="settings-card">
      {row('允许 AI 编辑画板', 'AI 可以创建页面、修改图层和撤销设计操作。关闭后仍可读取和手动编辑。', toggle('aiEdit'))}
      {row('设计模型', '沿用当前对话选择的模型和密钥。需要支持工具调用。', <span className="settings-section-note">跟随当前对话</span>)}
    </div></section>
    <section className="settings-section"><h3 className="settings-section-title">文档与保存</h3><div className="settings-card">
      {row('按对话保存', '每个对话独立保存设计文档，重启应用后可以继续编辑。', <span className="settings-section-note">本机自动保存</span>)}
      {row('同时编辑', '手动修改与 AI 修改共用版本；遇到版本变化时保留已保存内容并提示重新读取。', <span className="settings-section-note">版本校验</span>)}
    </div></section>
    {(error || !bridge) && <p role="status" className="settings-section-note">{error || '请在 Mova 桌面版配置和使用设计画板。'}</p>}
  </>;
}
