/**
 * 负责：`desktop-control` 技能包的纯数据声明——`electron/desktop/tools.cjs` 里 10 个桌面工具的
 *   名字、MCP 名、中文 label、风险分级（read / write / exec）、审批策略、暴露方式（全部 on_demand）
 *   与 JSON Schema；零 IO、零函数、零宿主 import。
 * 不负责：工具实现（handlers.mjs 只转调 `createDesktopTools()` 的 execute）、桌面风险分级算法
 *   （`electron/desktop/policy.cjs` 的 classifyDesktopAction）、人工接管的等待与 humanWait 登记
 *   （`electron/desktop/index.cjs` 的 handoff）、字段校验（manifest-schema.mjs）。
 * 被谁调用：electron/skills/packs/index.mjs（接线方把本包登记进 DEFAULT_PACKS）、
 *   electron/skills/registry.mjs、tests/skills-desktop-pack.test.mjs。
 *
 * 名字一律用**真实导出名**（desktop_windows / desktop_snapshot / desktop_act / desktop_wait /
 * desktop_screenshot / desktop_read / desktop_batch / desktop_app / desktop_skill / desktop_handoff）。
 * 方案 §Step 5 里写得好听的 desktop_click / desktop_type / desktop_key / desktop_scroll 在
 * tools.cjs 里并不存在——那四件事都是 `desktop_act` 的 action 取值，另起名字等于造一个死工具。
 */

/** 只读：看窗口、读结构、等条件、截图、读文本都不改变系统状态，免人工确认。 */
const READ_APPROVAL = Object.freeze({ mode: 'none' });
/** 真实输入注入（点击/输入/按键/滚动/拖拽/取值）与启动/关闭应用：exec 能力位 + 人工确认，同会话同工具只问一次。 */
const EXEC_APPROVAL = Object.freeze({ mode: 'policy', capability: 'exec', allowSession: true });
/** 写本地技能库（procedures）：不注入输入，但确实落盘，按 write 过闸门。 */
const WRITE_APPROVAL = Object.freeze({ mode: 'policy', capability: 'write', allowSession: true });

/** 桌面工具永远按需暴露：它们吃 token 且在「设置 → 电脑操作」没打开时本来就用不了。 */
const onDemand = Object.freeze({ piAi: true, mcp: 'on_demand' });

/**
 * `desktop_handoff` 的技能层超时预算。
 *
 * 真实上限在 `electron/desktop/index.cjs` 的 handoff()：
 *   `Math.min(Math.max(Number(input.timeoutMs) || 600000, 5000), 1800000)`
 * 即默认等 600_000 ms（10 分钟）、最长钳在 1_800_000 ms（30 分钟）。技能层必须 ≥ 这个上限，
 * 否则会出现「用户还在操作、技能层先放弃」。这里留 60_000 ms 余量给收尾与事后快照。
 */
export const HANDOFF_TIMEOUT_MS = 1_860_000;

export const manifest = Object.freeze({
  apiVersion: 1,
  id: 'desktop-control',
  version: '1.0.0',
  title: '电脑操作',
  summary: '查看并操作本机桌面窗口：读无障碍结构、点击输入按键、截图、启动应用、保存桌面技能，以及把敏感步骤交还用户。',
  capabilities: [
    'desktop.inspect',
    'desktop.control',
    'desktop.vision',
    'desktop.procedures',
    'desktop.handoff',
  ],
  dependencies: ['desktop'],
  permissions: {
    // 截图要落盘再读回来做成 dataUrl，所以是 fs.read（不往项目里写任何文件）。
    fs: 'read',
    // 键盘鼠标注入与启动进程都属于「执行」这一类副作用。
    exec: true,
    net: false,
    desktop: true,
    browser: false,
    canvas: false,
    memory: 'none',
  },
  // 临时会话可以用（桌面操作与项目根无关）；浏览器专属会话不加载——那一轮用户只想让模型碰浏览器。
  sessionPolicy: { allowTemporary: true, allowBrowserOnly: false, requiresVision: false },
  deprecation: null,
  tools: [
    {
      name: 'desktop_windows',
      mcpName: 'mova_desktop_windows',
      aliases: [],
      label: '桌面窗口',
      mcpSummary: '列出顶层窗口、读前台窗口或列显示器；后续桌面工具需要的 appKey 与窗口标题从这里拿。',
      description: 'List top-level desktop windows, read the foreground window, or list displays. Start here: it '
        + 'tells you the appKey and window title the other desktop tools need.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'active', 'displays'], description: 'Default list' },
          app: { type: 'string', description: 'Filter by exe or title substring' },
          includeMinimized: { type: 'boolean', description: 'Include minimized windows' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '看当前前台窗口', arguments: { action: 'active' } },
        { title: '列出包含 excel 的窗口', arguments: { app: 'excel', limit: 10 } },
      ],
    },
    {
      name: 'desktop_snapshot',
      mcpName: 'mova_desktop_snapshot',
      aliases: [],
      label: '读取界面结构',
      mcpSummary: '返回窗口的紧凑无障碍树（或与上次快照的差异），优先于截图；mode=auto 变化小时只给 diff。',
      description: 'Return the compact accessibility tree of a window (or only the diff since the last snapshot). '
        + 'Prefer this over screenshots. mode=auto returns a diff when little changed.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 45_000,
      // 结果预算 = electron/desktop/tools.cjs 里 desktop_snapshot 的 maxChars 默认值（24000，
      // schema 上限 60000）。技能层统一按 8192 砍会把整棵 UI 树砍成半棵，模型只能看见上半屏控件。
      maxResultChars: 24_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'full', 'diff'], description: 'Default auto' },
          window: { type: 'string', description: 'Window title/hwnd; omit for the foreground window' },
          scope: { type: 'string', enum: ['focus', 'window', 'dialog'], description: 'Default window' },
          depth: { type: 'integer', minimum: 1, maximum: 12, description: 'Default from settings (6)' },
          maxChars: { type: 'integer', minimum: 1000, maximum: 60000, description: 'Default 24000' },
          boxes: { type: 'boolean', description: 'Include element boxes (needed for visual fallback)' },
          skills: { type: 'boolean', description: 'Attach up to 3 matching desktop skills (default true)' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '读前台窗口的结构', arguments: { mode: 'auto' } },
        { title: '深度 8 读 Excel 的完整树', arguments: { window: 'Excel', mode: 'full', depth: 8 } },
      ],
    },
    {
      name: 'desktop_act',
      mcpName: 'mova_desktop_act',
      aliases: [],
      label: '操作界面',
      mcpSummary: '执行一次桌面动作：点击、输入、按键、滚动、拖拽、聚焦、切换或赋值，并返回变化 diff。',
      description: 'Perform one desktop action: invoke a control, click, type text, press a key, scroll, drag, focus, '
        + 'toggle, select or set a value. target is a ref from the latest snapshot (w1.b7) or stable:aid:Name. '
        + 'Returns what changed; if the diff is missing, take a fresh snapshot.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 90_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['invoke', 'click', 'type', 'key', 'scroll', 'drag', 'focus', 'toggle', 'select', 'setValue'],
          },
          target: { type: 'string', description: 'ref like w1.b7, stable:aid:SaveBtn, or text="保存"' },
          value: { type: 'string', description: 'Text to type / value to set / key combo like Ctrl+S' },
          keys: { type: 'string', description: 'For action=key: key combo such as Ctrl+S' },
          to: { type: 'string', description: 'Drag target (ref or point x,y)' },
          expect: {
            type: 'object',
            description: 'Optional post-condition: {window, element, text, title, selected}，或像素条件 {kind:"pixels", threshold}',
            properties: {
              kind: { type: 'string', enum: ['pixels'] },
              threshold: { type: 'number', minimum: 0, maximum: 1 },
              window: { type: 'string' },
              element: { type: 'string' },
              text: { type: 'string' },
              title: { type: 'string' },
              selected: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          pixels: {
            type: 'boolean',
            description: '用前后两帧对比来判断“界面真的变了”（自绘界面 UIA 树为空时用这个）',
          },
          tier: { type: 'string', enum: ['auto', 't1', 't2', 't3'], description: 'Default auto' },
          timeout: { type: 'integer', minimum: 500, maximum: 60000, description: 'Default 8000' },
          snapshot: { type: 'boolean', description: 'Set false to skip the post-action diff' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '点击快照里的一个按钮', arguments: { action: 'click', target: 'w1.b7' } },
        { title: '在搜索框里输入并回车', arguments: { action: 'type', target: 'w1.b3', value: '季度报表' } },
      ],
    },
    {
      name: 'desktop_wait',
      mcpName: 'mova_desktop_wait',
      aliases: [],
      label: '等待界面条件',
      mcpSummary: '等待窗口、元素、文本出现，或等界面稳定；别用盲目 sleep，动作触发异步后就用它。',
      description: 'Wait for a window, an element, text, or the UI to settle. Never sleep blindly; use this after an '
        + 'action that triggers async work.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 70_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          for: { type: 'string', enum: ['window', 'element', 'text', 'idle', 'stable', 'time'] },
          title: { type: 'string', description: 'For for=window: title substring' },
          ref: { type: 'string', description: 'For for=element: ref or stable key' },
          text: { type: 'string', description: 'For for=text' },
          ms: { type: 'integer', minimum: 0, maximum: 5000, description: 'For for=time' },
          timeout: { type: 'integer', minimum: 500, maximum: 60000, description: 'Default 8000' },
        },
        required: ['for'],
        additionalProperties: false,
      },
      examples: [
        { title: '等界面稳定下来', arguments: { for: 'stable' } },
        { title: '等「导出完成」出现', arguments: { for: 'text', text: '导出完成', timeout: 20000 } },
      ],
    },
    {
      name: 'desktop_screenshot',
      mcpName: 'mova_desktop_screenshot',
      aliases: [],
      label: '屏幕截图',
      mcpSummary: '截取窗口或区域做视觉兜底，可 OCR 与 SoM 标注；截图会落盘并在时间线内联显示。',
      description: 'Capture a window or region for visual fallback (SoM labels / zoom). Only use it when the tree is '
        + 'not enough; screenshots cost tokens. The file is temporary and only its path is returned unless '
        + 'includeInResult=true.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 90_000,
      supportsProgress: false,
      imageOutput: true,
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'thumb', 'window', 'region'], description: 'Default auto (window)' },
          window: { type: 'string', description: 'Window title/hwnd; omit for the foreground window' },
          region: {
            type: 'object',
            description: 'Screen rect in physical pixels',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          maxLongEdge: { type: 'integer', minimum: 320, maximum: 2560, description: 'Default 1280' },
          ocr: {
            type: 'boolean',
            description: 'Run Windows OCR and return text lines with coordinates (use it for canvas/self-drawn UIs such as WeChat)',
          },
          annotate: { type: 'string', enum: ['som', 'none'], description: 'Default som' },
          zoom: { type: 'number', description: '1–4, crop around the last target' },
          includeInResult: { type: 'boolean', description: 'Attach the image to the tool result' },
          reason: { type: 'string', description: 'visual-check | canvas | tree-opaque | user-request' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '给前台窗口截图并读文字', arguments: { mode: 'window', ocr: true } },
        { title: '放大看上一次点击的目标', arguments: { zoom: 2, annotate: 'none' } },
      ],
    },
    {
      name: 'desktop_read',
      mcpName: 'mova_desktop_read',
      aliases: [],
      label: '读取窗口文本',
      mcpSummary: '从窗口里读可读文本或表格（不给控件树）；读内容用它，找控件用 desktop_snapshot。',
      description: 'Extract readable text (or a table) from a window without the structural tree. Use it to read '
        + 'content; use desktop_snapshot to find controls.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 45_000,
      // 结果预算 = electron/desktop/tools.cjs 里 desktop_read 的 maxChars 默认值（20000，上限 60000）。
      maxResultChars: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          window: { type: 'string', description: 'Window title/hwnd; omit for the foreground window' },
          scope: { type: 'string', enum: ['focus', 'window', 'dialog', 'selection'], description: 'Default window' },
          format: { type: 'string', enum: ['text', 'table'], description: 'Default text' },
          maxChars: { type: 'integer', minimum: 500, maximum: 60000, description: 'Default 20000' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        { title: '读当前窗口的文本', arguments: { scope: 'window' } },
        { title: '把表格按行读出来', arguments: { window: 'Excel', format: 'table', maxChars: 30000 } },
      ],
    },
    {
      name: 'desktop_batch',
      mcpName: 'mova_desktop_batch',
      aliases: [],
      label: '批量桌面操作',
      mcpSummary: '一次最多 30 步桌面操作，或重放已保存的桌面技能；每步单独授权，首个失败即停。',
      description: 'Run up to 30 desktop steps in one call, or replay a saved skill with {recipe, inputs}. Every step '
        + 'is authorized separately and the batch stops at the first failure unless stopOnError=false. Returns one '
        + 'diff at the end.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 330_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          recipe: { type: 'string', description: 'Saved desktop skill id; replaces steps' },
          inputs: { type: 'object', description: 'Values for {{placeholders}} in the recipe', additionalProperties: true },
          steps: {
            type: 'array',
            description: 'Ordered steps',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['invoke', 'click', 'type', 'key', 'press', 'scroll', 'drag', 'focus', 'toggle', 'select', 'setValue', 'wait', 'launch', 'activate', 'close'],
                },
                target: { type: 'string' },
                value: { type: 'string' },
                keys: { type: 'string' },
                ms: { type: 'integer' },
                for: { type: 'string', enum: ['window', 'element', 'text', 'idle', 'stable', 'time'] },
                title: { type: 'string' },
                text: { type: 'string' },
                app: { type: 'string' },
                expect: { type: 'object' },
                optional: { type: 'boolean' },
                timeout: { type: 'integer' },
              },
              required: ['op'],
              additionalProperties: true,
            },
          },
          stopOnError: { type: 'boolean', description: 'Default true' },
          snapshot: { type: 'string', enum: ['end', 'diff', 'none'], description: 'Default end (diff)' },
          timeout: { type: 'integer', minimum: 5000, maximum: 300000, description: 'Whole batch timeout, default 120000' },
        },
        required: [],
        additionalProperties: false,
      },
      examples: [
        {
          title: '聚焦搜索框、输入、回车三步',
          arguments: {
            steps: [
              { op: 'focus', target: 'w1.b3' },
              { op: 'type', target: 'w1.b3', value: '季度报表' },
              { op: 'key', keys: 'ENTER' },
            ],
          },
        },
        { title: '重放已保存的桌面技能', arguments: { recipe: 'excel-月度汇总', inputs: { 月份: '10' } } },
      ],
    },
    {
      name: 'desktop_app',
      mcpName: 'mova_desktop_app',
      aliases: [],
      label: '桌面应用',
      mcpSummary: '启动、激活或关闭桌面应用；启动与激活是轻交互，关闭需要人工确认。',
      description: 'Launch, activate or close a desktop application. Launch/activate are R1; closing needs approval.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['launch', 'activate', 'close'] },
          app: { type: 'string', description: 'Exe name, appKey, or window title substring' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for launch' },
          cwd: { type: 'string', description: 'Working directory for launch' },
        },
        required: ['action', 'app'],
        additionalProperties: false,
      },
      examples: [
        { title: '启动记事本', arguments: { action: 'launch', app: 'notepad.exe' } },
        { title: '把 Excel 切到前台', arguments: { action: 'activate', app: 'excel' } },
      ],
    },
    {
      name: 'desktop_skill',
      mcpName: 'mova_desktop_skill',
      aliases: [],
      label: '桌面技能',
      mcpSummary: '列出、查找、保存或删除可复用的桌面操作过程；保存后用 desktop_batch 的 recipe 一步重放。',
      description: 'List, find, save or remove reusable desktop procedures. Saving uses the steps observed in this '
        + 'session (or explicit steps); replay with desktop_batch({recipe, inputs}).',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'find', 'save', 'remove'] },
          id: { type: 'string', description: 'Skill id for remove / save' },
          app: { type: 'string', description: 'appKey like excel.exe|16.0, or exe name' },
          intent: { type: 'array', items: { type: 'string' }, description: 'Words describing when to use it' },
          title: { type: 'string', description: 'Human title for save' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Explicit steps (optional)' },
          params: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Parameters for save' },
          verify: { type: 'object', description: 'Optional success check' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 5 for find' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '看这个应用有哪些技能', arguments: { action: 'find', app: 'excel.exe' } },
        { title: '把本次三步保存成技能', arguments: { action: 'save', title: '月度汇总', intent: ['月报'] } },
      ],
    },
    {
      name: 'desktop_handoff',
      mcpName: 'mova_desktop_handoff',
      aliases: [],
      label: '交给用户接管',
      mcpSummary: '停下并把桌面交给用户（登录、密码、UAC、验证码、支付、需要人决定），等用户继续后重新快照。',
      description: 'Stop and let the user take over the desktop: login, password, UAC/secure desktop, payment, '
        + 'deletion, or any decision you must not make. Waits until the user resumes or cancels, then take a fresh '
        + 'snapshot. Never try to fill passwords yourself.',
      risk: 'exec',
      // 声明 exec + policy 是为了让「这不是只读工具」在清单里可见；handler 刻意**不**再过 ctx.authorize()：
      // 接管是安全出口，被审批条拦住会把模型逼回「自己动手填密码」。详见 handlers.mjs 头注释。
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: HANDOFF_TIMEOUT_MS,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['login', 'password', 'uac', 'captcha', '2fa', 'payment', 'consent', 'choice', 'other'],
          },
          note: { type: 'string', description: 'One short sentence telling the user what to do' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      examples: [
        { title: '让用户自己登录', arguments: { reason: 'login', note: '请在打开的应用里登录后点「继续」' } },
        { title: '支付前交给用户', arguments: { reason: 'payment', note: '金额与收款方需要你本人确认' } },
      ],
    },
  ],
});
