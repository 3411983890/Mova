import React, { useEffect, useId, useMemo, useState } from 'react';
import { confirmAction } from '../ui/confirm.js';
import { notify } from '../ui/toast.js';
import './browser-settings.css';

/* 浏览器设置：所有值都来自主进程的单一存储（electron/browser/settings.cjs），
   界面只做展示与写回，不在渲染层另存一份，避免同一开关两套真相。 */

const TIERS = [
  { id: 'read', label: '只读', note: '只能 snapshot / read / screenshot，不点击、不填写、不滚动。' },
  { id: 'interact', label: '可交互', note: '允许点击、填写、滚动与按键，也包含立即购买、下单等正常购物流程；提交表单仍需确认。' },
  { id: 'submit', label: '可提交', note: '允许提交表单、登录、下载与完成购买；不可逆动作仍单独确认。' },
];

const SCOPES = [
  { id: 'conversation', label: '仅当前对话' },
  { id: 'all', label: '所有对话' },
];

const CLEAR_TARGETS = [
  { id: 'cookies', label: 'Cookie', note: '各站点的登录会话。' },
  { id: 'cache', label: '缓存', note: '网页资源缓存，不影响登录。' },
  { id: 'localStorage', label: 'localStorage / IndexedDB', note: '站点本地数据与离线缓存。' },
];

// 站点技能保存模式：写入 settings.skills.mode，值与主进程约定一致。
const SKILL_MODES = [
  { id: 'model', label: '由模型判断', note: '默认选项。' },
  { id: 'always', label: '每次成功后自动记录', note: '每次多步操作成功都静默保存。' },
  { id: 'off', label: '关闭', note: '不再产生候选，也不保存新技能。' },
];

// 技能列表 / 卡片读取失败时的说明：错误码来自主进程，不能直接展示给用户。
const LIST_ERRORS = {
  unsupported: '当前预览环境没有技能接口，请在 Mova 桌面端查看技能列表。',
  'skills-unavailable': '当前桌面端还没有启用站点技能存储，暂时无法读取或保存技能。',
  unauthorized: '当前窗口无权访问站点技能，请重新打开设置页。',
};

const EMPTY = {
  basics: { enabled: true, newTabUrl: 'https://www.google.com', restoreTabs: false, rememberWidth: true, autoCollapseSidebar: false },
  agent: { tier: 'interact', confirmPerSite: true, sessionWaiver: false, sensitiveAlwaysConfirm: true },
  login: { savePasswords: true, saveStorage: true, askCookieLogin: true, recordScope: 'conversation' },
  transfer: { downloadDir: '', openAfterDownload: false, blockExecutables: true, uploadMaxMb: 25, confirmUpload: true },
  skills: { mode: 'model' },
  advanced: { jsBatch: false, actionTimeoutMs: 8000, waitTimeoutMs: 30000, snapshotBudget: 24000, diffThreshold: 0.6, iframeFallback: true },
};

/** 主进程 bridge 有两种返回外形：裸值，或 { ok, value } 包一层。这里统一取列表。 */
function listOf(result, key) {
  if (!result) return { ok: false, error: 'unsupported' };
  if (result.ok === false) return { ok: false, error: result.error || 'failed' };
  const inner = result.value ?? result;
  if (inner && inner.ok === false) return { ok: false, error: inner.error || inner.code || 'failed' };
  const items = Array.isArray(inner) ? inner : Array.isArray(inner?.[key]) ? inner[key] : [];
  return { ok: true, items };
}

function stepCountOf(skill) {
  const count = Number(skill?.stepCount ?? (Array.isArray(skill?.steps) ? skill.steps.length : 0));
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function rateOf(skill) {
  const ok = Number(skill?.stats?.ok) || 0;
  const fail = Number(skill?.stats?.fail) || 0;
  const total = ok + fail;
  return total ? `${Math.round((ok / total) * 100)}%` : '—';
}

function Row({ title, description, children, note }) {
  return <div className="settings-row">
    <div className="settings-row-text"><strong>{title}</strong>{description && <p>{description}</p>}</div>
    {children ?? (note ? <span className="settings-section-note">{note}</span> : null)}
  </div>;
}

function Switch({ label, checked, disabled, onChange }) {
  return <button type="button" className="settings-switch" role="switch" aria-label={label} aria-checked={checked}
    disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function BrowserSettings({ bridge }) {
  const uid = useId();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState([]);
  const [skillsError, setSkillsError] = useState('');
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [modeNote, setModeNote] = useState('');
  const [cards, setCards] = useState([]);
  const [activeUrl, setActiveUrl] = useState('');
  const [onlyThisSite, setOnlyThisSite] = useState(true);
  const [clearPicked, setClearPicked] = useState(['cookies', 'cache']);

  const available = Boolean(bridge?.settings?.get);

  const load = async () => {
    if (!available) { setSettings(EMPTY); return; }
    try {
      const result = await bridge.settings.get();
      if (!result?.ok) throw new Error(result?.message || result?.error || '读取设置失败');
      setSettings(result.value);
      setError('');
    } catch (reason) { setError(reason?.message || '读取设置失败'); setSettings(EMPTY); }
  };

  const loadSite = async (options = {}) => {
    if (!available) return;
    setSkillsLoading(true);
    try {
      const [listResult, cardResult, urlResult] = await Promise.all([
        bridge.skills?.list?.() ?? null,
        bridge.cards?.list?.() ?? null,
        bridge.activeUrl?.() ?? null,
      ]);
      const skillsView = listOf(listResult, 'skills');
      if (skillsView.ok) { setSkills(skillsView.items); setSkillsError(''); }
      else setSkillsError(LIST_ERRORS[skillsView.error] || '无法读取技能列表，请稍后重试。');
      const cardsView = listOf(cardResult, 'cards');
      if (cardsView.ok) setCards(cardsView.items);
      if (urlResult?.ok) setActiveUrl(String(urlResult.value || ''));
      if (options.announce && skillsView.ok) notify('技能列表已刷新');
    } catch (reason) {
      setSkillsError(reason?.message || '无法读取技能列表，请稍后重试。');
    } finally {
      setSkillsLoading(false);
    }
  };

  useEffect(() => { void load(); void loadSite(); }, [available]);

  const origin = useMemo(() => {
    try { return new URL(activeUrl).origin; } catch { return ''; }
  }, [activeUrl]);

  const siteSkills = useMemo(() => {
    if (!onlyThisSite || !origin) return skills;
    return skills.filter(skill => skill.origin === origin);
  }, [skills, onlyThisSite, origin]);

  const siteCards = useMemo(() => {
    if (!onlyThisSite || !origin) return cards;
    return cards.filter(card => card.origin === origin);
  }, [cards, onlyThisSite, origin]);

  // 读取到 settings.skills.mode 才算支持新模式；旧后端只返回 autoRecord，这里按默认值展示并说明。
  const rawMode = (settings ?? EMPTY).skills?.mode;
  const modeKnown = SKILL_MODES.some(mode => mode.id === rawMode);
  const currentMode = modeKnown ? rawMode : 'model';
  const modeReadIssue = Boolean(settings) && !error && !modeKnown;
  const modeHint = modeNote || (error
    ? '保存模式读取失败：设置没有读到，这里显示的是默认值「由模型判断」，重新打开设置页后再试。'
    : modeReadIssue
      ? '无法读取保存模式：当前桌面端没有返回 skills.mode（可能版本较旧），这里显示默认值「由模型判断」，切换后可能不会生效。'
      : '');

  async function patch(section, key, value) {
    if (!available) { notify('浏览器设置需要桌面版', { tone: 'error' }); return; }
    const previous = settings;
    setSettings(current => ({ ...current, [section]: { ...current[section], [key]: value } }));
    try {
      const result = await bridge.settings.set({ [section]: { [key]: value } });
      if (!result?.ok) throw new Error(result?.error || '保存失败');
      setSettings(result.value);
      setError('');
    } catch (reason) {
      setSettings(previous);   // 失败必须回滚，不能让界面显示未生效的值
      notify(reason.message || '保存失败', { tone: 'error' });
    }
  }

  /**
   * 保存模式单独走一条写回：主进程若还不认识 skills.mode，会把该字段丢掉，
   * 这时保留界面选择但必须明确告知「没有生效」，不能假装保存成功。
   */
  async function setMode(mode) {
    if (!available) { notify('浏览器设置需要桌面版', { tone: 'error' }); return; }
    const previous = settings;
    setModeNote('');
    setSettings(current => ({ ...current, skills: { ...current.skills, mode } }));
    try {
      const result = await bridge.settings.set({ skills: { mode } });
      if (!result?.ok) throw new Error(result?.message || result?.error || '保存失败');
      if (result.value?.skills?.mode === mode) {
        setSettings(result.value);
        setError('');
        notify(`保存模式已切换为「${SKILL_MODES.find(item => item.id === mode)?.label || mode}」`);
        return;
      }
      setModeNote('保存模式没有生效：当前桌面端还没有提供 skills.mode 设置，更新到新版本后再试。');
      notify('保存模式未生效：桌面端版本较旧', { tone: 'error' });
    } catch (reason) {
      setSettings(previous);   // 失败必须回滚，不能让界面显示未生效的值
      const message = reason.message || '保存失败';
      setModeNote(`保存模式保存失败：${message}`);
      notify(message, { tone: 'error' });
    }
  }

  async function pickDownloadDir() {
    if (!available) return;
    try {
      const result = await bridge.settings.pickDownloadDir();
      if (result?.ok && result.value) { await load(); notify('下载目录已更新'); }
    } catch (reason) { notify(reason.message || '无法选择目录', { tone: 'error' }); }
  }

  async function resetDownloadDir() {
    if (!available) return;
    try {
      const result = await bridge.settings.resetDownloadDir();
      if (result?.ok) { await load(); notify('已恢复默认下载目录'); }
    } catch (reason) { notify(reason.message || '恢复失败', { tone: 'error' }); }
  }

  async function openDownloadDir() {
    if (!available) return;
    try {
      const result = await bridge.settings.openDownloadDir();
      if (!result?.ok) throw new Error(result?.error || '无法打开目录');
      if (!result.value?.opened) notify(result.value?.error || '目录不存在或无法打开', { tone: 'error' });
    } catch (reason) { notify(reason.message || '无法打开目录', { tone: 'error' }); }
  }

  async function clearLoginRecords(scope) {
    if (!available) return;
    const confirmed = await confirmAction({
      title: scope === 'origin' ? '清除本站登录记录？' : '清除全部登录记录？',
      body: scope === 'origin' ? `将删除 ${origin || '当前站点'} 的 Cookie 与登录记录，需要重新登录。` : '将删除所有站点的 Cookie 与登录记录，需要重新登录。',
      detail: '长期记忆、对话历史和站点技能不受影响。',
      confirmLabel: '清除',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const targets = scope === 'origin' ? ['cookies'] : ['cookies', 'localStorage'];
      const result = await bridge.clearData({ targets });
      if (!result?.ok) throw new Error(result?.error || '清理失败');
      notify(scope === 'origin' ? '已清除本站登录记录' : '已清除全部登录记录');
    } catch (reason) { notify(reason.message || '清理失败', { tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function clearBrowserData() {
    if (!available) return;
    if (!clearPicked.length) { notify('请至少选择一类数据', { tone: 'error' }); return; }
    const confirmed = await confirmAction({
      title: '清空浏览器数据？',
      body: '所选数据会立即删除，无法恢复。',
      detail: '清空后需要重新登录相关站点；对话历史与站点技能不受影响。',
      confirmLabel: '清空',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await bridge.clearData({ targets: clearPicked });
      if (!result?.ok) throw new Error(result?.error || '清理失败');
      const cleared = result.value?.cleared ?? [];
      notify(cleared.length ? `已清空：${cleared.join('、')}` : '没有需要清理的数据');
    } catch (reason) { notify(reason.message || '清理失败', { tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function resetPartition() {
    if (!available) return;
    const confirmed = await confirmAction({
      title: '重置浏览器分区？',
      body: '该分区的 Cookie、缓存、localStorage 与 IndexedDB 会被全部删除。',
      detail: '这是危险操作：所有站点的登录状态都会丢失，且无法恢复。',
      confirmLabel: '重置分区',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await bridge.resetPartition();
      if (!result?.ok) throw new Error(result?.error || '重置失败');
      notify('浏览器分区已重置');
    } catch (reason) { notify(reason.message || '重置失败', { tone: 'error' }); }
    finally { setBusy(false); }
  }

  /** 登录态导入 / 导出：走主进程的加密 storageState，密码不经过对话。 */
  async function storageState(mode) {
    if (!available) return;
    setBusy(true);
    try {
      const result = mode === 'export' ? await bridge.storage.export() : await bridge.storage.import();
      if (!result?.ok) throw new Error(result?.error || (mode === 'export' ? '导出失败' : '导入失败'));
      notify(mode === 'export' ? '已导出加密登录态' : '已导入加密登录态');
    } catch (reason) { notify(reason.message || '操作失败', { tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function clearCards() {
    if (!available) return;
    const confirmed = await confirmAction({
      title: origin ? `清空 ${origin} 的站点卡片？` : '清空全部站点卡片？',
      body: '删除已学到的地标与备注，下次会重新学习。',
      confirmLabel: '清空',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const result = await bridge.cards.clear(origin ? { origin } : {});
      if (!result?.ok) throw new Error(result?.error || '清空失败');
      await loadSite();
      notify('站点卡片已清空');
    } catch (reason) { notify(reason.message || '清空失败', { tone: 'error' }); }
  }

  async function removeSkill(skill) {
    if (!available) return;
    const title = skill?.title || skill?.name || '未命名流程';
    const confirmed = await confirmAction({
      title: `删除技能「${title}」？`,
      body: '删除后 Agent 不再自动复用这条流程；需要时可以重新记录一次。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const result = await bridge.skills.remove(skill.id);
      if (!result?.ok) throw new Error(result?.message || result?.error || '删除失败');
      if (result.value === false) throw new Error('这条技能已经不存在，刷新后再看');
      await loadSite();
      notify('技能已删除');
    } catch (reason) { notify(reason.message || '删除失败', { tone: 'error' }); }
  }

  const value = settings ?? EMPTY;

  return <div className="browser-settings" aria-busy={busy}>
    {!available && <div className="memory-banner" role="status">当前浏览器预览没有 Electron 桥接：设置可以查看，但保存、清理与重置都不可用，请在 Mova 桌面端使用。</div>}
    {error && <div className="memory-error" role="alert">{error}</div>}

    <section className="settings-section" aria-labelledby={`${uid}-basics`}>
      <h3 className="settings-section-title" id={`${uid}-basics`}>浏览器基础</h3>
      <div className="settings-card">
        <Row title="启用内置浏览器" description="关闭后不再打开右侧分屏，Agent 的浏览器工具同时停用。">
          <Switch label="启用内置浏览器" checked={value.basics.enabled} disabled={!available} onChange={next => patch('basics', 'enabled', next)} />
        </Row>
        <Row title="新标签页地址" description="留空表示打开空白页。只接受 http / https 地址。">
          <input className="browser-setting-input" aria-label="新标签页地址" value={value.basics.newTabUrl}
            placeholder="留空为空白页" disabled={!available}
            onChange={event => setSettings(current => ({ ...current, basics: { ...current.basics, newTabUrl: event.target.value } }))}
            onBlur={event => patch('basics', 'newTabUrl', event.target.value)} />
        </Row>
        <Row title="启动时恢复上次标签页" description="关闭时每次启动只打开一个新标签页。">
          <Switch label="恢复上次标签页" checked={value.basics.restoreTabs} disabled={!available} onChange={next => patch('basics', 'restoreTabs', next)} />
        </Row>
        <Row title="记住浏览器宽度" description="拖动分屏宽度后记住，下次按同样宽度打开。">
          <Switch label="记住浏览器宽度" checked={value.basics.rememberWidth} disabled={!available} onChange={next => patch('basics', 'rememberWidth', next)} />
        </Row>
        <Row title="打开浏览器时自动收起左侧栏" description="为网页争取宽度，关闭分屏后不自动恢复。">
          <Switch label="自动收起左侧栏" checked={value.basics.autoCollapseSidebar} disabled={!available} onChange={next => patch('basics', 'autoCollapseSidebar', next)} />
        </Row>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-agent`}>
      <h3 className="settings-section-title" id={`${uid}-agent`}>Agent 操作权限</h3>
      <p className="memory-muted">按风险分级授权。等级只决定「不需要额外确认就能做什么」；购买与下单按等级放行，删除、转账等不可逆动作每次确认，需要本人完成的动作（银行卡、扫码支付、密码与验证码）会直接停下交给你。</p>
      <div className="settings-card">
        <div className="browser-setting-tier-head">
          <div className="settings-row-text"><strong>授权等级</strong><p>当前：<b>{TIERS.find(tier => tier.id === value.agent.tier)?.label}</b>。升级到「可提交」表示 Agent 可以直接提交表单与登录。</p></div>
        </div>
        <div className="browser-setting-tiers" role="radiogroup" aria-label="Agent 授权等级">
          {TIERS.map(tier => <button key={tier.id} type="button" role="radio" aria-checked={value.agent.tier === tier.id}
            className="settings-choice" disabled={!available} onClick={() => patch('agent', 'tier', tier.id)}>
            <span className="settings-choice-dot" data-checked={value.agent.tier === tier.id} aria-hidden="true" />
            <span className="settings-choice-text"><strong>{tier.label}</strong><small>{tier.note}</small></span>
          </button>)}
        </div>
        <Row title="每站点首次确认" description="同一个站点第一次操作时询问一次，之后按等级放行。">
          <Switch label="每站点首次确认" checked={value.agent.confirmPerSite} disabled={!available} onChange={next => patch('agent', 'confirmPerSite', next)} />
        </Row>
        <Row title="本会话免确认" description="只在当前这次浏览会话内生效，重启后自动恢复确认。">
          <Switch label="本会话免确认" checked={value.agent.sessionWaiver} disabled={!available} onChange={next => patch('agent', 'sessionWaiver', next)} />
        </Row>
        <Row title="不可逆动作始终确认" description="删除、转账、汇款等不可逆动作每次都询问；银行卡、扫码支付、密码与验证码会停下等你本人处理。购买与下单按授权等级放行。此项锁定，不可关闭。">
          <span className="browser-setting-locked" aria-label="已锁定，不可关闭">已锁定</span>
        </Row>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-login`}>
      <h3 className="settings-section-title" id={`${uid}-login`}>登录与 Cookie</h3>
      <div className="settings-card">
        <Row title="保存登录密码" description="登录成功后把凭据写入加密保险库，密码不会进入对话。">
          <Switch label="保存登录密码" checked={value.login.savePasswords} disabled={!available} onChange={next => patch('login', 'savePasswords', next)} />
        </Row>
        <Row title="保存 Cookie / localStorage" description="按站点保存登录态，下次打开可直接复用。">
          <Switch label="保存 Cookie 与 localStorage" checked={value.login.saveStorage} disabled={!available} onChange={next => patch('login', 'saveStorage', next)} />
        </Row>
        <Row title="再次访问时询问「用 Cookie 登录」" description="关闭后自动使用已保存的登录态，不再询问。">
          <Switch label="询问用 Cookie 登录" checked={value.login.askCookieLogin} disabled={!available} onChange={next => patch('login', 'askCookieLogin', next)} />
        </Row>
        <Row title="Cookie 记录范围" description="「仅当前对话」不会把登录态带进其它对话。">
          <select className="settings-select" aria-label="Cookie 记录范围" value={value.login.recordScope} disabled={!available}
            onChange={event => patch('login', 'recordScope', event.target.value)}>
            {SCOPES.map(scope => <option key={scope.id} value={scope.id}>{scope.label}</option>)}
          </select>
        </Row>
        <Row title="清除本站登录记录" description={origin ? `当前站点：${origin}` : '打开一个网页后可按站点清除。'}>
          <button type="button" className="settings-button" disabled={!available || !origin || busy} onClick={() => clearLoginRecords('origin')}>清除本站</button>
        </Row>
        <Row title="清除全部登录记录" description="删除所有站点的 Cookie 与登录记录，需要重新登录。">
          <button type="button" className="settings-button danger" disabled={!available || busy} onClick={() => clearLoginRecords('all')}>清除全部</button>
        </Row>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-transfer`}>
      <h3 className="settings-section-title" id={`${uid}-transfer`}>下载与上传</h3>
      <div className="settings-card">
        <Row title="下载目录" description={value.transfer.downloadDir || '尚未设置'}>
          <div className="browser-setting-actions">
            <button type="button" className="settings-button" disabled={!available} onClick={pickDownloadDir}>更改</button>
            <button type="button" className="settings-button" disabled={!available} onClick={openDownloadDir}>打开</button>
            <button type="button" className="settings-button" disabled={!available} onClick={resetDownloadDir}>恢复默认</button>
          </div>
        </Row>
        <Row title="下载完成后打开文件" description="默认关闭；可执行文件即使打开开关也不会自动运行。">
          <Switch label="下载完成后打开文件" checked={value.transfer.openAfterDownload} disabled={!available} onChange={next => patch('transfer', 'openAfterDownload', next)} />
        </Row>
        <Row title="阻止可执行文件下载" description="拒绝 .exe / .msi / .bat / .ps1 等类型，避免误下载后被执行。">
          <Switch label="阻止可执行文件下载" checked={value.transfer.blockExecutables} disabled={!available} onChange={next => patch('transfer', 'blockExecutables', next)} />
        </Row>
        <Row title="上传大小上限" description="单次上传的总大小上限，超过会被拒绝。">
          <div className="browser-setting-actions">
            <input className="browser-setting-number" type="number" min="1" max="512" aria-label="上传大小上限（MB）"
              value={value.transfer.uploadMaxMb} disabled={!available}
              onChange={event => setSettings(current => ({ ...current, transfer: { ...current.transfer, uploadMaxMb: event.target.value } }))}
              onBlur={event => patch('transfer', 'uploadMaxMb', Number(event.target.value))} />
            <span className="settings-section-note">MB</span>
          </div>
        </Row>
        <Row title="上传文件时始终确认" description="每次选择文件上传前都询问一次。">
          <Switch label="上传文件时始终确认" checked={value.transfer.confirmUpload} disabled={!available} onChange={next => patch('transfer', 'confirmUpload', next)} />
        </Row>
      </div>
    </section>

    <section className="settings-section" aria-labelledby={`${uid}-skills`}>
      <div className="browser-setting-head">
        <h3 className="settings-section-title" id={`${uid}-skills`}>站点技能</h3>
        <div className="browser-setting-head-actions">
          <label className="browser-setting-filter"><input type="checkbox" checked={onlyThisSite} onChange={event => setOnlyThisSite(event.target.checked)} />仅当前站点{origin ? `（${origin}）` : ''}</label>
          <button type="button" className="settings-button" disabled={!available || skillsLoading} onClick={() => void loadSite({ announce: true })}>
            {skillsLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {onlyThisSite && !origin && <p className="memory-muted">当前没有打开的网页，「仅当前站点」暂时显示全部站点的技能。</p>}

      <div className="settings-card">
        <div className="browser-setting-tier-head">
          <div className="settings-row-text">
            <strong>保存模式</strong>
            <p>由模型判断时，只有可复用的多步流程才会被保存；保存后可在下方列表查看或删除。</p>
          </div>
        </div>
        <div className="browser-setting-modes" role="radiogroup" aria-label="站点技能保存模式">
          {SKILL_MODES.map(mode => <button key={mode.id} type="button" role="radio"
            aria-checked={currentMode === mode.id} className="settings-choice"
            disabled={!available} onClick={() => setMode(mode.id)}>
            <span className="settings-choice-dot" data-checked={currentMode === mode.id} aria-hidden="true" />
            <span className="settings-choice-text"><strong>{mode.label}</strong><small>{mode.note}</small></span>
          </button>)}
        </div>
        {modeHint && <p className="browser-setting-mode-note" data-tone={modeNote || error ? 'warn' : 'note'}>{modeHint}</p>}
      </div>

      <div className="settings-card browser-setting-list" aria-busy={skillsLoading}>
        {skillsError && <div className="browser-setting-list-state" role="alert">
          <p>{skillsError}</p>
          <button type="button" className="settings-button" disabled={!available || skillsLoading} onClick={() => void loadSite({ announce: true })}>重试</button>
        </div>}
        {!skillsError && skillsLoading && siteSkills.length === 0 && <p className="browser-setting-list-note">正在读取技能列表…</p>}
        {!skillsError && !skillsLoading && siteSkills.length === 0 && <div className="memory-empty">
          <p>{onlyThisSite && origin
            ? '这个站点还没有保存的技能。Agent 完成一次可复用的多步流程后，技能会出现在这里。'
            : '还没有保存任何站点技能。选择「由模型判断」或「每次成功后自动记录」后，成功完成的流程会出现在这里。'}</p>
        </div>}
        {!skillsError && siteSkills.map(skill => {
          const title = skill.title || skill.name || '未命名流程';
          const steps = stepCountOf(skill);
          return <div className="browser-setting-item" key={skill.id}>
            <div className="browser-setting-item-main">
              <strong>{title}</strong>
              <small>{skill.origin || '未知站点'} · {steps ? `${steps} 步` : '步数未知'} · 成功率 {rateOf(skill)}</small>
            </div>
            <div className="browser-setting-item-actions">
              <button type="button" className="settings-button danger" disabled={!available}
                aria-label={`删除技能：${title}`} onClick={() => void removeSkill(skill)}>删除</button>
            </div>
          </div>;
        })}
      </div>

      <div className="settings-card">
        <Row title="站点卡片" description={siteCards.length ? `已学习 ${siteCards.length} 个站点的地标与备注。` : '还没有学到任何站点地标。'}>
          <button type="button" className="settings-button" disabled={!available || !siteCards.length} onClick={clearCards}>清空</button>
        </Row>
      </div>
    </section>

    <details className="settings-section settings-advanced">
      <summary className="browser-setting-summary">高级设置</summary>
      <p className="memory-muted">默认折叠。这些值直接决定运行时行为，改动会立即对下一次动作生效。</p>
      <div className="settings-card">
        <Row title="JavaScript 批处理" description="允许一次执行多步脚本。开启后每一步仍逐次审批。">
          <Switch label="JavaScript 批处理" checked={value.advanced.jsBatch} disabled={!available} onChange={next => patch('advanced', 'jsBatch', next)} />
        </Row>
        <Row title="动作超时" description="单个点击 / 填写动作的最长等待时间。">
          <div className="browser-setting-actions">
            <input className="browser-setting-number" type="number" min="1" max="60" aria-label="动作超时（秒）"
              value={Math.round(value.advanced.actionTimeoutMs / 1000)} disabled={!available}
              onChange={event => setSettings(current => ({ ...current, advanced: { ...current.advanced, actionTimeoutMs: Number(event.target.value) * 1000 } }))}
              onBlur={event => patch('advanced', 'actionTimeoutMs', Number(event.target.value) * 1000)} />
            <span className="settings-section-note">秒</span>
          </div>
        </Row>
        <Row title="等待超时" description="browser_wait 的最长等待时间。">
          <div className="browser-setting-actions">
            <input className="browser-setting-number" type="number" min="1" max="120" aria-label="等待超时（秒）"
              value={Math.round(value.advanced.waitTimeoutMs / 1000)} disabled={!available}
              onChange={event => setSettings(current => ({ ...current, advanced: { ...current.advanced, waitTimeoutMs: Number(event.target.value) * 1000 } }))}
              onBlur={event => patch('advanced', 'waitTimeoutMs', Number(event.target.value) * 1000)} />
            <span className="settings-section-note">秒</span>
          </div>
        </Row>
        <Row title="快照字符预算" description="单次 snapshot 返回给模型的最大字符数，超出会被截断。">
          <div className="browser-setting-actions">
            <input className="browser-setting-number" type="number" min="2000" max="200000" step="1000" aria-label="快照字符预算"
              value={value.advanced.snapshotBudget} disabled={!available}
              onChange={event => setSettings(current => ({ ...current, advanced: { ...current.advanced, snapshotBudget: Number(event.target.value) } }))}
              onBlur={event => patch('advanced', 'snapshotBudget', Number(event.target.value))} />
            <span className="settings-section-note">字符</span>
          </div>
        </Row>
        <Row title="Diff 回退阈值" description="变化超过这个比例时放弃增量、返回整页快照。">
          <div className="browser-setting-actions">
            <input className="browser-setting-number" type="number" min="10" max="100" step="5" aria-label="Diff 回退阈值（百分比）"
              value={Math.round(value.advanced.diffThreshold * 100)} disabled={!available}
              onChange={event => setSettings(current => ({ ...current, advanced: { ...current.advanced, diffThreshold: Number(event.target.value) / 100 } }))}
              onBlur={event => patch('advanced', 'diffThreshold', Number(event.target.value) / 100)} />
            <span className="settings-section-note">%</span>
          </div>
        </Row>
        <Row title="跨域 iframe DOM 点击兜底" description="框架内元素点不到时，改用坐标点击兜底。">
          <Switch label="iframe 点击兜底" checked={value.advanced.iframeFallback} disabled={!available} onChange={next => patch('advanced', 'iframeFallback', next)} />
        </Row>
        <Row title="截图仅当前可见标签页" description="后台标签页无法截图，这是浏览器的行为，不提供开关。" note="只读说明" />
        <Row title="登录态导入 / 导出" description="导出当前站点的加密 storageState（Cookie 与 localStorage），文件由系统加密，可迁移到另一台机器。">
          <div className="browser-setting-actions">
            <button type="button" className="settings-button" disabled={!available || busy} onClick={() => storageState('export')}>导出</button>
            <button type="button" className="settings-button" disabled={!available || busy} onClick={() => storageState('import')}>导入</button>
          </div>
        </Row>
      </div>

      <div className="settings-card">
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text"><strong>清空浏览器数据</strong><p>只清理所选类别；对话历史与站点技能不受影响。</p></div>
          <div className="browser-setting-checklist">
            {CLEAR_TARGETS.map(target => <label key={target.id} className="browser-setting-check">
              <input type="checkbox" checked={clearPicked.includes(target.id)} disabled={!available}
                onChange={event => setClearPicked(current => event.target.checked ? [...current, target.id] : current.filter(id => id !== target.id))} />
              <span>{target.label}<small>{target.note}</small></span>
            </label>)}
            <p className="memory-muted">下载记录：本版本没有本地下载记录存储，无需清理。</p>
          </div>
          <div className="browser-setting-actions">
            <button type="button" className="settings-button danger" disabled={!available || busy} onClick={clearBrowserData}>清空所选数据</button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <Row title="重置浏览器分区" description="清掉该分区的全部 Cookie、缓存与站点数据，相当于换一个全新浏览器。">
          <button type="button" className="settings-button danger" disabled={!available || busy} onClick={resetPartition}>重置分区</button>
        </Row>
      </div>
    </details>
  </div>;
}

export default BrowserSettings;
