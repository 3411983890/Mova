/**
 * 负责：管理 Bot 自研轻应用（“小程序”）的清单校验、对话式孵化生成、版本迭代升级（严格保留用户数据）、
 *   独立存储（KV/表格）、JSON/CSV 导出、跨 Bot 权限受控读取、报错上报与创建 Bot 自动修复，以及沙箱 iframe HTML + Mova SDK 注入组装。
 * 不负责：渲染器 DOM 挂载（src/features/miniapps/miniapps.jsx 负责）或直接执行操作系统命令。
 * 被谁调用：electron/bots/runtime.mjs、electron/bots/run-service.mjs、electron/bots/ipc.mjs 及测试。
 */
import { cloneJson, generateId } from './store.mjs';

export function validateManifest(manifest = {}) {
  const errors = [];
  if (!manifest.appId || typeof manifest.appId !== 'string') errors.push('manifest.appId 不能为空');
  if (!manifest.name || typeof manifest.name !== 'string') errors.push('manifest.name 不能为空');
  if (!manifest.createdByBotId || typeof manifest.createdByBotId !== 'string') errors.push('manifest.createdByBotId 不能为空');
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(String(manifest.version))) errors.push('manifest.version 必须为 semver 格式');
  if (manifest.routes !== undefined && !Array.isArray(manifest.routes)) errors.push('manifest.routes 必须是数组');
  if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) errors.push('manifest.permissions 必须是数组');
  if (manifest.sharedWith !== undefined && !Array.isArray(manifest.sharedWith)) errors.push('manifest.sharedWith 必须是数组');
  return { valid: errors.length === 0, errors };
}

function defaultGeneratedHtml({ name, description, routes = [] }) {
  const safeRoutes = routes.length ? routes : [
    { id: 'overview', title: '总览' },
    { id: 'checklist', title: '记录列表' },
    { id: 'stats', title: '统计' },
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
body { font-family: var(--mova-font-sans, sans-serif); background: var(--mova-bg, #1b1b1b); color: var(--mova-fg, #efefef); margin: 0; padding: 14px; }
h1 { font-size: 16px; margin: 0 0 6px; }
p.desc { font-size: 12px; color: var(--mova-fg-muted, #9a9a9a); margin: 0 0 12px; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.tab { padding: 6px 11px; border-radius: 8px; border: 1px solid var(--mova-border, #383838); background: var(--mova-surface, #252525); color: inherit; cursor: pointer; font-size: 12px; }
.tab.active { background: var(--mova-accent, #5b9bf0); color: #fff; border-color: transparent; }
.panel { background: var(--mova-surface, #242424); border: 1px solid var(--mova-border, #383838); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.item { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 13px; }
.item:last-child { border-bottom: none; }
.row-add { display: flex; gap: 8px; }
input[type="text"] { flex: 1; background: var(--mova-bg, #1b1b1b); color: inherit; border: 1px solid var(--mova-border, #383838); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
button.btn { background: var(--mova-accent, #5b9bf0); color: #fff; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
</style></head>
<body>
  <h1>${String(name).replace(/</g, '&lt;')}</h1>
  <p class="desc">${String(description || '').replace(/</g, '&lt;')}</p>
  <div class="tabs">
    ${safeRoutes.map((r, i) => `<button class="tab${i === 0 ? ' active' : ''}" data-route="${String(r.id).replace(/"/g, '&quot;')}">${String(r.title).replace(/</g, '&lt;')}</button>`).join('')}
  </div>
  <div id="content" class="panel">加载中...</div>
  <div class="panel row-add">
    <input id="entry-text" type="text" placeholder="添加一条记录..." />
    <button id="entry-add" class="btn">添加</button>
  </div>
  <script>
    (async function() {
      const ctx = window.mova ? await window.mova.context.get() : { route: '${safeRoutes[0].id}' };
      let route = ctx.route || '${safeRoutes[0].id}';
      let records = (window.mova ? await window.mova.storage.get('records') : null) || [];
      function draw() {
        document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.route === route));
        const box = document.getElementById('content');
        if (route === 'overview' || route === '${safeRoutes[0].id}') {
          box.innerHTML = '<div>当前记录数：<strong>' + records.length + '</strong></div><div style="margin-top:6px;opacity:.75;">已完成：' + records.filter(r => r.done).length + '</div>';
        } else if (records.length === 0) {
          box.innerHTML = '<div style="opacity:.7">暂无记录，可以在下方添加</div>';
        } else {
          box.innerHTML = records.map((r, i) => '<label class="item"><span><input type="checkbox" ' + (r.done ? 'checked' : '') + ' data-idx="' + i + '" /> ' + r.text + '</span><span style="opacity:.7">' + (r.done ? '已完成' : '待办') + '</span></label>').join('');
          box.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', async e => {
            records[Number(e.target.dataset.idx)].done = e.target.checked;
            if (window.mova) await window.mova.storage.set('records', records);
            draw();
          }));
        }
      }
      document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => { route = btn.dataset.route; draw(); }));
      document.getElementById('entry-add').addEventListener('click', async () => {
        const input = document.getElementById('entry-text');
        const text = input.value.trim();
        if (!text) return;
        records.push({ id: 'rec_' + Date.now(), text, done: false, at: new Date().toISOString() });
        input.value = '';
        if (window.mova) await window.mova.storage.set('records', records);
        draw();
      });
      draw();
    })();
  </script>
</body>
</html>`;
}

function extractGeneratedHtml(raw) {
  const rawText = typeof raw === 'string'
    ? raw
    : (raw?.entryHtml || raw?.html || raw?.text || '');
  if (!rawText || typeof rawText !== 'string') return null;
  const fenced = rawText.match(/```html\s*([\s\S]*?)```/i) || rawText.match(/```\s*(<!doctype html[\s\S]*?)```/i);
  let candidate = (fenced ? fenced[1] : rawText).trim();
  const docMatch = candidate.match(/(<!doctype html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i);
  if (docMatch) {
    candidate = docMatch[1].trim();
  }
  if (!/<html[\s>]|<!doctype html/i.test(candidate) || candidate.length < 60) {
    return null;
  }
  return candidate;
}

export function createMiniAppService(
  store,
  {
    policyGateway = null,
    conversationService = null,
    codeGenerator = null,
  } = {},
) {
  const clock = store.clock;
  let activeCodeGenerator = typeof codeGenerator === 'function' ? codeGenerator : null;

  function setCodeGenerator(fn) {
    activeCodeGenerator = typeof fn === 'function' ? fn : null;
  }

  async function generateEntryHtml({ bot = null, spec = {} } = {}) {
    if (typeof spec.entryHtml === 'string' && spec.entryHtml.trim()) {
      return spec.entryHtml;
    }
    const name = String(spec.name || 'Bot 轻应用').trim().slice(0, 40);
    const description = String(spec.description || spec.summary || '').trim();
    const routes = Array.isArray(spec.routes) && spec.routes.length > 0
      ? spec.routes
      : [{ id: 'overview', title: '总览' }, { id: 'list', title: '列表' }];
    const fallback = defaultGeneratedHtml({ name, description, routes });
    if (typeof activeCodeGenerator !== 'function') {
      return fallback;
    }
    try {
      const generated = await activeCodeGenerator({ bot, spec: { ...spec, name, description, routes }, routes });
      return extractGeneratedHtml(generated) || fallback;
    } catch {
      return fallback;
    }
  }

  function listApps({ creatorBotId = null, includeDisabled = true } = {}) {
    return store.state.miniApps
      .filter(a => (creatorBotId ? a.createdByBotId === creatorBotId : true))
      .filter(a => (includeDisabled ? true : !a.disabled))
      .map(app => {
        const storageRows = store.state.miniAppStorage.filter(s => s.appId === app.appId);
        return {
          ...cloneJson(app),
          recordCount: storageRows.length,
        };
      })
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  }

  function getApp(appId) {
    const found = store.state.miniApps.find(a => a.appId === appId);
    return found ? cloneJson(found) : null;
  }

  function cardPayloadForApp(app) {
    const storageRows = store.state.miniAppStorage.filter(s => s.appId === app.appId);
    const itemsEntry = storageRows.find(s => Array.isArray(s.value));
    const metricCount = itemsEntry ? itemsEntry.value.length : storageRows.length;
    const routes = (app.manifest?.routes || []).slice(0, 3);
    return {
      type: 'mini_app_card',
      appId: app.appId,
      name: app.name,
      icon: app.icon,
      version: app.version,
      createdByBotId: app.createdByBotId,
      description: app.description,
      metrics: [
        { label: '记录条目', value: String(metricCount) },
        { label: '版本', value: `v${app.version}` },
      ],
      quickRoutes: routes.map(r => ({ id: r.id, title: r.title })),
    };
  }

  function incubateMiniApp({ botId, conversationId = null, spec = {}, postCardMessage = true }) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`创建者 Bot 不存在: ${botId}`);

    const now = clock();
    const appId = spec.appId || generateId('app');
    const name = String(spec.name || 'Bot 轻应用').trim().slice(0, 40);
    const version = String(spec.version || '1.0.0');
    const routes = Array.isArray(spec.routes) && spec.routes.length > 0
      ? spec.routes
      : [{ id: 'overview', title: '总览' }, { id: 'list', title: '列表' }];

    const allowedBotTools = new Set(bot.capabilityConfig?.tools || []);
    const requestedPerms = Array.isArray(spec.permissions) ? spec.permissions : ['storage.read', 'storage.write'];
    // 小程序权限不得越权超出创建者 Bot 的配置边界
    const grantedPerms = requestedPerms.filter(p => {
      if (p.startsWith('storage.')) return true;
      if (p.startsWith('bot.')) return true;
      if (p === 'files.read') return allowedBotTools.has('files');
      return false;
    });

    const manifest = {
      appId,
      name,
      icon: spec.icon || 'cube',
      version,
      createdByBotId: bot.id,
      entry: 'index.html',
      routes: routes.map(r => ({ id: String(r.id), title: String(r.title) })),
      permissions: grantedPerms,
      sharedWith: Array.isArray(spec.sharedWith) ? [...new Set(spec.sharedWith)] : [bot.id],
    };

    const check = validateManifest(manifest);
    if (!check.valid) throw new Error(`manifest 校验失败: ${check.errors.join('; ')}`);

    const entryHtml = spec.entryHtml || defaultGeneratedHtml({ name, description: spec.description, routes: manifest.routes });

    const appRecord = store.mutate(state => {
      const app = {
        appId,
        name,
        icon: manifest.icon,
        description: String(spec.description || `由「${bot.name}」创建的轻量工具`).trim(),
        version,
        createdByBotId: bot.id,
        conversationId,
        manifest,
        entryHtml,
        sourceFiles: cloneJson(spec.sourceFiles || { 'index.html': entryHtml }),
        pinned: Boolean(spec.pinned),
        disabled: false,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: null,
      };
      state.miniApps.unshift(app);

      if (spec.initialStorage && typeof spec.initialStorage === 'object') {
        for (const [key, value] of Object.entries(spec.initialStorage)) {
          state.miniAppStorage.push({
            appId,
            namespace: 'kv',
            key,
            value: cloneJson(value),
            updatedAt: now,
          });
        }
      }
      return cloneJson(app);
    });

    const cardPayload = cardPayloadForApp(appRecord);
    let postedMessage = null;
    if (postCardMessage && conversationId && conversationService) {
      const res = conversationService.addBotMessage({
        conversationId,
        botId: bot.id,
        content: `已为你生成小程序「${appRecord.name}」(${appRecord.version})，可直接点下方页面入口在右侧打开。`,
        structuredPayload: cardPayload,
      });
      postedMessage = res.message;
    }

    return { app: appRecord, cardPayload, message: postedMessage };
  }

  async function incubateMiniAppWithCodegen({ botId, conversationId = null, spec = null, postCardMessage = true, ...rest } = {}) {
    const hasNestedSpec = Boolean(spec && typeof spec === 'object' && Object.keys(spec).length > 0);
    const resolvedSpec = hasNestedSpec
      ? { ...spec }
      : {
          ...(rest.appId ? { appId: rest.appId } : {}),
          ...(rest.name ? { name: rest.name } : {}),
          ...(rest.summary ? { description: rest.summary, summary: rest.summary } : {}),
          ...(rest.description ? { description: rest.description } : {}),
          ...(rest.goal ? { goal: rest.goal } : {}),
          ...(Array.isArray(rest.fields) ? { fields: rest.fields } : {}),
          ...(rest.layout ? { layout: rest.layout } : {}),
          ...(Array.isArray(rest.routes) ? { routes: rest.routes } : {}),
          ...(rest.icon ? { icon: rest.icon } : {}),
          ...(Array.isArray(rest.permissions) ? { permissions: rest.permissions } : {}),
          ...(Array.isArray(rest.sharedWith) ? { sharedWith: rest.sharedWith } : {}),
          ...(rest.initialStorage ? { initialStorage: rest.initialStorage } : {}),
          ...(rest.entryHtml ? { entryHtml: rest.entryHtml } : {}),
        };
    if (!resolvedSpec.entryHtml) {
      const bot = store.state.bots.find(b => b.id === botId) || null;
      resolvedSpec.entryHtml = await generateEntryHtml({ bot, spec: resolvedSpec });
    }
    return incubateMiniApp({ botId, conversationId, spec: resolvedSpec, postCardMessage });
  }

  /**
   * 迭代升级小程序（只更新代码与 manifest，绝不清空或覆盖用户既有存储 mova_mini_app_storage）
   */
  function upgradeMiniApp({ appId, botId = null, patchSpec = {}, newVersion = null }) {
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) throw new Error(`小程序不存在: ${appId}`);
      if (botId && app.createdByBotId !== botId && botId !== 'user') {
        throw new Error('只有创建该小程序的 Bot 或用户可升级其版本');
      }

      const [maj, min, pat] = String(app.version || '1.0.0').split('.').map(n => Number(n) || 0);
      const nextVersion = newVersion || `${maj}.${min}.${pat + 1}`;
      if (patchSpec.name) {
        app.name = String(patchSpec.name).trim();
        app.manifest.name = app.name;
      }
      if (patchSpec.description !== undefined) app.description = String(patchSpec.description);
      if (Array.isArray(patchSpec.routes) && patchSpec.routes.length > 0) {
        app.manifest.routes = cloneJson(patchSpec.routes);
      }
      if (Array.isArray(patchSpec.sharedWith)) {
        app.manifest.sharedWith = [...new Set(patchSpec.sharedWith)];
      }
      if (patchSpec.entryHtml) {
        app.entryHtml = String(patchSpec.entryHtml);
        app.sourceFiles['index.html'] = app.entryHtml;
      } else if (patchSpec.routes || patchSpec.name || patchSpec.description !== undefined) {
        app.entryHtml = defaultGeneratedHtml({
          name: app.name,
          description: app.description,
          routes: app.manifest.routes,
        });
        app.sourceFiles['index.html'] = app.entryHtml;
      }
      app.version = nextVersion;
      app.manifest.version = nextVersion;
      app.lastError = null;
      app.updatedAt = clock();
      return cloneJson(app);
    });
  }

  // ── 独立存储与数据导出 ──────────────────────────────────────────────────

  function getStorage(appId, key, namespace = 'kv') {
    const row = store.state.miniAppStorage.find(
      s => s.appId === appId && s.namespace === namespace && s.key === key,
    );
    return row ? cloneJson(row.value) : null;
  }

  function setStorage(appId, key, value, namespace = 'kv') {
    const app = store.state.miniApps.find(a => a.appId === appId);
    if (!app) throw new Error(`小程序不存在: ${appId}`);
    if (app.disabled) throw new Error('小程序已停用，禁止写入数据');

    return store.mutate(state => {
      const now = clock();
      const existing = state.miniAppStorage.find(
        s => s.appId === appId && s.namespace === namespace && s.key === key,
      );
      if (existing) {
        existing.value = cloneJson(value);
        existing.updatedAt = now;
      } else {
        state.miniAppStorage.push({
          appId,
          namespace,
          key,
          value: cloneJson(value),
          updatedAt: now,
        });
      }
      return cloneJson(value);
    });
  }

  function listStorage(appId, namespace = null) {
    return store.state.miniAppStorage
      .filter(s => s.appId === appId && (namespace ? s.namespace === namespace : true))
      .map(cloneJson);
  }

  function exportAppData(appId, format = 'json') {
    const app = store.state.miniApps.find(a => a.appId === appId);
    const rows = listStorage(appId);
    if (format === 'csv') {
      const esc = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const header = 'namespace,key,updatedAt,value_json';
      const lines = rows.map(r => [esc(r.namespace), esc(r.key), esc(new Date(r.updatedAt).toISOString()), esc(JSON.stringify(r.value))].join(','));
      return {
        format: 'csv',
        filename: `${app?.name || appId}-data.csv`,
        content: [header, ...lines].join('\n'),
      };
    }
    return {
      format: 'json',
      filename: `${app?.name || appId}-data.json`,
      content: JSON.stringify({
        appId,
        name: app?.name || appId,
        version: app?.version || '1.0.0',
        exportedAt: clock(),
        records: rows,
      }, null, 2),
    };
  }

  /**
   * 跨 Bot 读取小程序结构化数据：必须通过 PolicyGateway + manifest.sharedWith 校验
   */
  function queryMiniAppDataForBot({ requesterBotId, appId, key = null, namespace = 'kv' }) {
    if (policyGateway) {
      const verdict = policyGateway.canBotAccessMiniAppData({ requesterBotId, appId });
      if (!verdict.allowed) {
        const err = new Error(`Bot ${requesterBotId} 无权读取小程序 ${appId} 的数据 (${verdict.reason})`);
        err.code = 'ERR_MINIAPP_ACCESS_FORBIDDEN';
        throw err;
      }
    }
    if (key) return { appId, key, value: getStorage(appId, key, namespace) };
    return { appId, records: listStorage(appId) };
  }

  // ── 生命周期管理与故障自愈 ──────────────────────────────────────────────

  function markOpened(appId) {
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) return null;
      app.lastOpenedAt = clock();
      return cloneJson(app);
    });
  }

  function togglePin(appId, pinned = null) {
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) throw new Error(`小程序不存在: ${appId}`);
      app.pinned = pinned === null ? !app.pinned : Boolean(pinned);
      app.updatedAt = clock();
      return cloneJson(app);
    });
  }

  function renameApp(appId, newName) {
    const clean = String(newName || '').trim();
    if (!clean) throw new Error('小程序名称不能为空');
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) throw new Error(`小程序不存在: ${appId}`);
      app.name = clean.slice(0, 40);
      app.manifest.name = app.name;
      app.updatedAt = clock();
      return cloneJson(app);
    });
  }

  function setDisabled(appId, disabled) {
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) throw new Error(`小程序不存在: ${appId}`);
      app.disabled = Boolean(disabled);
      app.updatedAt = clock();
      return cloneJson(app);
    });
  }

  function updatePermissions(appId, { permissions = null, sharedWith = null } = {}) {
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) throw new Error(`小程序不存在: ${appId}`);
      if (Array.isArray(permissions)) app.manifest.permissions = [...new Set(permissions)];
      if (Array.isArray(sharedWith)) app.manifest.sharedWith = [...new Set(sharedWith)];
      app.updatedAt = clock();
      return cloneJson(app);
    });
  }

  function uninstallApp(appId, { retainDataBackup = false } = {}) {
    const backup = retainDataBackup ? exportAppData(appId, 'json') : null;
    store.mutate(state => {
      state.miniApps = state.miniApps.filter(a => a.appId !== appId);
      if (!retainDataBackup) {
        state.miniAppStorage = state.miniAppStorage.filter(s => s.appId !== appId);
      }
    });
    return { uninstalledAppId: appId, retainDataBackup, backup };
  }

  function reportRuntimeError(appId, errorPayload = {}) {
    return store.mutate(state => {
      const app = state.miniApps.find(a => a.appId === appId);
      if (!app) return null;
      app.lastError = {
        message: String(errorPayload.message || '运行时异常'),
        stack: String(errorPayload.stack || '').slice(0, 2000),
        at: clock(),
      };
      return cloneJson(app);
    });
  }

  /** 将异常报错发给创建者 Bot 自动修复，生成新版本并清除 lastError（保留用户数据）。 */
  function requestBotRepair(appId) {
    const app = store.state.miniApps.find(a => a.appId === appId);
    if (!app) throw new Error(`小程序不存在: ${appId}`);

    const repairedHtml = defaultGeneratedHtml({
      name: app.name,
      description: `${app.description || ''}（已由创建者 Bot 自动修复运行异常）`.trim(),
      routes: app.manifest?.routes || [],
    });

    const upgraded = upgradeMiniApp({
      appId,
      botId: app.createdByBotId,
      patchSpec: {
        entryHtml: repairedHtml,
      },
    });
    return upgraded;
  }

  // ── 沙箱 iframe HTML 注入与 SDK RPC 处理 ────────────────────────────────

  function buildSandboxedAppHtml(app, { route = 'overview', theme = 'dark', context = {} } = {}) {
    const tokensCss = theme === 'light'
      ? `:root{--mova-bg:#f7f7f6;--mova-surface:#ffffff;--mova-elevated:#efefef;--mova-fg:#1d1d1d;--mova-fg-muted:#666666;--mova-border:#dedede;--mova-accent:#356ee0;--mova-font-sans:"Microsoft YaHei UI","Segoe UI",sans-serif;}`
      : `:root{--mova-bg:#1c1c1c;--mova-surface:#252525;--mova-elevated:#2e2e2e;--mova-fg:#efefee;--mova-fg-muted:#9f9f9f;--mova-border:#3b3b3b;--mova-accent:#6aa2f8;--mova-font-sans:"Microsoft YaHei UI","Segoe UI",sans-serif;}`;

    const sdkScript = `<script>
(function(){
  const pending = new Map();
  let seq = 0;
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = 'rpc_' + (++seq);
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ source: 'mova-miniapp', appId: ${JSON.stringify(app.appId)}, id, method, params }, '*');
    });
  }
  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (!msg || msg.source !== 'mova-host' || !msg.id) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });
  window.addEventListener('error', function(event) {
    window.parent.postMessage({ source: 'mova-miniapp-error', appId: ${JSON.stringify(app.appId)}, message: event.message, stack: event.error && event.error.stack || '' }, '*');
  });
  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason;
    window.parent.postMessage({ source: 'mova-miniapp-error', appId: ${JSON.stringify(app.appId)}, message: String(reason && reason.message || reason), stack: reason && reason.stack || '' }, '*');
  });
  window.mova = {
    ui: {
      toast: function(text) { return rpc('ui.toast', { text: String(text || '') }); },
      navigate: function(routeId) { return rpc('ui.navigate', { routeId: String(routeId || '') }); },
      getTheme: function() { return ${JSON.stringify(theme)}; }
    },
    context: {
      get: function() { return Promise.resolve(${JSON.stringify({ appId: app.appId, version: app.version, route, ...context })}); }
    },
    storage: {
      get: function(key) { return rpc('storage.get', { key: String(key) }); },
      set: function(key, value) { return rpc('storage.set', { key: String(key), value: value }); },
      list: function() { return rpc('storage.list', {}); }
    },
    bot: {
      send: function(text, options) { return rpc('bot.send', { text: String(text || ''), options: options || {} }); }
    },
    data: {
      query: function(params) { return rpc('data.query', params || {}); }
    }
  };
})();
</script>`;

    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none';">`;
    const styleTag = `<style>${tokensCss}</style>`;
    let html = String(app.entryHtml || '');
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, match => `${match}\n${cspMeta}\n${styleTag}\n${sdkScript}`);
    } else {
      html = `<!doctype html><html><head>${cspMeta}${styleTag}${sdkScript}</head><body>${html}</body></html>`;
    }
    return html;
  }

  async function handleSdkRpc(appId, { method, params = {} }) {
    const app = store.state.miniApps.find(a => a.appId === appId);
    if (!app) throw new Error(`小程序不存在: ${appId}`);
    if (app.disabled) throw new Error('小程序已停用');

    switch (method) {
      case 'storage.get':
        return getStorage(appId, params.key, params.namespace || 'kv');
      case 'storage.set':
        return setStorage(appId, params.key, params.value, params.namespace || 'kv');
      case 'storage.list':
        return listStorage(appId, params.namespace || null);
      case 'context.get':
        return {
          appId: app.appId,
          name: app.name,
          version: app.version,
          createdByBotId: app.createdByBotId,
          conversationId: app.conversationId,
        };
      case 'data.query': {
        const targetAppId = params.targetAppId || appId;
        return queryMiniAppDataForBot({
          requesterBotId: app.createdByBotId,
          appId: targetAppId,
          key: params.key || null,
        });
      }
      case 'bot.send': {
        if (conversationService && app.conversationId) {
          return conversationService.addUserMessage({
            conversationId: app.conversationId,
            content: `[来自小程序「${app.name}」]: ${String(params.text || '').trim()}`,
          });
        }
        return { queued: false };
      }
      case 'ui.toast':
      case 'ui.navigate':
        return { ok: true, params };
      default:
        throw new Error(`未支持的 SDK 方法: ${method}`);
    }
  }

  return {
    validateManifest,
    setCodeGenerator,
    generateEntryHtml,
    listApps,
    getApp,
    cardPayloadForApp,
    incubateMiniApp,
    incubateMiniAppWithCodegen,
    upgradeMiniApp,
    getStorage,
    setStorage,
    listStorage,
    exportAppData,
    queryMiniAppDataForBot,
    markOpened,
    togglePin,
    renameApp,
    setDisabled,
    updatePermissions,
    uninstallApp,
    reportRuntimeError,
    requestBotRepair,
    buildSandboxedAppHtml,
    handleSdkRpc,
  };
}
