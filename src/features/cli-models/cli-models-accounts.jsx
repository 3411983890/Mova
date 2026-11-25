/**
 * CLI 模型设置页里的「账号卡片」部分。
 *
 * 负责：账号行（圆点 + 邮箱 + plan + 状态徽章 + 「…」菜单）、额度块、登录面板、
 * 以及按 provider 组合出来的整张卡片（账号 + 添加按钮 + 登录面板）。
 * 不负责：取数据（use-subscription）、发命令（cli-models-settings）、纯文案换算
 * （cli-models-view）。组件只通过 props 回调把动作交回页面。
 *
 * 被谁调用：src/features/cli-models/cli-models-settings.jsx
 */
import React, { useRef, useState } from 'react';
import {
  accountBadge, accountDot, accountState,
  formatLastUsed, formatRecoverIn, formatResetIn,
  loginHeadline, loginStatusText,
  quotaPercent, quotaRemaining, quotaTone, quotaValueText, quotaWidth,
  sortUsageWindows, usageReasonText,
} from './cli-models-view.js';
import { CmPopup, Icon } from './cli-models-parts.jsx';
import { formatCliVersion } from './install-cli-prompt.mjs';

const LOGIN_DETAIL = Object.freeze({
  chatgpt: '已在系统浏览器打开 OpenAI 授权页。完成授权后回到 Mova，不需要复制任何内容。授权链接 5 分钟内有效。',
  // Gemini 不再开浏览器：登录态就是本机 CLI 自己的那份，Mova 只是读它。
  // 说「已在浏览器打开」会让用户干等一个永远不会出现的窗口。
  gemini: '正在读取本机 antigravity CLI 的登录态：能列出模型就说明已经授权，不需要在这里做任何操作。',
});

/** 账号行的副标题：不同状态说不同的话，避免把「用尽/过期」只藏在徽章里。 */
function accountMetaItems(account, now) {
  const state = accountState(account, now);
  if (state === 'expired' || state === 'error') return ['登录已过期', '需要重新登录'];
  if (state === 'limited') return [formatRecoverIn(account, now), '已自动暂停调用'];
  if (account.provider === 'gemini') {
    const cli = account.cli;
    return [
      `workspace: ${account.workspace || 'default'}`,
      cli?.ready ? `CLI 已就绪 · v${cli.version || '—'}` : 'CLI 未就绪',
    ];
  }
  return [formatLastUsed(account.lastUsedAt), account.usage ? '凭据已加密存储' : '还没有读取额度'];
}

/** 额度块：每个窗口一行文案 + 6px pill 进度条；读不到额度时只给原因，不画假进度条。 */
function QuotaBlock({ account, now, busy, onRefresh }) {
  const usage = account.usage;
  if (!usage || usage.reason || !Array.isArray(usage.windows) || usage.windows.length === 0) {
    const reason = usage?.reason ? usageReasonText(usage.reason, usage.detail) : '还没有读取到额度。';
    return (
      <div className="cm-quota">
        <p className="cm-quota-empty">
          {reason}
          <button type="button" className="cm-link" disabled={busy} onClick={() => onRefresh(account)}>立即读取</button>
        </p>
      </div>
    );
  }
  const limited = accountState(account, now) === 'limited';
  return (
    <div className="cm-quota">
      {sortUsageWindows(usage.windows).map(window => {
        // 三个辅助函数一律吃**原始 usedPercent**：先 quotaPercent 取整会把 null 抹成 0，
        // 于是「额度未知」会被画成满条（最坏的误导）。
        const remaining = quotaRemaining(window.usedPercent);
        const tone = quotaTone(window.usedPercent, { limited });
        return (
          <div className="cm-quota-window" key={window.id || window.label}>
            <div className="cm-quota-line">
              <span className="cm-quota-label">{window.label}</span>
              <span className="cm-quota-value">{quotaValueText(window.usedPercent)}</span>
              <span className="cm-quota-reset">{formatResetIn(window.resetsAt, now)}</span>
            </div>
            <div
              className="cm-track"
              data-tone={tone}
              role="progressbar"
              aria-label={`${window.label} 剩余 ${remaining === null ? '未知' : `${remaining}%`}`}
              aria-valuenow={remaining ?? 0}
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span style={{ width: `${quotaWidth(window.usedPercent)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 单条账号：整行不是按钮（避免与「…」菜单抢点击），只有菜单是交互元素。 */
export function AccountRow({ account, now, busy, menuOpen, onOpenMenu, onCloseMenu, onRefresh, onLogout }) {
  const badge = accountBadge(account, now);
  const meta = accountMetaItems(account, now);
  const menuRef = useRef(null);

  return (
    <div className={`cm-account${account.active ? ' is-current' : ''}`} data-account={account.id}>
      <div className="cm-account-row">
        <span className={`cm-dot ${accountDot(account, now)}`} aria-hidden="true" />
        <div className="cm-account-main">
          <div className="cm-account-title">
            <span className="cm-account-email" title={account.email || '未命名账号'}>{account.email || '未命名账号'}</span>
            {account.plan ? <span className="cm-badge">{account.plan}</span> : null}
            <span className="cm-pill" data-tone={badge.tone}>{badge.text}</span>
            {account.active ? <span className="cm-pill" data-tone="muted">当前使用</span> : null}
          </div>
          <div className="cm-account-meta">
            {meta.map((item, index) => (
              <React.Fragment key={`${account.id}-${index}`}>
                {index > 0 ? <span className="cm-sep" aria-hidden="true" /> : null}
                <span>{item}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="cm-account-actions">
          <button
            ref={menuRef}
            type="button"
            className="cm-icon-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${account.email || '账号'} 的更多操作`}
            title="更多操作"
            onMouseDown={event => event.stopPropagation()}
            onClick={() => (menuOpen ? onCloseMenu() : onOpenMenu())}
          >
            <Icon name="more" />
          </button>
          <CmPopup open={menuOpen} anchorRef={menuRef} onClose={onCloseMenu} ariaLabel={`${account.email || '账号'} 的操作`}>
            <button
              type="button"
              role="menuitem"
              className="cm-menu-item"
              disabled={busy}
              onClick={() => { onCloseMenu(); onRefresh(account); }}
            >
              <Icon name="refresh" /><span className="cm-menu-label">刷新额度</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="cm-menu-item is-danger"
              onClick={() => { onCloseMenu(); onLogout(account); }}
            >
              <Icon name="logout" /><span className="cm-menu-label">退出登录</span>
            </button>
          </CmPopup>
        </div>
      </div>
      <QuotaBlock account={account} now={now} busy={busy} onRefresh={onRefresh} />
    </div>
  );
}

/** 登录面板：状态文字靠左、按钮靠右；成功后面板由页面收起。 */
export function LoginPanel({ id, provider, login, busy, onCancel, onReopen, onComplete }) {
  const state = login && login.provider === provider ? login.state : 'waiting';
  const failed = state === 'failed';
  const dot = failed ? 'is-warn' : state === 'authorized' ? 'is-on' : 'is-pending';
  const detail = failed
    ? (login?.message || '授权被拒绝，请重新发起登录。')
    : LOGIN_DETAIL[provider] ?? LOGIN_DETAIL.chatgpt;
  // 浏览器有可能根本到不了 127.0.0.1：系统代理把回环也转发出去、VPN 接管路由、
  // 或者防火墙拦了随机端口。这时地址栏里那条回调链接仍然带着 code 与 state，
  // 让用户粘回来就能完成——不给这条路，用户只能卡在「拒绝连接」。
  const [manualOpen, setManualOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const manualReady = manualUrl.trim().length > 0 && !busy;
  return (
    <div className="cm-login-panel" id={id}>
      <div className="cm-login-state">
        <span className={`cm-dot ${dot}`} aria-hidden="true" />
        <div>
          <strong>{loginHeadline(state, provider)}</strong>
          <p>{detail}</p>
        </div>
      </div>
      <div className="cm-login-actions">
        <span className="cm-login-status" role="status" data-tone={failed ? 'error' : undefined}>
          {failed ? '授权没有完成，可以重试或换一个账号' : loginStatusText(state, provider)}
        </span>
        <button type="button" className="settings-button primary" disabled={busy || state === 'verifying'} onClick={onReopen}>
          {failed ? '重试登录' : '重新打开授权页'}
        </button>
        <button type="button" className="settings-button" disabled={busy} onClick={onCancel}>取消登录</button>
      </div>
      <div className="cm-login-manual">
        <button
          type="button"
          className="cm-link"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen(open => !open)}
        >
          {manualOpen ? '收起' : '浏览器显示「拒绝连接」？手动完成'}
        </button>
        {manualOpen ? (
          <div className="cm-login-manual-body">
            <p>
              授权后浏览器会跳到 <code>127.0.0.1</code> 上的回调地址。如果那一页打不开，
              把<b>地址栏里的整条链接</b>复制到这里即可（同样会校验 state，安全性不变）。
            </p>
            <div className="cm-login-manual-row">
              <input
                type="url"
                className="cm-install-input"
                placeholder="http://127.0.0.1:端口/auth/callback?code=...&state=..."
                value={manualUrl}
                spellCheck={false}
                onChange={event => setManualUrl(event.target.value)}
                aria-label="回调链接"
              />
              <button
                type="button"
                className="settings-button primary"
                disabled={!manualReady}
                onClick={() => onComplete?.(manualUrl)}
              >
                完成登录
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** CLI 状态 → 圆点样式（与账号行同一套 is-on / is-warn / is-danger / is-unknown）。 */
const CLI_DOT = Object.freeze({
  ready: 'is-on', present: 'is-on', outdated: 'is-warn', missing: 'is-danger', unknown: 'is-unknown', checking: 'is-pending',
});

/**
 * Gemini 卡片顶部那行 CLI 状态。
 *
 * 只负责「说清现在能不能用」，不负责要不要弹窗：首屏**不自动弹**，
 * 用户点「查看安装指引」或点「添加 Google 账号」时由页面开弹窗。
 */
export function CliStatusRow({ state = 'unknown', cli, disabled, onShowInstall }) {
  const version = formatCliVersion(cli?.version);
  // 首屏 list() 还没回来（或演示模式没有桥接）时 cli 为 null：
  // 这时说「正在检测」比说「未安装」诚实，也不会先吓用户一跳。
  const checking = !cli;
  const tone = checking ? 'checking' : state;
  const text = checking
    ? '正在检测 CLI…'
    : state === 'ready'
      ? `CLI 已就绪${version ? ` · v${version}` : ''}`
      : state === 'present'
        // 找到了二进制但版本号读不出来：如实说，并且不再劝用户「装一下」。
        ? 'CLI 已找到（版本号读不出来）'
        : state === 'outdated'
          ? `CLI 版本过旧${version ? `（v${version}）` : ''}`
          : state === 'missing'
            ? 'CLI 未安装'
            : 'CLI 状态未知';
  return (
    <div className="cm-install-row" data-state={tone}>
      <span className={`cm-dot ${CLI_DOT[tone] ?? CLI_DOT.unknown}`} aria-hidden="true" />
      <span className="cm-install-row-text">{text}</span>
      {state === 'ready' || state === 'present' || checking ? null : (
        <button type="button" className="cm-link" disabled={disabled} onClick={onShowInstall}>查看安装指引</button>
      )}
    </div>
  );
}

/**
 * 一个 provider 的整张卡片：账号行列表 + 整宽「添加账号」+ 展开式登录面板。
 * 没有账号时换成虚线空态卡片（同一个主操作，不出现两个添加入口）。
 */
export function ProviderCard({
  provider, accounts, now, busy, menuFor,
  onOpenMenu, onCloseMenu, onRefresh, onLogout,
  loginOpen, onToggleLogin, login, onCancelLogin, onReopenLogin, onCompleteLogin,
  cliState, cli, onShowInstall,
}) {
  const empty = accounts.length === 0;
  const addLabel = provider === 'chatgpt' ? '添加 ChatGPT 账号' : '添加 Google 账号';
  return (
    <div className={`settings-card${empty ? ' cm-empty-card' : ''}`}>
      {provider === 'gemini' ? (
        <CliStatusRow state={cliState} cli={cli} disabled={busy} onShowInstall={onShowInstall} />
      ) : null}
      {accounts.map(account => (
        <AccountRow
          key={account.id}
          account={account}
          now={now}
          busy={busy}
          menuOpen={menuFor === account.id}
          onOpenMenu={() => onOpenMenu(account.id)}
          onCloseMenu={onCloseMenu}
          onRefresh={onRefresh}
          onLogout={onLogout}
        />
      ))}
      {empty ? (
        <div className="cm-empty">
          <p className="cm-empty-title">还没有添加账号</p>
          <p className="cm-empty-note">
            {provider === 'chatgpt'
              ? '添加后这里会显示账号、套餐与剩余额度；额度读不到时会标成「未检测」，不会假装成可用。'
              : '添加后这里会显示 Google 账号、workspace 与 CLI 版本。Gemini 额度与 ChatGPT 订阅各自独立，不共享额度池。'}
          </p>
          <button
            type="button"
            className="settings-button primary"
            aria-expanded={loginOpen}
            aria-controls={`cm-login-${provider}`}
            onClick={onToggleLogin}
          >
            {addLabel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="settings-add"
          aria-expanded={loginOpen}
          aria-controls={`cm-login-${provider}`}
          onClick={onToggleLogin}
        >
          <Icon name="plus" />{addLabel}
        </button>
      )}
      {loginOpen ? (
        <LoginPanel
          id={`cm-login-${provider}`}
          provider={provider}
          login={login}
          busy={busy}
          onCancel={onCancelLogin}
          onReopen={onReopenLogin}
          onComplete={onCompleteLogin}
        />
      ) : null}
    </div>
  );
}

export default ProviderCard;
