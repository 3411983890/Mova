// 直接通过 preload 桥接触发一次 ChatGPT 额度刷新，并把结果摘要返回（不打印令牌）。
const bridge = window.movaDesktop?.subscription;
if (!bridge || typeof bridge.refresh !== 'function') return { error: '没有 subscription 桥接' };
const result = await bridge.refresh({ provider: 'chatgpt' });
const listed = await bridge.list();
const accounts = (listed?.ok ? listed.value.accounts : []).filter(item => item.provider === 'chatgpt');
return {
  ok: result?.ok === true,
  value: result?.ok ? result.value : result?.error,
  accounts: accounts.map(item => ({
    email: item.email,
    state: item.state,
    windows: (item.usage?.windows ?? []).map(window => ({ label: window.label, usedPercent: window.usedPercent })),
    reason: item.usage?.reason ?? null,
    detail: item.usage?.detail ?? null,
  })),
};
