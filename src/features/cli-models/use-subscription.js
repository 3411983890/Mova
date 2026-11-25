/**
 * CLI 模型（订阅额度）数据钩子。
 *
 * 负责：把 desktop.subscription 的 IPC 调用与事件推送收敛成一个 React 状态机
 * （accounts / settings / models / login / busy / error），并在没有 Electron 桥接时
 * 退回 cli-models-demo.js 的演示数据，让页面仍然可看、可点。
 * 不负责：展示文案（cli-models-view.js）、样式（cli-models-settings.css）、
 * 演示数据本身（cli-models-demo.js）。
 *
 * 通道名、状态值、错误文案全部来自 electron/subscription/contract.mjs，
 * 本文件不重复写这些字面量（预加载脚本的桥接形状见文件末尾注释）。
 *
 * 被谁调用：src/features/cli-models/cli-models-settings.jsx
 *
 * @see Mova-CLI模型-开发文档.md §5.2 §5.3 §5.4 §18.2
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCOUNT_STATES, CHANNELS, ERROR_TEXT, PROVIDERS, USAGE_REASONS, toErrorCode,
} from '../../../electron/subscription/contract.mjs';
import { DEFAULT_MODELS, DEFAULT_SETTINGS, demoAccount, demoSnapshot } from './cli-models-demo.js';
import { cliStateOf } from './install-cli-prompt.mjs';

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * 给一个 promise 套上「最多等多久」。
 *
 * 为什么必须有：IPC 是 `invoke`，主进程不回就永远 pending。设置页的首屏读取用一个
 * pending 同时驱动 busy（全页控件 disabled），所以只要有一路 IPC 不回，页面就永久
 * 「卡住」且看不出原因。宁可超时报错也不能把界面锁死。
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} 超时`), { code: 'request', timedOut: true }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function codeOf(error) {
  if (typeof error === 'string' && error in ERROR_TEXT) return error;
  return toErrorCode(error);
}

function messageOf(error) {
  if (typeof error === 'string') return ERROR_TEXT[error] ?? ERROR_TEXT.request;
  const code = codeOf(error);
  if (code !== 'request' || (error && typeof error.code === 'string')) return ERROR_TEXT[code] ?? ERROR_TEXT.request;
  return (error && typeof error.message === 'string' && error.message) || ERROR_TEXT.request;
}

/** 桥接返回 { ok, value } | { ok:false, error }；也接受裸值，兼容未来简化过的实现。 */
function unwrap(result) {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (!result.ok) throw Object.assign(new Error(messageOf(result.error)), { code: codeOf(result.error) });
    return result.value;
  }
  return result;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    checkedAt: Number.isFinite(raw.checkedAt) ? raw.checkedAt : undefined,
    stale: raw.stale === true,
    reason: USAGE_REASONS.includes(raw.reason) ? raw.reason : undefined,
    // detail 是探针给的细分原因（http_401 / network / no_token…），只用来挑更准确的一句话，
    // 不含任何上游响应体。丢掉它会让「401」和「连不上」显示成同一句「读取额度失败」。
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    windows: Array.isArray(raw.windows)
      ? raw.windows
        .filter(window => window && typeof window === 'object')
        .map(window => ({
          id: String(window.id ?? ''),
          label: String(window.label ?? '额度窗口'),
          usedPercent: Number.isFinite(Number(window.usedPercent)) ? Number(window.usedPercent) : 0,
          resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : undefined,
        }))
      : [],
  };
}

/** 只保留 UI 用得到的字段：令牌类字段永远不会进渲染层。 */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = PROVIDERS.includes(raw.provider) ? raw.provider : 'chatgpt';
  const email = typeof raw.email === 'string' ? raw.email : '';
  return {
    id: String(raw.id ?? `${provider}:${email}`),
    provider,
    email,
    plan: typeof raw.plan === 'string' ? raw.plan : '',
    state: ACCOUNT_STATES.includes(raw.state) ? raw.state : 'error',
    limitedUntil: Number.isFinite(raw.limitedUntil) ? raw.limitedUntil : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    active: raw.active === true,
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : undefined,
    workspace: typeof raw.workspace === 'string' ? raw.workspace : undefined,
    cli: raw.cli && typeof raw.cli === 'object'
      ? { ready: raw.cli.ready === true, version: typeof raw.cli.version === 'string' ? raw.cli.version : undefined }
      : undefined,
    usage: normalizeUsage(raw.usage),
  };
}

function normalizeModels(raw) {
  const catalog = (list, fallback) => (Array.isArray(list) && list.length
    ? list
      .filter(item => item && typeof item === 'object' && item.id)
      .map(item => ({
        id: String(item.id),
        label: String(item.label ?? item.id),
        note: typeof item.note === 'string' ? item.note : '',
      }))
    : fallback);
  return {
    chatgpt: catalog(raw?.chatgpt, DEFAULT_MODELS.chatgpt),
    gemini: catalog(raw?.gemini, DEFAULT_MODELS.gemini),
  };
}

/** 版本可能读不出来（found:true, version:null），这里保留 null，交给上层说「未知」。
 *  字段名以 electron/subscription/cli.mjs 的 `{major, minor, patch}` 为准；
 *  老实现写的是 `step`，两种都认，避免「CLI 已就绪」后面永远跟一个 `v—`。 */
function normalizeCliVersion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parts = [raw.major, raw.minor, raw.patch ?? raw.step].map(part => Number(part));
  if (!parts.every(part => Number.isFinite(part))) return null;
  return { major: parts[0], minor: parts[1], step: parts[2] };
}

/**
 * CLI 探测结果（详见 electron/subscription/cli.mjs）。
 *
 * compatible 刻意不补默认值：undefined 表示「没探测到兼容性」，
 * 如果强行写成 false，cliStateOf 会把未知状态误报成「版本过旧」。
 */
function normalizeCli(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    found: raw.found === true,
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args: Array.isArray(raw.args) ? raw.args.filter(arg => typeof arg === 'string') : undefined,
    version: normalizeCliVersion(raw.version),
    compatible: typeof raw.compatible === 'boolean' ? raw.compatible : undefined,
    source: raw.source === 'settings' || raw.source === 'auto' ? raw.source : undefined,
    code: raw.code === 'cli_missing' ? 'cli_missing' : undefined,
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    // 命中的文件路径：CLI 与「桌面程序」容易搞混，界面要能说出它看到的是哪一个。
    foundPath: typeof raw.foundPath === 'string' ? raw.foundPath : undefined,
    tried: Array.isArray(raw.tried) ? raw.tried.filter(item => typeof item === 'string') : undefined,
  };
}

function normalizeSnapshot(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    accounts: Array.isArray(source.accounts) ? source.accounts.map(normalizeAccount).filter(Boolean) : [],
    settings: { ...DEFAULT_SETTINGS, ...(source.settings && typeof source.settings === 'object' ? source.settings : {}) },
    models: normalizeModels(source.models),
    cli: normalizeCli(source.cli),
  };
}

/**
 * @param {{ subscription?: Record<string, Function> } | null | undefined} desktop window.movaDesktop
 */
export function useSubscription(desktop) {
  const bridge = desktop?.subscription ?? null;
  const ipc = Boolean(bridge && typeof bridge.list === 'function');
  const [data, setData] = useState(() => (ipc
    ? { accounts: [], settings: { ...DEFAULT_SETTINGS }, models: DEFAULT_MODELS }
    : demoSnapshot(Date.now())));
  const [pending, setPending] = useState(ipc ? 'load' : '');
  const [error, setError] = useState(null);
  const [login, setLogin] = useState(null);
  // CLI 探测结果单独放一份：登录失败要把「没装 / 版本过旧」立刻摊到页面上，
  // 塞进 data 里会和 accounts 的刷新节奏绑在一起，容易漏掉一次更新。
  const [cli, setCli] = useState(null);
  const cliRef = useRef(cli);
  cliRef.current = cli;
  const busyRef = useRef(false);
  const loginToken = useRef(0);
  const dataRef = useRef(data);
  dataRef.current = data;

  /** 调一个桥接方法：方法缺失时抛可读错误，而不是 TypeError。 */
  const call = useCallback(async (method, payload) => {
    const fn = bridge?.[method];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error(ERROR_TEXT.not_configured), { code: 'not_configured' });
    }
    return unwrap(await fn(payload));
  }, [bridge]);

  const reload = useCallback(async () => {
    if (!ipc) return;
    // 12s 上限：`list` 里带着 CLI 探测（主进程已加缓存与 3.5s 硬超时），正常情况下 1s 内。
    const snapshot = normalizeSnapshot(await withTimeout(call('list'), 12_000, '读取账号列表'));
    setData(snapshot);
    // 首屏靠 list() 自带 cli，不必再发一次 cliStatus：多一次 IPC 就多一次闪。
    if (snapshot.cli) setCli(snapshot.cli);
  }, [ipc, call]);

  useEffect(() => {
    if (!ipc) return undefined;
    let alive = true;
    setPending('load');
    reload()
      .then(() => { if (alive) setError(null); })
      .catch(reason => {
        if (!alive) return;
        setError({
          code: codeOf(reason),
          message: reason?.timedOut
            ? '读取账号列表超时：主进程 12 秒没有回应。点「重新读取」再试一次。'
            : messageOf(reason),
        });
      })
      .finally(() => { if (alive) setPending(''); });
    return () => { alive = false; };
  }, [ipc, reload]);

  // 登录态 / 额度更新 / 切号：主进程推一条事件，这里只做「重新拉一遍 + 更新登录面板」。
  useEffect(() => {
    if (!ipc || typeof bridge?.onEvent !== 'function') return undefined;
    const off = bridge.onEvent(payload => {
      const event = payload && typeof payload === 'object' ? payload : {};
      if (event.kind === 'login') {
        setLogin(previous => ({
          provider: event.provider ?? previous?.provider ?? 'chatgpt',
          state: event.state ?? previous?.state ?? 'waiting',
          message: typeof event.message === 'string' ? event.message : '',
          flowId: event.flowId ?? previous?.flowId,
          account: normalizeAccount(event.account) ?? previous?.account ?? null,
        }));
        return;
      }
      void reload().catch(reason => setError({ code: codeOf(reason), message: messageOf(reason) }));
    });
    return typeof off === 'function' ? off : undefined;
  }, [bridge, ipc, reload]);

  /**
   * 所有「会改数据」的操作都走这里：统一 loading / 返回可 toast 的文案。
   * 失败只回给调用方（右下角 toast），不写页面级 error —— 页面顶部那条只留给「读不出账号列表」。
   */
  async function run(key, operation) {
    if (busyRef.current) return { ok: false, message: '上一个操作还没有完成，请稍候。' };
    busyRef.current = true;
    setPending(key);
    try {
      // 60s 上限：`run` 的 busyRef 是一把全局锁，任何一路 IPC 不回就会把整页控件锁死。
      // 宁可报超时，也不能让「保存/刷新」按钮变成永远点不动。
      //
      // 为什么不是 30s：Gemini 的额度探针要真的跑一次本机 CLI 去问上游，走代理池时实测
      // 8.4s / 15.5s / 41.7s（主进程侧的预算是 45s）。30s 会在最慢那一档先把界面判成超时，
      // 于是「探针还在跑、界面说超时」，用户看到的就是「额度刷新失败」。
      const message = await withTimeout(Promise.resolve().then(operation), 60_000, '这个操作');
      setError(null);
      return { ok: true, message: message ?? '' };
    } catch (reason) {
      return { ok: false, message: reason?.timedOut ? '操作超时：主进程 60 秒没有回应，请重试。' : messageOf(reason) };
    } finally {
      busyRef.current = false;
      setPending('');
    }
  }

  async function patchSettings(patch) {
    if (ipc) {
      const value = await call('settingsSet', patch);
      const next = value && typeof value === 'object' && 'autoSwitch' in value ? value : null;
      setData(previous => ({ ...previous, settings: { ...previous.settings, ...(next ?? patch) } }));
      return;
    }
    await wait(160);
    setData(previous => ({ ...previous, settings: { ...previous.settings, ...patch } }));
  }

  async function setSettings(patch) {
    return run('settings', async () => {
      await patchSettings(patch);
      return '设置已保存';
    });
  }

  async function select(accountId) {
    return run(`select:${accountId}`, async () => {
      const account = dataRef.current.accounts.find(item => item.id === accountId);
      await patchSettings({ preferredAccountId: accountId });
      return `已把 ${account?.email || accountId} 设为优先账号`;
    });
  }

  async function refresh(accountId) {
    return run(`refresh:${accountId ?? 'all'}`, async () => {
      const account = dataRef.current.accounts.find(item => item.id === accountId);
      if (ipc) {
        await call('refresh', { accountId: accountId ?? null });
        await reload();
      } else {
        await wait(700);
        setData(previous => ({
          ...previous,
          accounts: previous.accounts.map(item => (item.id === accountId
            ? { ...item, usage: item.usage ? { ...item.usage, checkedAt: Date.now(), stale: false } : item.usage }
            : item)),
        }));
      }
      return accountId ? `${account?.email || accountId} 额度已更新` : '全部账号额度已更新';
    });
  }

  /**
   * 发起登录。演示模式 2.6 秒后自动成功（与原型节奏一致）；真实模式等主进程回 flowId，
   * 成功与否再由 subscription:event 推过来。这里不走 run()，否则整个页面会被禁用 2.6 秒。
   */
  async function loginAccount(provider) {
    loginToken.current += 1;
    const token = loginToken.current;
    setLogin({ provider, state: 'waiting', message: '' });
    if (ipc) {
      try {
        // 只等一个「已受理」的确认。Gemini 那一路的 IPC 要等用户在浏览器里真的授权完才
        // return（可能是几分钟），直接 await 会把这条链路挂住：面板看起来卡在「等待授权」，
        // 也拿不到 flowId 去取消。超时不算失败，后续状态由 subscription:event 推进。
        const flow = await withTimeout(call('login', { provider }), 4_500, '发起登录')
          .catch(reason => { if (reason?.timedOut) return null; throw reason; });
        if (flow === null) {
          return { ok: true, message: provider === 'gemini' ? '已启动 CLI 登录，请在浏览器里完成 Google 授权' : '' };
        }
        if (token === loginToken.current) {
          setLogin({
            provider,
            state: flow?.state === 'authorized' ? 'authorized' : 'waiting',
            flowId: flow?.flowId,
            message: '',
            account: normalizeAccount(flow?.account),
          });
        }
        return { ok: true, message: '' };
      } catch (reason) {
        const message = messageOf(reason);
        if (token === loginToken.current) setLogin({ provider, state: 'failed', message });
        // Gemini 登录失败最常见的原因是 CLI 没装 / 版本过旧：顺手把 CLI 状态刷新一次，
        // 让页面拿到新的 cliState 后自己决定弹不弹安装指引（弹窗开关留在组件层）。
        const code = codeOf(reason);
        if (provider === 'gemini' && (code === 'cli_missing' || code === 'cli_incompatible')) {
          void recheckCli();
        }
        return { ok: false, message };
      }
    }
    await wait(2600);
    if (token !== loginToken.current) return { ok: false, message: '已取消登录' };
    const account = demoAccount(provider, Date.now());
    setData(previous => ({ ...previous, accounts: [...previous.accounts, account] }));
    setLogin({ provider, state: 'authorized', message: '', account });
    return { ok: true, message: '' };
  }

  async function cancelLogin(provider) {
    loginToken.current += 1;
    if (ipc) {
      try {
        await withTimeout(call('cancelLogin', { provider, flowId: login?.flowId }), 5_000, '取消登录');
      } catch {
        // 取消接口失败也要让界面收起：面板留着比误报更糟。
      }
    }
    setLogin({ provider, state: 'cancelled', message: '' });
    return { ok: true, message: '已取消登录' };
  }

  /**
   * 手动完成登录：浏览器到不了 127.0.0.1（系统代理转发回环 / VPN 接管路由 / 防火墙拦随机端口）时，
   * 把地址栏里那条回调链接整条粘回来即可。主进程会照常校验 state，安全性不降级。
   */
  async function completeLogin(url) {
    const provider = login?.provider ?? 'chatgpt';
    return run('login:complete', async () => {
      if (!ipc) throw Object.assign(new Error('演示模式不支持粘贴完成登录'), { code: 'request' });
      try {
        const value = await call('completeLogin', { provider, flowId: login?.flowId, url: String(url ?? '').trim() });
        await reload();
        const email = typeof value?.email === 'string' ? value.email : '';
        return email ? `已连接 ${email}` : '已连接账号';
      } catch (reason) {
        setLogin({ provider, state: 'failed', message: messageOf(reason), flowId: login?.flowId });
        throw reason;
      }
    });
  }

  async function logout(accountId) {
    return run(`logout:${accountId}`, async () => {
      const account = dataRef.current.accounts.find(item => item.id === accountId);
      if (ipc) {
        await call('logout', { accountId });
        await reload();
      } else {
        await wait(420);
        setData(previous => {
          const accounts = previous.accounts.filter(item => item.id !== accountId);
          const preferredAccountId = previous.settings.preferredAccountId === accountId
            ? accounts[0]?.id
            : previous.settings.preferredAccountId;
          return { ...previous, accounts, settings: { ...previous.settings, preferredAccountId } };
        });
      }
      return `已退出 ${account?.email || accountId}`;
    });
  }

  /** 通道自检：切换 ChatGPT 通道后立刻验证一次，避免「改了但不可用」静默失败。 */
  async function testChannel(kind) {
    return run(`test:${kind}`, async () => {
      if (ipc) {
        const value = await call('channelTest', { kind });
        const failed = value && typeof value === 'object' && (value.ok === false || value.available === false);
        if (failed) throw Object.assign(new Error(typeof value.message === 'string' ? value.message : ERROR_TEXT.network), { code: value.code });
        return typeof value?.message === 'string' ? value.message : '通道可用';
      }
      await wait(600);
      return '通道可用（演示数据）';
    });
  }

  /**
   * 选择 CLI 可执行文件。契约里**没有**这个通道（见回报里的契约缺口），
   * 桥接没提供时如实报错，不假装成功。
   */
  async function pickCliPath() {
    return run('cli-path', async () => {
      const picker = bridge?.pickCliPath;
      if (typeof picker !== 'function') {
        throw Object.assign(new Error('当前桌面端没有提供 CLI 路径选择接口'), { code: 'cli_missing' });
      }
      const value = unwrap(await picker());
      const path = typeof value === 'string' ? value : value?.path;
      if (!path) throw Object.assign(new Error(ERROR_TEXT.cli_missing), { code: 'cli_missing' });
      await patchSettings({ cliPath: path });
      return 'CLI 路径已更新，下一次会话生效';
    });
  }

  /**
   * 重新探测一次 CLI。优先用单独的 cliStatus 通道；桥接没暴露时退回 list() 自带的 cli。
   * 探测失败不抛：调用方是「已安装，重新检测」按钮，只需要知道有没有变好，
   * 真异常会由页面级 error（读不出账号列表）单独报。
   */
  async function recheckCli() {
    if (!ipc) return cliRef.current;
    try {
      const next = typeof bridge?.cliStatus === 'function'
        ? normalizeCli(unwrap(await withTimeout(bridge.cliStatus({ force: true }), 8_000, 'CLI 探测')))
        : normalizeCli((await call('list'))?.cli);
      if (next) {
        cliRef.current = next;
        setCli(next);
        return next;
      }
    } catch {
      // 忽略：保留上一次结果，页面继续显示「状态未知」而不是崩掉。
    }
    return cliRef.current;
  }

  return {
    accounts: data.accounts,
    settings: data.settings,
    models: data.models,
    cli,
    cliState: cliStateOf(cli),
    busy: pending !== '',
    pending,
    error,
    login,
    source: ipc ? 'ipc' : 'demo',
    actions: {
      login: loginAccount,
      completeLogin,
      cancelLogin,
      logout,
      select,
      refresh,
      setSettings,
      testChannel,
      pickCliPath,
      recheckCli,
      reload,
    },
  };
}

export { CHANNELS };

/**
 * 预加载脚本需要暴露的桥接形状（当前 electron/preload.cjs 里还没有 subscription）：
 *
 *   subscription: {
 *     list:        () => ipcRenderer.invoke('subscription:list'),
 *     login:       input => ipcRenderer.invoke('subscription:login', input),
 *     cancelLogin: input => ipcRenderer.invoke('subscription:cancel', input),
 *     logout:      input => ipcRenderer.invoke('subscription:logout', input),
 *     select:      input => ipcRenderer.invoke('subscription:select', input),
 *     refresh:     input => ipcRenderer.invoke('subscription:refresh', input),
 *     settingsGet: () => ipcRenderer.invoke('subscription:settings'),
 *     settingsSet: patch => ipcRenderer.invoke('subscription:settings:set', patch),
 *     models:      () => ipcRenderer.invoke('subscription:models'),
 *     channelTest: input => ipcRenderer.invoke('subscription:channel:test', input),
 *     cliStatus:   () => ipcRenderer.invoke('subscription:cli-status'),
 *     pickCliPath: () => ipcRenderer.invoke('subscription:cli-path:pick'),
 *     onEvent(callback) {
 *       const listener = (_event, payload) => callback(payload || {});
 *       ipcRenderer.on('subscription:event', listener);
 *       return () => ipcRenderer.removeListener('subscription:event', listener);
 *     },
 *   }
 *
 * 返回值统一 { ok: true, value } | { ok: false, error: <错误码> }（与 memory 桥接一致）；
 * list 的 value 形状：{ accounts: AccountView[], settings: CliModelSettings, models: { chatgpt, gemini }, cli: CliStatus }。
 */

export default useSubscription;
