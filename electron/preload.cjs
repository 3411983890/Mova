const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('movaDesktop', {
  act: action => ipcRenderer.invoke('window:action', action),
  interactions: {
    notify: input => ipcRenderer.invoke('interaction:notify', input),
    dismiss: id => ipcRenderer.invoke('interaction:dismiss', id),
    onOpen(callback) {
      const listener = (_event, conversationId) => callback(conversationId);
      ipcRenderer.on('interaction:open', listener);
      return () => ipcRenderer.removeListener('interaction:open', listener);
    },
  },
  clipboard: {
    writeText: text => ipcRenderer.invoke('clipboard:write', text),
  },
  cloud: {
    probe: address => ipcRenderer.invoke('cloud:probe', address),
    device: (action, address, payload) => ipcRenderer.invoke('cloud:device', action, address, payload),
  },
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange(callback) {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },
  siteIcon: host => ipcRenderer.invoke('site:icon', host).then(result => (result?.ok ? result.value : null)).catch(() => null),
  projects: {
    pickFolders: () => ipcRenderer.invoke('projects:pick-folders'),
  },
  design: {
    font: (family, style) => ipcRenderer.invoke('design:font', family, style),
    fontFamilies: () => ipcRenderer.invoke('design:font-families'),
    settings: () => ipcRenderer.invoke('design:settings'),
    configure: patch => ipcRenderer.invoke('design:configure', patch),
    load: scope => ipcRenderer.invoke('design:load', scope),
    save: (scope, revision, snapshot) => ipcRenderer.invoke('design:save', scope, revision, snapshot),
    rekey: (from, to) => ipcRenderer.invoke('design:rekey', from, to),
    respond: payload => ipcRenderer.invoke('design:respond', payload),
    onCommand(callback) {
      const listener = (_event, request) => callback(request);
      ipcRenderer.on('design:command', listener);
      return () => ipcRenderer.removeListener('design:command', listener);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: input => ipcRenderer.invoke('mcp:add', input),
    remove: id => ipcRenderer.invoke('mcp:remove', id),
    toggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', id, enabled),
    tool: (id, name, enabled) => ipcRenderer.invoke('mcp:tool', id, name, enabled),
    refresh: id => ipcRenderer.invoke('mcp:refresh', id),
  },
  ask: {
    respond: (id, answer) => ipcRenderer.invoke('ask:respond', id, answer),
    onRequest(callback) {
      const listener = (_event, request) => callback(request);
      ipcRenderer.on('ask:request', listener);
      return () => ipcRenderer.removeListener('ask:request', listener);
    },
    onClose(callback) {
      const listener = (_event, id) => callback(id);
      ipcRenderer.on('ask:close', listener);
      return () => ipcRenderer.removeListener('ask:close', listener);
    },
  },
  preview: { file: input => ipcRenderer.invoke('preview:file', input) },
  browser: {
    external: url => ipcRenderer.invoke('browser:external', url),
    onEnsure(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('browser:ensure', listener);
      return () => ipcRenderer.removeListener('browser:ensure', listener);
    },
    credentials: {
      status: () => ipcRenderer.invoke('browser:credential:status'),
      list: () => ipcRenderer.invoke('browser:credential:list'),
      save: input => ipcRenderer.invoke('browser:credential:save', input),
      fill: input => ipcRenderer.invoke('browser:credential:fill', input),
      loginRecord: {
        has: (origin, conversationId) => ipcRenderer.invoke('browser:login-record:has', { origin, conversationId }),
        ask: origin => ipcRenderer.invoke('browser:login-record:ask', { origin }),
        save: conversationId => ipcRenderer.invoke('browser:login-record:save', { conversationId }),
        use: (origin, conversationId) => ipcRenderer.invoke('browser:login-record:use', { origin, conversationId }),
      },
    },
    skills: {
      list: () => ipcRenderer.invoke('browser:skill:list'),
      save: input => ipcRenderer.invoke('browser:skill:save', input),
      remove: id => ipcRenderer.invoke('browser:skill:remove', id),
    },
    settings: {
      get: () => ipcRenderer.invoke('browser:settings:get'),
      set: patch => ipcRenderer.invoke('browser:settings:set', patch),
      pickDownloadDir: () => ipcRenderer.invoke('browser:settings:pick-download-dir'),
      resetDownloadDir: () => ipcRenderer.invoke('browser:settings:reset-download-dir'),
      openDownloadDir: () => ipcRenderer.invoke('browser:settings:open-download-dir'),
    },
    activeUrl: () => ipcRenderer.invoke('browser:active-url'),
    cards: {
      list: () => ipcRenderer.invoke('browser:cards:list'),
      clear: input => ipcRenderer.invoke('browser:cards:clear', input),
    },
    clearData: input => ipcRenderer.invoke('browser:clear-data', input),
    resetPartition: () => ipcRenderer.invoke('browser:reset-partition'),
    storage: {
      export: spaceId => ipcRenderer.invoke('browser:storage:export', spaceId),
      import: spaceId => ipcRenderer.invoke('browser:storage:import', spaceId),
    },
    // 网页选取/元素选择模式（§4.5）：start 传 tabId，事件带 nonce 由主进程校验。
    inspect: {
      start: input => ipcRenderer.invoke('browser:inspect:start', input),
      stop: () => ipcRenderer.invoke('browser:inspect:stop'),
      onEvent(callback) {
        const listener = (_event, payload) => callback(payload || {});
        ipcRenderer.on('browser:inspect:event', listener);
        return () => ipcRenderer.removeListener('browser:inspect:event', listener);
      },
    },
    onTakeover(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('browser:takeover', listener);
      return () => ipcRenderer.removeListener('browser:takeover', listener);
    },
    onTakeoverClose(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('browser:takeover:close', listener);
      return () => ipcRenderer.removeListener('browser:takeover:close', listener);
    },
    respondTakeover: (id, decision) => ipcRenderer.invoke('browser:takeover:respond', id, decision),
    tabReady: (tabId, guestId, spaceId) => ipcRenderer.send('browser:tab:ready', { tabId, guestId, spaceId }),
    tabActive: (tabId, spaceId) => ipcRenderer.send('browser:tab:active', { tabId, spaceId }),
    tabCleared: spaceId => ipcRenderer.send('browser:tab:cleared', { spaceId }),
    tabClosed: tabId => ipcRenderer.send('browser:tab:closed', { tabId }),
    onTabNew(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('browser:tab:new', listener);
      return () => ipcRenderer.removeListener('browser:tab:new', listener);
    },
    onTabSelect(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('browser:tab:select', listener);
      return () => ipcRenderer.removeListener('browser:tab:select', listener);
    },
    onTabClose(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('browser:tab:close', listener);
      return () => ipcRenderer.removeListener('browser:tab:close', listener);
    },
  },
  // 电脑操作（desktop engine）。引擎不可用时这些调用返回“不可用”，不会抛。
  desktop: {
    status: () => ipcRenderer.invoke('desktop:status'),
    stop: reason => ipcRenderer.invoke('desktop:stop', reason),
    resume: () => ipcRenderer.invoke('desktop:resume'),
    getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
    setSettings: patch => ipcRenderer.invoke('desktop:set-settings', patch),
    skills: () => ipcRenderer.invoke('desktop:skills'),
    removeSkill: id => ipcRenderer.invoke('desktop:skills:remove', id),
    onStep(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('desktop:step', listener);
      return () => ipcRenderer.removeListener('desktop:step', listener);
    },
    onState(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('desktop:state', listener);
      return () => ipcRenderer.removeListener('desktop:state', listener);
    },
    onUnavailable(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('desktop:unavailable', listener);
      return () => ipcRenderer.removeListener('desktop:unavailable', listener);
    },
  },
  permissions: {
    list: () => ipcRenderer.invoke('permissions:list'),
    register: input => ipcRenderer.invoke('permissions:register', input),
    set: input => ipcRenderer.invoke('permissions:set', input),
    setAutoAccept: input => ipcRenderer.invoke('permissions:set-auto', input),
    getPreset: () => ipcRenderer.invoke('permissions:preset'),
    setPreset: preset => ipcRenderer.invoke('permissions:set-preset', { preset }),
    revoke: rootId => ipcRenderer.invoke('permissions:revoke', rootId),
    forget: rootId => ipcRenderer.invoke('permissions:forget', rootId),
    reveal: rootId => ipcRenderer.invoke('permissions:reveal', rootId),
  },
  changes: {
    list: args => ipcRenderer.invoke('changes:list', args),
    diff: args => ipcRenderer.invoke('changes:diff', args),
  },
  files: {
    reveal: args => ipcRenderer.invoke('changes:reveal', args),
    // 右侧文件视图：只传 rootId + 相对路径，越界判断全在主进程。
    view: {
      list: input => ipcRenderer.invoke('files:view:list', input),
      stat: input => ipcRenderer.invoke('files:view:stat', input),
      read: input => ipcRenderer.invoke('files:view:read', input),
      openDir: input => ipcRenderer.invoke('files:open-dir', input),
      // 绝对路径 → 归属的已登记根（主进程判 realpath，渲染层不猜）。
      locate: input => ipcRenderer.invoke('files:view:locate', input),
      // 用系统默认程序打开（Ctrl/⌘+点击走这条，等同在文件管理器里双击）。
      openExternal: input => ipcRenderer.invoke('files:view:open-external', input),
    },
  },
  approvals: {
    respond: (id, decision) => ipcRenderer.invoke('approval:respond', id, decision),
    onRequest(callback) {
      const listener = (_event, request) => callback(request);
      ipcRenderer.on('approval:request', listener);
      return () => ipcRenderer.removeListener('approval:request', listener);
    },
    onClose(callback) {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('approval:close', listener);
      return () => ipcRenderer.removeListener('approval:close', listener);
    },
  },
  // Conversation naming: one model call after the first exchange, '' when unavailable.
  titles: {
    suggest: input => ipcRenderer.invoke('titles:suggest', input),
  },
  memory: {
    syncSessions: revision => ipcRenderer.invoke('memory:sync-sessions', revision),
    read: () => ipcRenderer.invoke('memory:read'),
    saveSessions: (snapshot, revision) => ipcRenderer.invoke('memory:save-sessions', snapshot, revision),
    ingest: input => ipcRenderer.invoke('memory:ingest', input),
    search: input => ipcRenderer.invoke('memory:search', input),
    context: input => ipcRenderer.invoke('memory:context', input),
    save: input => ipcRenderer.invoke('memory:save', input),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    delete: id => ipcRenderer.invoke('memory:delete', id),
    settings: patch => ipcRenderer.invoke('memory:settings', patch),
    export: () => ipcRenderer.invoke('memory:export'),
    clear: input => ipcRenderer.invoke('memory:clear', input),
    health: () => ipcRenderer.invoke('memory:health'),
    stats: () => ipcRenderer.invoke('memory:stats'),
    backup: input => ipcRenderer.invoke('memory:backup', input),
    backups: () => ipcRenderer.invoke('memory:backups'),
    restore: input => ipcRenderer.invoke('memory:restore', input),
    reindex: () => ipcRenderer.invoke('memory:reindex'),
    jobs: () => ipcRenderer.invoke('memory:jobs'),
    maintenance: input => ipcRenderer.invoke('memory:maintenance', input),
    vault: {
      status: () => ipcRenderer.invoke('vault:status'),
      setup: passphrase => ipcRenderer.invoke('vault:setup', passphrase),
      unlock: passphrase => ipcRenderer.invoke('vault:unlock', passphrase),
      lock: () => ipcRenderer.invoke('vault:lock'),
      put: input => ipcRenderer.invoke('vault:put', input),
      list: () => ipcRenderer.invoke('vault:list'),
      remove: name => ipcRenderer.invoke('vault:remove', name),
      changePassphrase: input => ipcRenderer.invoke('vault:change-passphrase', input),
    },
  },
  edge: { pair: () => ipcRenderer.invoke('edge:pair') },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    save: input => ipcRenderer.invoke('providers:save', input),
    remove: id => ipcRenderer.invoke('providers:remove', id),
    fetch: input => ipcRenderer.invoke('providers:fetch', input),
    defaults: id => ipcRenderer.invoke('providers:defaults', id),
    // 内置订阅 provider（ChatGPT / Gemini）：目录可编辑但只能改名称与模型，不能删、不能改地址。
    saveSubscription: input => ipcRenderer.invoke('providers:subscription-save', input),
    fetchSubscription: input => ipcRenderer.invoke('providers:subscription-fetch', input),
    setActive: active => ipcRenderer.invoke('providers:active', active),
  },
  model: {
    saveSearch: key => ipcRenderer.invoke('model:search-save', key),
    testSearch: key => ipcRenderer.invoke('model:search-test', key),
    complete: (id, request) => ipcRenderer.invoke('model:complete', id, request),
    cancel: id => ipcRenderer.invoke('model:cancel', id),
    onDelta(id, callback) {
      const listener = (_event, requestId, text) => { if (id === requestId) callback(text); };
      ipcRenderer.on('model:delta', listener);
      return () => ipcRenderer.removeListener('model:delta', listener);
    },
  },
  // 搜索增强（Wave B 主进程实现）：配置读写与按源测试。
  // 主进程缺失这些通道时 invoke 会 reject，渲染层按可读错误处理，不会崩。
  search: {
    getConfig: () => ipcRenderer.invoke('search:config-get'),
    saveConfig: patch => ipcRenderer.invoke('search:config-save', patch),
    saveProvider: payload => ipcRenderer.invoke('search:provider-save', payload),
    testProvider: payload => ipcRenderer.invoke('search:provider-test', payload),
  },
  // 按模型分配 VPN 线路：通道名与 electron/vpn/contract.mjs 的 CHANNELS 一字不差。
  // 返回值统一 { ok: true, value } | { ok: false, error, message }，渲染层按 error 码取文案。
  vpn: {
    status: () => ipcRenderer.invoke('vpn:status'),
    importClipboard: input => ipcRenderer.invoke('vpn:import-clipboard', input),
    importSubscription: input => ipcRenderer.invoke('vpn:import-subscription', input),
    refreshSubscription: input => ipcRenderer.invoke('vpn:refresh-subscription', input),
    removeSubscription: input => ipcRenderer.invoke('vpn:remove-subscription', input),
    scanFxy: () => ipcRenderer.invoke('vpn:scan-fxy'),
    importFxy: input => ipcRenderer.invoke('vpn:import-fxy', input),
    testDelays: input => ipcRenderer.invoke('vpn:test-delays', input),
    pool: {
      save: input => ipcRenderer.invoke('vpn:pool:save', input),
      remove: input => ipcRenderer.invoke('vpn:pool:delete', input),
      selectNode: input => ipcRenderer.invoke('vpn:pool:select-node', input),
    },
    getRoutes: () => ipcRenderer.invoke('vpn:routes:get'),
    setRoutes: input => ipcRenderer.invoke('vpn:routes:set', input),
    probeModel: input => ipcRenderer.invoke('vpn:probe-model', input),
    core: {
      action: input => ipcRenderer.invoke('vpn:core:action', input),
      pickPath: () => ipcRenderer.invoke('vpn:core:pick-path'),
      download: () => ipcRenderer.invoke('vpn:core:download'),
    },
    // 线路健康检查：手动跑一轮 + 「允许跨地区切换」开关（默认关）。
    health: {
      check: () => ipcRenderer.invoke('vpn:health:check'),
      settings: input => ipcRenderer.invoke('vpn:health:settings', input),
    },
    onEvent(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('vpn:event', listener);
      return () => ipcRenderer.removeListener('vpn:event', listener);
    },
  },
  // 订阅（CLI 模型）：通道名与 electron/subscription/contract.mjs 的 CHANNELS 一字不差。
  // 返回值统一 { ok: true, value } | { ok: false, error, message }，由渲染层取 code 决定文案。
  subscription: {
    list: () => ipcRenderer.invoke('subscription:list'),
    login: input => ipcRenderer.invoke('subscription:login', input),
    // 浏览器连不上回环地址时，用户把回调链接粘回来完成登录。
    completeLogin: input => ipcRenderer.invoke('subscription:login:complete', input),
    cancelLogin: input => ipcRenderer.invoke('subscription:cancel', input),
    logout: input => ipcRenderer.invoke('subscription:logout', input),
    select: input => ipcRenderer.invoke('subscription:select', input),
    refresh: input => ipcRenderer.invoke('subscription:refresh', input),
    settingsGet: () => ipcRenderer.invoke('subscription:settings'),
    settingsSet: patch => ipcRenderer.invoke('subscription:settings:set', patch),
    models: () => ipcRenderer.invoke('subscription:models'),
    channelTest: input => ipcRenderer.invoke('subscription:channel:test', input),
    pickCliPath: () => ipcRenderer.invoke('subscription:cli-path:pick'),
    // 单独查一次 CLI 状态：设置页据此决定是否弹「安装指引」。
    cliStatus: input => ipcRenderer.invoke('subscription:cli-status', input),
    onEvent(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('subscription:event', listener);
      return () => ipcRenderer.removeListener('subscription:event', listener);
    },
  },
  bots: {
    list: opts => ipcRenderer.invoke('bots:list', opts),
    get: id => ipcRenderer.invoke('bots:get', id),
    create: payload => ipcRenderer.invoke('bots:create', payload),
    createFromTemplate: (templateId, overrides) => ipcRenderer.invoke('bots:create-template', templateId, overrides),
    createFromNaturalLanguage: (prompt, overrides) => ipcRenderer.invoke('bots:create-nl', prompt, overrides),
    update: (id, patch) => ipcRenderer.invoke('bots:update', id, patch),
    rename: (id, newName) => ipcRenderer.invoke('bots:rename', id, newName),
    clone: (id, overrides) => ipcRenderer.invoke('bots:clone', id, overrides),
    setStatus: (id, status) => ipcRenderer.invoke('bots:set-status', id, status),
    checkModelSwitch: (id, nextModelId) => ipcRenderer.invoke('bots:check-model-switch', id, nextModelId),
    deletionImpact: id => ipcRenderer.invoke('bots:deletion-impact', id),
    delete: (id, opts) => ipcRenderer.invoke('bots:delete', id, opts),
    exportBot: id => ipcRenderer.invoke('bots:export', id),
    importBot: payload => ipcRenderer.invoke('bots:import', payload),
    mentionCandidates: (query, opts) => ipcRenderer.invoke('bots:mention-candidates', query, opts),
    listConversations: opts => ipcRenderer.invoke('bot-chats:list', opts),
    getConversation: id => ipcRenderer.invoke('bot-chats:get', id),
    createPrivateChat: opts => ipcRenderer.invoke('bot-chats:create-private', opts),
    getOrCreatePrivateChat: botId => ipcRenderer.invoke('bot-chats:get-or-create-private', botId),
    createGroupChat: opts => ipcRenderer.invoke('bot-chats:create-group', opts),
    updateMeta: (id, patch) => ipcRenderer.invoke('bot-chats:update-meta', id, patch),
    setGroupMode: (id, mode) => ipcRenderer.invoke('bot-chats:set-mode', id, mode),
    addMembers: (id, botIds) => ipcRenderer.invoke('bot-chats:add-members', id, botIds),
    removeMember: (id, botId) => ipcRenderer.invoke('bot-chats:remove-member', id, botId),
    setMemberRole: (id, botId, role) => ipcRenderer.invoke('bot-chats:set-member-role', id, botId, role),
    markRead: id => ipcRenderer.invoke('bot-chats:mark-read', id),
    deleteConversation: id => ipcRenderer.invoke('bot-chats:delete', id),
    sendMessage: payload => ipcRenderer.invoke('bot-chats:send', payload),
    cancelRun: id => ipcRenderer.invoke('bot-chats:cancel', id),
    voteConsensus: payload => ipcRenderer.invoke('bot-chats:vote-consensus', payload),
    searchHistory: params => ipcRenderer.invoke('bot-memory:search-history', params),
    readHistoryWindow: params => ipcRenderer.invoke('bot-memory:read-history', params),
    listMemories: params => ipcRenderer.invoke('bot-memory:list', params),
    saveBotMemory: params => ipcRenderer.invoke('bot-memory:save-bot', params),
    saveGroupMemory: params => ipcRenderer.invoke('bot-memory:save-group', params),
    updateMemory: (id, opts) => ipcRenderer.invoke('bot-memory:update', id, opts),
    deleteMemory: (id, opts) => ipcRenderer.invoke('bot-memory:delete', id, opts),
    askPeerMemory: params => ipcRenderer.invoke('bot-memory:ask-peer', params),
    listTasks: params => ipcRenderer.invoke('bot-tasks:list', params),
    createTask: params => ipcRenderer.invoke('bot-tasks:create', params),
    transitionTask: (id, nextStatus, opts) => ipcRenderer.invoke('bot-tasks:transition', id, nextStatus, opts),
    createTrigger: params => ipcRenderer.invoke('bot-tasks:create-trigger', params),
    listApprovals: params => ipcRenderer.invoke('bot-tasks:approvals-list', params),
    resolveApproval: (id, opts) => ipcRenderer.invoke('bot-tasks:approvals-resolve', id, opts),
    getRuntimeSettings: () => ipcRenderer.invoke('bots:settings-get'),
    updateRuntimeSettings: patch => ipcRenderer.invoke('bots:settings-update', patch),
    onEvent(callback) {
      const listener = (_event, payload) => callback(payload || {});
      ipcRenderer.on('bots:event', listener);
      return () => ipcRenderer.removeListener('bots:event', listener);
    },
  },
  miniApps: {
    list: params => ipcRenderer.invoke('mini-apps:list', params),
    get: appId => ipcRenderer.invoke('mini-apps:get', appId),
    incubate: params => ipcRenderer.invoke('mini-apps:incubate', params),
    upgrade: params => ipcRenderer.invoke('mini-apps:upgrade', params),
    open: (appId, opts) => ipcRenderer.invoke('mini-apps:open', appId, opts),
    getStorage: (appId, key, ns) => ipcRenderer.invoke('mini-apps:storage-get', appId, key, ns),
    setStorage: (appId, key, val, ns) => ipcRenderer.invoke('mini-apps:storage-set', appId, key, val, ns),
    exportData: (appId, format) => ipcRenderer.invoke('mini-apps:export', appId, format),
    queryData: params => ipcRenderer.invoke('mini-apps:query-data', params),
    togglePin: (appId, pinned) => ipcRenderer.invoke('mini-apps:pin', appId, pinned),
    rename: (appId, newName) => ipcRenderer.invoke('mini-apps:rename', appId, newName),
    setDisabled: (appId, disabled) => ipcRenderer.invoke('mini-apps:disable', appId, disabled),
    updatePermissions: (appId, opts) => ipcRenderer.invoke('mini-apps:permissions', appId, opts),
    uninstall: (appId, opts) => ipcRenderer.invoke('mini-apps:uninstall', appId, opts),
    reportError: (appId, err) => ipcRenderer.invoke('mini-apps:report-error', appId, err),
    requestRepair: appId => ipcRenderer.invoke('mini-apps:request-repair', appId),
    rpcCall: (appId, req) => ipcRenderer.invoke('mini-apps:rpc', appId, req),
  },
});
