/**
 * 负责：`browser-automation` 技能包的纯数据声明——`createBrowserTools()` 导出的全部工具
 *   （16 个，`browser_pointer` 只在控制器注入了 pointer 操作时存在）的名字、MCP 名、中文 label、
 *   风险分级、审批策略、暴露方式、超时预算与 JSON Schema；零 IO、零函数、零宿主 import。
 * 不负责：工具实现（handlers.mjs 直接转调 electron/browser/tools.cjs 产出的 execute）、
 *   站点风险分级与 `authorize()` 判定（electron/browser/policy.cjs 与 tools.cjs 内部），
 *   也不负责字段校验（electron/skills/manifest-schema.mjs）。
 * 被谁调用：electron/skills/packs/index.mjs（DEFAULT_PACKS）、electron/skills/registry.mjs、
 *   tests/skills-browser-pack.test.mjs（assertValidManifest + 与真实导出比对）。
 *
 * `description` 一律照抄 tools.cjs 里的完整英文描述（模型就是靠它选工具的，改写等于调参）；
 * `label` 照抄同一处的 label（前端时间线显示的就是它）；`mcpSummary` 才做压缩。
 * `inputSchema` 与 tools.cjs 的 `parameters` 逐字段一致，只补 `additionalProperties:false` 与长度上限。
 */

/**
 * 只读工具：能力位复查仍会做（approval-bridge 对 read 也查），但不弹人工确认条——
 * 与 electron/browser 层一致：snapshot/read/wait/tabs 在 policy.cjs 里是 level 0，本来就不问人。
 */
const READ_APPROVAL = Object.freeze({ mode: 'none' });
/** 会改变页面状态（导航、点击、填表、执行脚本、接管、批量）的工具：过 exec 能力位 + 人工确认，同会话只问一次。 */
const EXEC_APPROVAL = Object.freeze({ mode: 'policy', capability: 'exec', allowSession: true });
/** 会写盘的工具（站点技能库、登录态导出/导入）：走 write 能力位，同样允许会话内免重复确认。 */
const WRITE_APPROVAL = Object.freeze({ mode: 'policy', capability: 'write', allowSession: true });

/** 浏览器工具默认 on_demand：tools/list 里只留核心工具，浏览器靠 mova_skill_search 发现。 */
const onDemand = Object.freeze({ piAi: true, mcp: 'on_demand' });

/** 多空间会话里指定空间；绝大多数工具都需要，统一一份描述避免文案漂移。 */
const SPACE = Object.freeze({ type: 'string', description: 'Space id; omit for the active space' });

/** browser_handoff 的最长等待：tools.cjs 的描述写的是「up to 10 minutes」，超时必须比它长。 */
const HANDOFF_TIMEOUT_MS = 600_000;

export const manifest = Object.freeze({
  apiVersion: 1,
  id: 'browser-automation',
  version: '1.0.0',
  title: '内置浏览器控制',
  summary: '控制 Mova 侧边浏览器：导航、结构化读取、交互、批量执行、站点技能复用与人工接管。',
  capabilities: [
    'browser.navigate',
    'browser.read',
    'browser.interact',
    'browser.batch',
    'browser.visual',
    'browser.skill',
    'browser.session',
  ],
  dependencies: ['browser'],
  permissions: {
    fs: 'read', // 只有 browser_upload 需要读本地已选文件路径；写盘由 chat-images / 技能库自己管
    exec: false,
    net: true,
    desktop: false,
    browser: true, // 受 electron/browser/policy.cjs 的站点风险分级与 tier 限制
    canvas: false,
    memory: 'read', // 只有 browser_login 读 Vault 里的站点凭据（密码不进模型上下文）
  },
  sessionPolicy: { allowTemporary: true, allowBrowserOnly: true },
  deprecation: null,
  tools: [
    {
      name: 'browser_navigate',
      mcpName: 'mova_browser_navigate',
      label: '打开网页',
      mcpSummary: '在 Mova 侧边浏览器打开 http(s) 网址，并在同一次调用里返回页面观察结果。',
      description: 'Open an http(s) URL — or a file:/// path inside a project folder — in the Mova side browser and return the page observation in the same call '
        + '(observation.text), so no extra browser_snapshot is needed to see the page. Pass observe:"none" only when '
        + 'you will immediately act on a known page. Matching saved site skills are returned as skills:',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 4_000, description: 'Absolute http(s) URL, or a file:/// path inside a project folder (html/svg/images/pdf/text/markdown)' },
          timeout: { type: 'integer', minimum: 1_000, maximum: 120_000, description: 'Navigation timeout in ms (default 30000)' },
          observe: { type: 'string', enum: ['auto', 'full', 'none'], description: 'Default auto: wait for the page to settle and return a snapshot. none skips it.' },
          space: { ...SPACE },
        },
        required: ['url'],
        additionalProperties: false,
      },
      examples: [
        { title: '打开一个商品页并同时拿到页面结构', arguments: { url: 'https://example.com/product/42' } },
      ],
    },
    {
      name: 'browser_snapshot',
      mcpName: 'mova_browser_snapshot',
      label: '读取页面结构',
      mcpSummary: '返回当前页面的紧凑无障碍树（默认只给与上次的差异），用于定位要点的控件。',
      description: 'Return the compact accessibility tree of the current page. Prefer this over screenshots. mode=auto '
        + 'returns only the diff since the last snapshot unless the page changed too much. Frames are on demand: the '
        + 'default frames:"index" lists iframes without their contents, then frame:"f1" reads one. ref:"@e12" returns '
        + 'only that subtree when a page is too large.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      // 结果预算 = 工具自己的快照预算：electron/browser/snapshot.cjs 的 maxChars 默认 24000
      //（settings.cjs 的 advanced.snapshotBudget 默认值），schema 的上限是 60000。
      // 技能层以前统一按 8192 砍，正好把工具自己给的 24000 预算砍掉三分之二。
      maxResultChars: 24_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'full', 'diff'], description: 'Default auto' },
          maxChars: { type: 'integer', minimum: 500, maximum: 60_000, description: 'Character budget, default 24000' },
          scope: { type: 'string', enum: ['page', 'main'], description: 'page includes the frame index; main skips frames entirely' },
          frames: { type: 'string', enum: ['none', 'index', 'all'], description: 'index (default) lists iframes only, all inlines their contents, none skips frames' },
          frame: { type: 'string', maxLength: 20, description: 'Frame id from a previous snapshot (f1, f2, ...) to read that iframe only' },
          ref: { type: 'string', maxLength: 40, description: 'Only return the subtree of this ref from the latest snapshot (@e12)' },
          space: { ...SPACE },
        },
        additionalProperties: false,
      },
      examples: [
        { title: '读取当前页面的差量结构', arguments: { mode: 'auto' } },
        { title: '只读搜索框所在子树', arguments: { ref: '@e12' } },
      ],
    },
    {
      name: 'browser_read',
      mcpName: 'mova_browser_read',
      label: '提取正文',
      mcpSummary: '把当前页面的正文提取成 Markdown（可选附带链接），适合阅读内容而非找控件。',
      description: 'Extract the main article/page text as Markdown. Use for reading content; use browser_snapshot to '
        + 'find controls.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      // 结果预算 = electron/browser/read.cjs 的真实正文上限：不传 maxChars 时正文按 20000 截断
      //（传了也只夹到 40000）。这里刻意不跟 snapshot 一样取 24000——那是快照树的预算，不是正文的。
      maxResultChars: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          maxChars: { type: 'integer', minimum: 500, maximum: 60_000, description: 'Default 20000' },
          includeLinks: { type: 'boolean', description: 'Include the links found in the main content' },
          space: { ...SPACE },
        },
        additionalProperties: false,
      },
      examples: [
        { title: '读一篇长文的正文并带上链接', arguments: { maxChars: 20_000, includeLinks: true } },
      ],
    },
    {
      name: 'browser_wait',
      mcpName: 'mova_browser_wait',
      label: '等待页面条件',
      mcpSummary: '等待真实页面条件（settle/选择器/文本/URL/iframe/下载），不要用睡眠代替。',
      description: 'Wait for a real page condition instead of sleeping. Prefer for="settle" after an action that '
        + 'triggers async work or animation, selector/text/url for a known target, frame for an iframe, download for a '
        + 'file. for="time" is capped at 2000 ms and is only a last resort.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 45_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          for: {
            type: 'string',
            enum: ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame', 'download', 'time'],
          },
          selector: { type: 'string', maxLength: 1_000, description: 'Required for selector/frame/animation when scoping one element' },
          frame: { type: 'string', maxLength: 20, description: 'For for=frame: frame id from a previous snapshot (f1, f2, ...)' },
          state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
          text: { type: 'string', maxLength: 2_000, description: 'Expected text, or the previous text for text-change' },
          url: { type: 'string', maxLength: 4_000 },
          quietMs: { type: 'integer', minimum: 0, maximum: 10_000, description: 'For settle/idle: how long the DOM must stay quiet (default 150)' },
          ms: { type: 'integer', minimum: 0, maximum: 2_000, description: 'For for=time, max 2000' },
          timeout: { type: 'integer', minimum: 100, maximum: 30_000, description: 'Default 8000, max 30000' },
          space: { ...SPACE },
        },
        required: ['for'],
        additionalProperties: false,
      },
      examples: [
        { title: '点完搜索后等页面稳定', arguments: { for: 'settle', quietMs: 200 } },
      ],
    },
    {
      name: 'browser_act',
      mcpName: 'mova_browser_act',
      label: '操作页面',
      mcpSummary: '对一个元素点击/填写/选择/勾选/悬停/按键/滚动，返回页面 diff。',
      description: 'Click, fill, select, check, hover or press a key on one element. target is a ref from the latest '
        + 'snapshot (@e12) or css=selector. Returns a diff of what changed; if the diff is missing, take a snapshot.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll'] },
          target: { type: 'string', maxLength: 1_000, description: 'Ref (@e12) or css=selector' },
          value: { type: 'string', maxLength: 8_000, description: 'Text, option value, key name, true/false for check, or signed pixels for scroll' },
          clickCount: { type: 'integer', minimum: 1, maximum: 3, description: '1-3, default 1' },
          submit: { type: 'boolean', description: 'Press Enter after fill/type' },
          expect: {
            type: 'object',
            description: 'Optional post-condition: {selector,state,text,url}',
            properties: {
              selector: { type: 'string' },
              state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
              text: { type: 'string' },
              url: { type: 'string' },
              timeout: { type: 'integer' },
            },
            additionalProperties: false,
          },
          snapshot: { type: 'boolean', description: 'Set false to skip the post-action diff' },
          space: { ...SPACE },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '点登录按钮并等页面变化', arguments: { action: 'click', target: '@e12' } },
        { title: '填搜索词并回车', arguments: { action: 'fill', target: '@e5', value: 'Electron 45', submit: true } },
      ],
    },
    {
      name: 'browser_dialog',
      mcpName: 'mova_browser_dialog',
      label: '处理对话框',
      mcpSummary: '接受或关闭当前打开的 alert/confirm/prompt，或预设下一个对话框的处理策略。',
      description: 'Accept or dismiss a currently open JavaScript alert/confirm/prompt. Alerts are auto-accepted and '
        + 'confirms are auto-dismissed by default; use this when the page needs a prompt answer.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['accept', 'dismiss', 'arm'] },
          policy: { type: 'string', enum: ['accept', 'dismiss'], description: 'For action=arm: policy for the next dialog' },
          promptText: { type: 'string', maxLength: 2_000, description: 'Text for a prompt dialog' },
          space: { ...SPACE },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '在 prompt 里填一句话并确认', arguments: { action: 'accept', promptText: '确认删除' } },
      ],
    },
    {
      name: 'browser_upload',
      mcpName: 'mova_browser_upload',
      label: '上传文件',
      mcpSummary: '给 file 输入框设置本地绝对路径（最多 5 个文件、每个 25 MB），需要审批。',
      description: 'Set absolute local file paths on a file input. Requires approval and accepts at most 5 files of '
        + '25 MB each.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 60_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', minLength: 1, maxLength: 1_000, description: 'Ref or css= selector for input[type=file]' },
          files: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string', maxLength: 1_000 },
            description: 'Absolute file paths',
          },
          space: { ...SPACE },
        },
        required: ['target', 'files'],
        additionalProperties: false,
      },
      examples: [
        { title: '给文件输入框选中一个文件', arguments: { target: '@e7', files: ['C:\\Users\\me\\Documents\\报告.pdf'] } },
      ],
    },
    {
      name: 'browser_run_js',
      mcpName: 'mova_browser_run_js',
      label: '执行 JS 批处理',
      mcpSummary: '在页面里跑一段 JS 批处理脚本（需在设置里开启并审批）；普通步骤请用 browser_batch。',
      description: 'Run a JavaScript batch against a small page API: goto/click/fill/press/waitFor/snapshot/evaluate/'
        + 'text. No require/process/fetch; vm is not a security boundary, so every run needs approval. Prefer '
        + 'browser_batch for ordinary steps.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 75_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', minLength: 1, maxLength: 40_000, description: 'JavaScript body; may await page.* calls and return JSON' },
          timeout: { type: 'integer', minimum: 1_000, maximum: 60_000, description: 'Default 15000, max 60000' },
          space: { ...SPACE },
        },
        required: ['script'],
        additionalProperties: false,
      },
      examples: [
        { title: '批量取回页面上的标题列表', arguments: { script: 'const t = await page.evaluate(() => [...document.querySelectorAll("h2")].map(h => h.textContent)); return { t };' } },
      ],
    },
    {
      name: 'browser_storage_state',
      mcpName: 'mova_browser_storage_state',
      label: '登录态导入导出',
      mcpSummary: '把当前站点的 cookie/localStorage 导出到加密本地文件，或导回来；值不回传模型。',
      description: 'Export the current origin cookies/localStorage to an encrypted local file, or import it back. '
        + 'Values are never returned to the model. Import/export needs approval.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['export', 'import'] },
          space: { ...SPACE },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '导出当前站点登录态', arguments: { action: 'export' } },
      ],
    },
    {
      name: 'browser_batch',
      mcpName: 'mova_browser_batch',
      label: '批量操作',
      mcpSummary: '一次执行最多 30 步浏览器操作或重放已保存站点技能（recipe），末尾返回页面 diff。',
      description: 'Preferred way to run a mechanical sequence: up to 30 steps in ONE tool call, one diff at the end, '
        + 'instead of one call per click. Use it whenever you already know the next 2+ steps, and replay a saved skill '
        + 'with {recipe, inputs} rather than re-deriving the flow. Steps: {op:"navigate"|"click"|"fill"|"type"|"press"|'
        + '"select"|"check"|"hover"|"scroll"|"wait", ...}. Every write step is authorized separately; the batch stops at '
        + 'the first failure unless continueOnError is true. If the batch times out it returns partial results with the '
        + 'steps that really ran — continue from there instead of replaying. A successful result may include '
        + 'skillCandidate; when it does, weigh browser_skill save as described there.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: { piAi: true, mcp: 'on_demand' },
      timeoutMs: 120_000,
      // 结果预算怎么定：batch 的正文 = 每步一行摘要 + **末尾那一份快照**
      // （electron/browser/batch.cjs 的 `target.snapshot({ mode })` → controller.cjs 用
      // settings.cjs 的 advanced.snapshotBudget，默认 24000）。单步 observe:true 也会多带一份快照，
      // 但那是调用方显式要的、通常会配 ref/frame 收窄；这里按「末尾快照的预算」取 24000。
      maxResultChars: 24_000,
      supportsProgress: true,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          recipe: { type: 'string', maxLength: 120, description: '已保存的站点技能 ID（与 steps 二选一）' },
          inputs: { type: 'object', additionalProperties: true, description: 'recipe 模板中的 {{占位符}} 参数' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            description: '有序操作步骤',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['navigate', 'click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll', 'wait'] },
                url: { type: 'string' },
                target: { type: 'string' },
                value: { type: 'string' },
                selector: { type: 'string' },
                state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
                text: { type: 'string' },
                for: { type: 'string', enum: ['selector', 'text', 'text-change', 'url', 'load', 'settle', 'idle', 'animation', 'frame', 'download', 'time'] },
                ms: { type: 'integer' },
                quietMs: { type: 'integer' },
                timeout: { type: 'integer' },
                submit: { type: 'boolean' },
                observe: { type: 'boolean', description: 'For navigate: include the page snapshot in that step result' },
                expect: { type: 'object' },
              },
              required: ['op'],
              additionalProperties: true,
            },
          },
          continueOnError: { type: 'boolean' },
          snapshot: { type: 'string', enum: ['end', 'full', 'none'], description: 'Default end (diff)' },
          timeout: { type: 'integer', minimum: 1_000, maximum: 180_000, description: 'Whole batch timeout, default 90000' },
          space: { ...SPACE },
        },
        additionalProperties: false,
      },
      examples: [
        {
          title: '批量填写搜索框并回车等待页面稳定',
          arguments: {
            steps: [
              { op: 'fill', target: '@e5', value: 'Electron 45', submit: true },
              { op: 'wait', for: 'settle', quietMs: 200 },
            ],
            snapshot: 'end',
          },
        },
        {
          title: '重放已保存的站点技能',
          arguments: { recipe: 'shop-checkout', inputs: { sku: 'A-42' } },
        },
      ],
    },
    {
      name: 'browser_login',
      mcpName: 'mova_browser_login',
      label: '填充登录',
      mcpSummary: '用记忆库里的站点凭据填当前登录表单（可选提交），密码不进入模型上下文。',
      description: 'Fill the current login form with credentials saved in the memory vault, optionally submitting. '
        + 'The password never enters the model context. If no credential exists, ask the user to use the key button in '
        + 'the browser panel.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 45_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          submit: { type: 'boolean', description: 'Press Enter after filling' },
          space: { ...SPACE },
        },
        additionalProperties: false,
      },
      examples: [
        { title: '填好登录表单并直接提交', arguments: { submit: true } },
      ],
    },
    {
      name: 'browser_skill',
      mcpName: 'mova_browser_skill',
      label: '站点技能',
      mcpSummary: '列出/保存/删除可复用的站点操作流程；保存走审批，回放用 browser_batch({recipe})。',
      description: 'List, save or remove reusable site procedures. Decide yourself when a flow is worth saving: save '
        + 'only after a successful multi-step flow (3+ steps) that is likely to be repeated and that the user did not '
        + 'say should be done just once; do not save one-off actions that only apply to the current data (this order, '
        + 'this search, this session\'s values). Saving uses the steps observed since the last navigation; replay with '
        + 'browser_batch({recipe, inputs}). After save succeeds, briefly tell the user the skill name.',
      risk: 'write',
      approval: WRITE_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'remove'] },
          id: { type: 'string', maxLength: 120, description: 'Skill id for remove' },
          title: { type: 'string', maxLength: 80, description: 'Required short human title for save (max 80 chars)' },
          intent: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 }, description: 'Words that describe when to use it' },
          verify: { type: 'object', description: 'Optional success check' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '列出已保存的站点技能', arguments: { action: 'list' } },
        { title: '把刚才的多步流程存成技能', arguments: { action: 'save', title: '按 SKU 查库存', intent: ['库存', '查货'] } },
      ],
    },
    {
      name: 'browser_handoff',
      mcpName: 'mova_browser_handoff',
      label: '交给用户接管',
      mcpSummary: '暂停并让用户接管浏览器（银行卡/扫码支付/验证码/2FA/必须本人做的选择），最长等 10 分钟。',
      description: 'Pause and let the user take over the browser for bank-card details, QR-code or payment-code steps, '
        + 'CAPTCHA, 2FA, login credentials, or a decision you must not make. Ordinary purchase and checkout clicks do '
        + 'not need this. Waits until the user resumes or cancels (up to 10 minutes). Always take a fresh snapshot after '
        + 'resuming.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: HANDOFF_TIMEOUT_MS,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['login', 'captcha', '2fa', 'payment', 'consent', 'choice'] },
          note: { type: 'string', maxLength: 300, description: 'One short sentence telling the user what to do' },
          space: { ...SPACE },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      examples: [
        { title: '让用户自己过验证码', arguments: { reason: 'captcha', note: '请在浏览器里完成验证码' } },
      ],
    },
    {
      name: 'browser_screenshot',
      mcpName: 'mova_browser_screenshot',
      label: '页面截图',
      mcpSummary: '截取当前可见页面或整页；成功后落盘为内联缩略图并返回尺寸。',
      description: 'Capture the visible page (or the full page). Only works while the side browser is visible; if it '
        + 'fails with tab-not-visible, open the browser panel first.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: true,
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['none', 'thumb', 'viewport', 'full'], description: 'Default viewport' },
          includeInResult: { type: 'boolean', description: 'Attach the image to the tool result' },
          reason: { type: 'string', maxLength: 80, description: 'visual-check | canvas | diff-empty | user-request' },
          fullPage: { type: 'boolean', description: 'Legacy alias for mode=full' },
          space: { ...SPACE },
        },
        additionalProperties: false,
      },
      examples: [
        { title: '截一张当前视口', arguments: { mode: 'viewport', reason: 'user-request' } },
      ],
    },
    {
      name: 'browser_pointer',
      mcpName: 'mova_browser_pointer',
      label: '网页鼠标操作',
      mcpSummary: '按归一化坐标在上一张截图里点击或拖拽（0–1，左上角为原点）。',
      description: 'Click or drag inside the last viewport screenshot. Use its viewId and normalized coordinates: '
        + '(0,0) is top left and each axis ranges from 0 to less than 1. Take a fresh screenshot after the operation.',
      risk: 'exec',
      approval: EXEC_APPROVAL,
      exposure: onDemand,
      timeoutMs: 30_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'drag'] },
          viewId: { type: 'string', minLength: 1, maxLength: 120 },
          x: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          y: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          endX: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          endY: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
          space: { ...SPACE },
        },
        required: ['action', 'viewId', 'x', 'y'],
        additionalProperties: false,
      },
      examples: [
        { title: '点截图正中间的按钮', arguments: { action: 'click', viewId: 'view-3', x: 0.5, y: 0.5 } },
      ],
    },
    {
      name: 'browser_tabs',
      mcpName: 'mova_browser_tabs',
      label: '标签页',
      mcpSummary: '列出 Mova 控管着的浏览器标签页、当前活动页，或新建/切换/关闭一个标签页。',
      description: 'List the browser tabs controlled by Mova and which one is active.',
      risk: 'read',
      approval: READ_APPROVAL,
      exposure: onDemand,
      timeoutMs: 20_000,
      supportsProgress: false,
      imageOutput: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
          tabId: { type: 'string', maxLength: 120, description: 'Target tab for select/close' },
          url: { type: 'string', maxLength: 4_000, description: 'URL for new' },
          space: { ...SPACE, description: 'Space id for new (defaults to the active space)' },
          background: { type: 'boolean', description: 'Create without switching the visible Space' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      examples: [
        { title: '看看现在开了哪些标签页', arguments: { action: 'list' } },
        { title: '后台新开一个标签页', arguments: { action: 'new', url: 'https://example.com', background: true } },
      ],
    },
  ],
});
