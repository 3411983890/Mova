/**
 * 设置页 · CLI 模型（订阅额度）。
 *
 * 负责：六段页面编排（ChatGPT 订阅 / Gemini 订阅 / 额度调度 / 会话模型 / 运行方式 /
 * 合规横幅）、页面级状态（打开哪个登录面板、哪个菜单、退出确认），以及把控件动作
 * 交给 use-subscription 的 actions。
 * 不负责：页头（外层 .settings-panel-head 提供）、IPC 细节（use-subscription.js）、
 * 纯文案换算（cli-models-view.js）、账号卡片内部结构（cli-models-accounts.jsx）。
 *
 * 挂载方式（由统筹者接线）：
 *   createRoot($('#settings-page-cli-models')).render(<CliModelsSettings desktop={window.movaDesktop} />);
 *
 * 视觉基准：cli-models-settings.html（已审查通过）。
 *
 * @see Mova-CLI模型-开发文档.md §12.1
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSubscription } from './use-subscription.js';
import {
  CHANNEL_OPTIONS, REFRESH_OPTIONS, RUNNER_OPTIONS,
  refreshIntervalLabel, sortAccounts,
} from './cli-models-view.js';
import { ProviderCard } from './cli-models-accounts.jsx';
import { CliInstallDialog } from './cli-models-install-dialog.jsx';
import { cliStateOf, isCliUsableState, normalizePlatform } from './install-cli-prompt.mjs';
import { CmDialog, CmSelect, CmSwitch, CmToastStack, Icon, useToasts } from './cli-models-parts.jsx';
import './cli-models-settings.css';

/** 渲染层能拿到的平台线索：优先 desktop 暴露的值，否则从 navigator 猜。 */
function detectPlatform(desktop) {
  const explicit = desktop?.platform;
  if (typeof explicit === 'string' && explicit) return normalizePlatform(explicit);
  if (typeof navigator === 'undefined') return '';
  return normalizePlatform(`${navigator.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`);
}

export function CliModelsSettings({ desktop }) {
  const uid = useId();
  const { accounts, settings, cli, cliState, busy, error, login, source, actions } = useSubscription(desktop);
  const { items: toasts, push: toast, dismiss } = useToasts();
  const [now, setNow] = useState(() => Date.now());
  const [openLogin, setOpenLogin] = useState('');
  const [menuFor, setMenuFor] = useState('');
  const [logoutTarget, setLogoutTarget] = useState(null);
  const [installOpen, setInstallOpen] = useState(false);
  const platform = useMemo(() => detectPlatform(desktop), [desktop]);
  // 登录失败后、CLI 状态还没刷新回来时先记一笔，等状态落地再弹一次（不重复弹）。
  const pendingInstallRef = useRef(false);

  // 倒计时按分钟级文案展示，30s 的粗粒度刷新足够，不用秒级重渲染。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // 登录成功 → 面板自动收起，新账号行由 accounts 变化自然出现；取消 → 直接收起。
  useEffect(() => {
    if (!login) return;
    if (login.state === 'authorized') {
      setOpenLogin('');
      if (login.account?.email) toast(`已添加 ${login.account.email}`, 'ok');
      return;
    }
    if (login.state === 'cancelled') {
      setOpenLogin('');
      return;
    }
    if (login.state === 'failed') setOpenLogin(login.provider);
  }, [login, toast]);

  // 登录失败 → 等 CLI 状态刷新回来再弹安装指引。
  // 首屏（login 为 null）永远走不到这里，所以「第一次进设置页不自动弹窗」天然成立。
  useEffect(() => {
    if (login?.provider === 'gemini' && login.state === 'failed') pendingInstallRef.current = true;
  }, [login]);

  useEffect(() => {
    if (!pendingInstallRef.current) return;
    // present（找到了但版本号读不出来）也算可用：登录失败的真原因不该被「版本未知」挡住。
    if (isCliUsableState(cliState)) {
      pendingInstallRef.current = false;
      return;
    }
    if (cliState === 'unknown') return; // 探测还没落地，等下一次变化
    pendingInstallRef.current = false;
    setInstallOpen(true);
  }, [cliState]);

  const grouped = useMemo(() => ({
    chatgpt: sortAccounts(accounts.filter(item => item.provider === 'chatgpt'), now),
    gemini: sortAccounts(accounts.filter(item => item.provider === 'gemini'), now),
  }), [accounts, now]);

  const preferredOptions = accounts.map(item => ({ value: item.id, label: item.email || item.id }));

  // 「模型」页的订阅目录：模型数与登录态的真实来源。
  // 之所以读 providers 而不是 subscription:models —— 后者是订阅侧的内置常量，
  // 用户在这里看到的显示名称与增删模型都发生在 providers 侧。
  const [subscriptionCatalog, setSubscriptionCatalog] = useState(null);
  useEffect(() => {
    const bridge = desktop?.providers;
    if (!bridge?.list) {
      setSubscriptionCatalog([]);
      return undefined;
    }
    let alive = true;
    bridge.list()
      .then(result => {
        if (!alive) return;
        const providers = result?.ok ? result.value?.providers ?? [] : [];
        setSubscriptionCatalog(providers.filter(item => item.kind === 'subscription'));
      })
      .catch(() => { if (alive) setSubscriptionCatalog([]); });
    return () => { alive = false; };
    // accounts.length 变化 = 登录/退出过：模型数会跟着变，必须重读。
  }, [desktop, accounts.length]);

  const catalogRows = useMemo(() => ([
    { target: 'chatgpt', fallback: 'ChatGPT' },
    { target: 'gemini', fallback: 'Gemini' },
  ]).map(({ target, fallback }) => {
    const provider = (subscriptionCatalog ?? []).find(item => item.subscriptionProvider === target) ?? null;
    const count = provider ? provider.models.length : null;
    const signedIn = provider?.subscription?.accounts ?? 0;
    const note = !provider
      ? '正在读取模型目录…'
      : signedIn > 0
        ? `已登录 ${signedIn} 个账号${provider.subscription?.email ? ` · ${provider.subscription.email}` : ''}`
        : '还没有登录账号：登录后这一组模型才会出现在右下角的模型菜单里。';
    return { target, name: provider?.name ?? fallback, count, note };
  }), [subscriptionCatalog]);

  /** 「模型」页在同一个设置面板里，直接点它的导航项，不另造一条切换通道。 */
  function openModelsPage() {
    document.querySelector('[data-settings-item="models"]')?.click();
  }

  async function notify(result) {
    if (result?.message) toast(result.message, result.ok ? 'ok' : 'error');
    return result;
  }

  async function handleToggleLogin(provider) {
    if (openLogin === provider) {
      setOpenLogin('');
      await notify(await actions.cancelLogin(provider));
      return;
    }
    // 用户主动点「添加 Google 账号」时必须立刻解释为什么不行：直接开安装指引，
    // 不发一次注定失败的登录请求（那只会给一条错误 toast，说不清要做什么）。
    // 演示模式（没有 Electron 桥接）拿不到 CLI 状态，此时放行——否则界面审查时连 Gemini 登录态都看不到。
    if (provider === 'gemini' && source !== 'demo') {
      // 状态未知就先探一次：首屏那次探测现在不再阻塞 list()，所以刚打开页面时可能是
      // 'unknown'。凭「不知道」就弹安装指引会把装好 CLI 的用户也拦下来。
      let state = cliState;
      if (state === 'unknown') state = cliStateOf(await actions.recheckCli());
      if (!isCliUsableState(state)) {
        setInstallOpen(true);
        return;
      }
    }
    setOpenLogin(provider);
    const result = await actions.login(provider);
    if (!result.ok) toast(result.message, 'error');
  }

  async function handleRecheckCli() {
    const next = await actions.recheckCli();
    const state = cliStateOf(next);
    if (isCliUsableState(state)) {
      setInstallOpen(false);
      toast(state === 'present'
        ? '找到了 antigravity CLI（版本号读不出来），现在可以添加 Google 账号了'
        : 'CLI 已就绪，现在可以添加 Google 账号了', 'ok');
      return;
    }
    toast(state === 'outdated' ? 'CLI 版本仍然过旧，请先升级' : '还没有检测到 antigravity CLI', 'error');
  }

  async function handleInstallPickPath() {
    const result = await actions.pickCliPath();
    toast(result.message, result.ok ? 'ok' : 'error');
    if (result.ok) await actions.recheckCli();
  }

  async function handleCancelLogin(provider) {
    setOpenLogin('');
    await notify(await actions.cancelLogin(provider));
  }

  async function handleReopenLogin(provider) {
    const result = await actions.login(provider);
    if (!result.ok) toast(result.message, 'error');
  }

  /** 手动完成登录：浏览器打不开 127.0.0.1 的回调页时，把地址栏链接粘回来。 */
  async function handleCompleteLogin(url) {
    const result = await actions.completeLogin(url);
    toast(result.message, result.ok ? 'ok' : 'error');
    if (result.ok) setOpenLogin('');
  }

  async function handleRefresh(account) {
    toast('正在读取额度…');
    await notify(await actions.refresh(account?.id));
  }

  async function handleLogout() {
    if (!logoutTarget) return;
    const result = await actions.logout(logoutTarget.id);
    setLogoutTarget(null);
    toast(result.message, result.ok ? 'ok' : 'error');
  }

  // 切通道后立刻自检一次：改了但不可用是最难被发现的状态。
  async function handleChannelChange(value) {
    const saved = await actions.setSettings({ channel: value });
    if (!saved.ok) {
      toast(saved.message, 'error');
      return;
    }
    const tested = await actions.testChannel('chatgpt');
    toast(tested.ok ? `${saved.message}，${tested.message}` : tested.message, tested.ok ? 'ok' : 'error');
  }

  async function handleCliPath() {
    await notify(await actions.pickCliPath());
  }

  async function handleRetryLoad() {
    const result = await actions.refresh(null);
    if (!result.ok) toast(result.message, 'error');
  }

  async function handleSettings(patch) {
    await notify(await actions.setSettings(patch));
  }

  const sharedProps = {
    now,
    busy,
    menuFor,
    onOpenMenu: setMenuFor,
    onCloseMenu: () => setMenuFor(''),
    onRefresh: handleRefresh,
    onLogout: account => setLogoutTarget(account),
    login,
    onCancelLogin: handleCancelLogin,
    onReopenLogin: handleReopenLogin,
    onCompleteLogin: handleCompleteLogin,
  };

  return (
    <div className="settings-page cm-page" aria-busy={busy} data-source={source}>
      {error ? (
        <div className="cm-alert" role="alert">
          <Icon name="warn" />
          <span>{error.message}</span>
          <button type="button" className="settings-button" disabled={busy} onClick={handleRetryLoad}>重新读取</button>
        </div>
      ) : null}

      {/* ① ChatGPT 订阅 */}
      <section className="settings-section" aria-labelledby={`${uid}-chatgpt`}>
        <div className="settings-section-head">
          <h3 className="settings-section-title" id={`${uid}-chatgpt`}>ChatGPT 订阅</h3>
          <p className="settings-section-note">使用你自己 ChatGPT 账号的套餐额度，不走 API Key。多个账号按剩余额度轮换；额度用尽会自动切到下一个。</p>
        </div>
        <ProviderCard
          {...sharedProps}
          provider="chatgpt"
          accounts={grouped.chatgpt}
          loginOpen={openLogin === 'chatgpt'}
          onToggleLogin={() => { void handleToggleLogin('chatgpt'); }}
        />
      </section>

      {/* ② Gemini 订阅 */}
      <section className="settings-section" aria-labelledby={`${uid}-gemini`}>
        <div className="settings-section-head">
          <h3 className="settings-section-title" id={`${uid}-gemini`}>Gemini 订阅</h3>
          <p className="settings-section-note">由本机 antigravity CLI 执行，Mova 负责渲染与审批。额度按 5 小时窗口与每周窗口计算，与 ChatGPT 订阅各自独立、互不共享。</p>
        </div>
        <ProviderCard
          {...sharedProps}
          provider="gemini"
          accounts={grouped.gemini}
          loginOpen={openLogin === 'gemini'}
          onToggleLogin={() => { void handleToggleLogin('gemini'); }}
          cli={cli}
          cliState={cliState}
          onShowInstall={() => setInstallOpen(true)}
        />
      </section>

      {/* ③ 额度调度 */}
      <section className="settings-section" aria-labelledby={`${uid}-scheduling`}>
        <div className="settings-section-head">
          <h3 className="settings-section-title" id={`${uid}-scheduling`}>额度调度</h3>
          <p className="settings-section-note">所有切换都发生在发请求之前：额度不足的账号不会被选中，也不会把请求发出去再失败。</p>
        </div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>额度用尽时自动切换账号</strong>
              <p>命中额度上限时自动改用下一个有额度的账号，并在时间线里标注「已切换」。</p>
            </div>
            <CmSwitch
              label="额度用尽时自动切换账号"
              checked={settings.autoSwitch !== false}
              disabled={busy}
              onChange={value => { void handleSettings({ autoSwitch: value }); }}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>优先账号</strong>
              <p>轮换始终从这里开始；被标记额度用尽的账号会临时跳过。</p>
            </div>
            <CmSelect
              ariaLabel="优先账号"
              value={settings.preferredAccountId}
              options={preferredOptions}
              fallbackLabel="按剩余额度自动"
              disabled={busy || preferredOptions.length === 0}
              onChange={value => { void actions.select(value).then(notify); }}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>剩余额度低于 10% 时提醒</strong>
              <p>在下一次发消息前提示一次，不打断正在进行的任务。</p>
            </div>
            <CmSwitch
              label="剩余额度低于 10% 时提醒"
              checked={settings.remindBelowPercent === 10}
              disabled={busy}
              onChange={value => { void handleSettings({ remindBelowPercent: value ? 10 : null }); }}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>额度刷新间隔</strong>
              <p>空闲时按此间隔读取额度；发送前一定重新校验一次。</p>
            </div>
            <CmSelect
              ariaLabel="额度刷新间隔"
              value={settings.refreshIntervalMins}
              options={REFRESH_OPTIONS}
              fallbackLabel={refreshIntervalLabel(settings.refreshIntervalMins)}
              disabled={busy}
              onChange={value => { void handleSettings({ refreshIntervalMins: value }); }}
            />
          </div>
        </div>
      </section>

      {/* ④ 会话模型：真正的选择在右下角的模型菜单，这里只汇总每个通道配好了没有。
             以前这里有 chatgptModel / geminiModel / thinkingEffort / imageInput 四个控件，
             但主进程里没有任何代码读它们（只有 settingsSet 把它们存回去），改了也不生效。
             模型能力与档位现在跟着「模型」页的目录走，所以这里改成只读汇总 + 一个入口。 */}
      <section className="settings-section" aria-labelledby={`${uid}-models`}>
        <div className="settings-section-head">
          <h3 className="settings-section-title" id={`${uid}-models`}>会话模型</h3>
          <p className="settings-section-note">用哪个模型在输入框右下角的模型菜单里选；显示名称、思考强度、上下文窗口在「模型」页配置。这里只汇总每个订阅通道现在能不能用。</p>
        </div>
        <div className="settings-card">
          {catalogRows.map(row => (
            <div className="settings-row" key={row.target}>
              <div className="settings-row-text">
                <strong>{row.name}</strong>
                <p>{row.note}</p>
              </div>
              <span className="cm-note-right">{row.count === null ? '读取中…' : `${row.count} 个模型`}</span>
            </div>
          ))}
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>模型目录</strong>
              <p>可以改显示名称、增删模型、勾选思考强度与上下文窗口；保存后下一次请求生效。</p>
            </div>
            <button type="button" className="settings-button" onClick={openModelsPage}>打开「模型」</button>
          </div>
        </div>
      </section>

      {/* ⑤ 运行方式 */}
      <section className="settings-section" aria-labelledby={`${uid}-runtime`}>
        <div className="settings-section-head">
          <h3 className="settings-section-title" id={`${uid}-runtime`}>运行方式</h3>
          <p className="settings-section-note">ChatGPT 由 Mova 直接发请求；Gemini 交给本机 CLI，Mova 只保留渲染与审批。</p>
        </div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>ChatGPT 通道</strong>
              <p>Responses 接口，令牌由本机加密保存，过期前自动续期。</p>
            </div>
            <CmSelect
              ariaLabel="ChatGPT 通道"
              value={settings.channel}
              options={CHANNEL_OPTIONS}
              disabled={busy}
              onChange={value => { void handleChannelChange(value); }}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>Gemini 执行器</strong>
              <p>后台 CLI（ACP）：思考、计划、工具与审批请求都会回到 Mova 的时间线与审批条。</p>
            </div>
            <CmSelect
              ariaLabel="Gemini 执行器"
              value={settings.geminiRunner}
              options={RUNNER_OPTIONS}
              disabled={busy}
              onChange={value => { void handleSettings({ geminiRunner: value }); }}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>CLI 路径</strong>
              <p>找不到时会在 PATH 中搜索 agy；修改后立即用于下一次会话。</p>
            </div>
            <div className="settings-inline-control">
              <span className="settings-path" title={settings.cliPath || '未检测到 antigravity CLI'}>
                {settings.cliPath || '未检测到 antigravity CLI'}
              </span>
              <button type="button" className="settings-button" disabled={busy} onClick={() => { void handleCliPath(); }}>更改</button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <strong>凭据存储</strong>
              <p>refresh token 由系统钥匙串加密；应用内不写入明文，日志与错误信息不含令牌。</p>
            </div>
            <span className="cm-note-right">{settings.credentialStorage || '未检测到可用存储'}</span>
          </div>
        </div>
      </section>

      {/* ⑥ 合规横幅 */}
      <section className="settings-section" aria-labelledby={`${uid}-compliance`}>
        <h3 className="settings-section-title cm-visually-hidden" id={`${uid}-compliance`}>使用限制</h3>
        <div className="cm-banner">
          <Icon name="warn" />
          <div>
            <strong>订阅额度仅限本人在本设备使用</strong>
            <p>这些额度来自你个人账号的套餐，不是 API 计费额度。不要共享账号或把额度转给其他人使用。</p>
          </div>
        </div>
      </section>

      <CmDialog
        open={Boolean(logoutTarget)}
        title="退出这个账号？"
        body="退出后该账号的额度不再参与轮换，已保存的令牌会被撤销，该账号在其它设备上的 Mova 也会失效。你可以随时重新登录，额度不受影响。"
        detail={logoutTarget ? (logoutTarget.email || logoutTarget.id) : ''}
        confirmLabel="退出登录"
        tone="danger"
        busy={busy}
        onConfirm={() => { void handleLogout(); }}
        onCancel={() => setLogoutTarget(null)}
      />

      <CliInstallDialog
        open={installOpen}
        status={cli}
        platform={platform}
        onClose={() => setInstallOpen(false)}
        onRecheck={() => { void handleRecheckCli(); }}
        onPickPath={() => { void handleInstallPickPath(); }}
      />

      <CmToastStack items={toasts} onDismiss={dismiss} />
    </div>
  );
}

export default CliModelsSettings;
