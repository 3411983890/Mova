# Mova 浏览器提速与计时实施方案（主程序 + Edge 插件）

> 对应需求清单：P0 端到端计时与超时语义、P0 批处理/已验证流程、P1 导航即观察、P1 条件等待、
> P1 Edge 批处理重复观察、P2 按需页面树与 iframe。
> 落地日期：2026-11-13。所有改动都在主程序（`electron/`）与 Edge 插件（`edge-extension/`）内，没有新增依赖。

---

## 0. 一句话结论

浏览器的「慢」主要不在点击，而在**模型往返次数**和**重复采集**。
本轮把这两件事变成可测量、可约束的机制：

| 优先级 | 改动 | 主要收益 | 验证指标 |
| --- | --- | --- | --- |
| P0 | 端到端计时账本 + 超时/未确定语义 | 找到真正瓶颈，避免盲目重试 | `modelMs / toolActiveMs / humanMs` 分开统计 |
| P0 | 批处理与已验证流程引导 | 往返次数下降 | 工具调用次数、`recipe` 使用、任务成功率 |
| P1 | `browser_navigate` 直接返回观察结果 | 常见流程少一次往返 | `timing.observationMs`、总调用数 |
| P1 | 固定等待 → 条件等待 | 多步机械执行变快 | 每步 `settleMs`、批处理 `ms` |
| P1 | Edge 批处理观察去重 | 扩展通信与整树序列化下降 | 观察命中率 `hitRate`、单批采集次数 |
| P2 | 按需页面树 + iframe | 复杂页面采集与上下文成本下降 | `chars`、`frames` 索引、`ref` 子树 |

---

## 1. P0：端到端计时

### 1.1 账本（`electron/browser/timing.cjs`）

一轮对话一份账本，四类 span：

| 类别 | 记录点 | 说明 |
| --- | --- | --- |
| `model` | `chat-agent.mjs` 订阅 agent 事件：`turn_start` → 该轮 assistant 的 `message_end` | 一次模型调用一段，不是「整轮墙钟」 |
| `tool` | `browser/tools.cjs` 的 `measured()`、`edge-bridge.cjs` 的 `makeTool()` | 每个 `browser_*` 工具调用一段，失败也记 |
| `human` | `tools.cjs` 的审批等待、`browser_handoff`；Edge 侧由同一工具层记录 | **嵌套在 tool span 内**，因此 summary 额外给出 `toolActiveMs = toolMs - humanMs` |
| `edge` | `edge-bridge.cjs` 的 `dispatch()` | 扩展通信往返，诊断「双程通信」成本 |

`summary()` 输出：

```json
{
  "wallMs": 12400, "modelMs": 7200, "toolMs": 4100, "humanMs": 1500,
  "toolActiveMs": 2600, "edgeMs": 0, "otherMs": 400,
  "modelCalls": 4, "toolCalls": 7, "humanWaits": 1,
  "unknown": 1, "timeouts": 0,
  "slowest": [{ "category": "tool", "name": "browser_batch", "ms": 2400 }],
  "spans": [ ... 最近 40 条 ... ]
}
```

- `otherMs = wall - model - tool`：既不是模型也不是工具的空档（渲染、收尾、排队）。
- 人工等待若意外落在工具之外，单独记成 `humanOutsideToolMs`，不会虚报工具净耗时。

### 1.2 落盘与查看

- `electron/browser/timing-log.cjs`：每轮一行 JSONL，`userData/browser/timing/timing-YYYY-MM-DD.jsonl`；单文件 2 MB 上限、保留 7 天、串行写入、失败只提示一次。
- `electron/model-ipc.cjs` 通过 `runChatAgent({ onTiming })` 拿到 summary 后落盘；**不进入对话事件流**，避免聊天记录被计时数据撑大。
- 查看：`node scripts/browser-timing-report.cjs [--limit 50] [--dir <path>]`
  输出「墙钟 / 模型 / 工具净 / 人工 / 扩展」表格、占比、合计与最慢 span。

### 1.3 超时与「未确定结果」语义

`classifyFailure()` 把错误码翻译成稳定语义，工具结果里新增 `outcome` 字段：

| outcome | 含义 | 典型 code | 模型应该做什么 |
| --- | --- | --- | --- |
| `unknown` | 副作用可能已发生，结果未确认 | `action-timeout`、`batch-timeout`、`action-result-unknown`、`commit-state-unavailable` | **先观察页面，不要重发动作** |
| `timeout` | 超时但没有写入副作用 | `navigation-timeout`、`wait-timeout`、`edge-command-timeout`（只读）、`download-timeout` | 确认状态后重试或换条件 |
| `denied` | 策略/用户拒绝 | `blocked-by-policy`、`requires-handoff` | 交给用户，不绕过 |
| `cancelled` | 本轮已取消 | `cancelled`、`interrupted` | 重新核对状态 |
| `failed` | 确定失败 | `stale-element`、`preview-changed` 等 | 修正参数/重新快照 |

配套修复：

1. `controller.act()` 超时后**不再让页面动作和下一个动作重叠**：超时的内部 promise 记到 `target.ghost`，下一个动作先等它收尾；同时给错误打 `indeterminate: true` 和明确建议。
2. `batch.cjs` 超时**不再丢弃已完成步骤**：返回 `ok:false, code:"batch-timeout", outcome:"unknown", partial:true, timedOutAt, finished/expected` + 末尾快照，模型只补做剩下的步骤。
3. Edge `dispatch()` 的写操作超时改用 `action-result-unknown`（原来对写操作也是 `edge-command-timeout`），并明确「先读页面、避免重复提交」。
4. 工具失败 JSON 统一带 `outcome / indeterminate / suggestion`，中文建议直接说明下一步。

---

## 2. P0：批处理与已验证流程

- `browser_batch` 描述改为「默认的机械执行方式」：一步能确定的 2 个以上动作就放进一次调用；30 步上限；末尾只有一份 diff；超时返回 partial。
- 步骤里的等待可省略 `for`：`{op:"wait", selector:"#done"}` 自动推断成 `selector`。
- `browser_navigate` 返回的 `skills[]` 增加 `successRate` 与 `avgMs`（`procedures.cjs`），模型能判断「这条已验证流程值不值得重放」；重放仍是 `browser_batch({recipe, inputs})`。
- 系统提示词（`chat-agent.mjs`）新增 5 条速度规则，按影响排序：批处理 → 复用技能 → 只观察一次 → 条件等待 → 读 `outcome`。

验证：同一任务对比「工具调用次数 / 模型调用次数 / `recipe` 使用」，用 `browser-timing-report.cjs` 的 `调用` 列（toolCalls/modelCalls）。

---

## 3. P1：导航直接返回观察结果

`controller.navigate(url, space, { observe })`：

- `observe` 默认 `auto`：等 `settle`（最长 3 s）后取一次快照，返回 `observation: { mode, text, chars, settled, frames? }`。
- `observe:"full"` 强制全量；`observe:"none"` 跳过（已知页面、马上要操作时更快）。
- 返回值同时带 `timing: { loadMs, observationMs }`，可以直接看出「加载占多少、观察占多少」。
- 批处理里的 `navigate` 步骤支持 `observe:true`，把观察并进这一步。

兼容性：`browser_navigate` 的旧调用方式不变，只是结果多了 `observation`；不需要观察时显式传 `observe:"none"`。

### 3.1 Edge 侧的同类合并

Edge 插件没有 `navigate`，对应的「导航后看一眼」发生在授权/打开标签之后：

- `browser_group_tabs`（`authorize`/`select`）默认带回 `observation`（`observe:false` 可关）；
- `browser_open_tab` 在 full 档自动绑定成功（`requiresAuthorization:false`）时同样带回 `observation`；
- 两者都会先 `wait {for:"settle"}` 再取快照，并把结果写进观察缓存，紧接着的动作可以直接复用这份基线。

---

## 4. P1：固定等待 → 条件等待

### 4.1 新增条件（`electron/browser/wait.cjs`）

| `for` | 判定 | 替代的固定等待 |
| --- | --- | --- |
| `settle` | DOM 静默 `quietMs`（默认 150）+ 无运行动画 + 图片加载完 + 非 `loading` | 「点完等 300 ms」 |
| `idle` | `settle` + 字体不再 `loading` | 「等页面加载完」 |
| `animation` | 指定元素（或整页）没有运行中的动画 | 下拉/抽屉/过渡后的等待 |
| `frame` | iframe 内容文档 `complete`；可用 `selector` 也可用快照里的 `frame:"f1"`；跨域时返回 `crossOrigin:true` | 「等 iframe 加载」 |
| `download` | 主进程下载事件进入终态（`completed/blocked/failed`） | 「点下载后等 8 s」 |

`for:"time"` 仍保留（上限 2000 ms），结果带 `hint:"prefer-conditional"`。

### 4.2 替换点

| 位置 | 原来 | 现在 |
| --- | --- | --- |
| `target.act()` | `setTimeout(120)` 后取 diff | `wait({for:'settle', quietMs:100, timeout:1200})`，动画不停也不失败（`settled:false`），并输出 `timing:{actionMs,settleMs,snapshotMs}` |
| `batch.cjs` | 模型写 `for:"time"` 就真睡 | 先试 `settle`（超时 = 4×ms，最多 15 s），页面一直在动才退回真实延时 |
| `controller.login()` | 提交后固定 `200 ms` | `waitForLoad` + `settle` |
| `edge-bridge` 计划提交 | 重试循环里 `setTimeout(120)` | `page('wait', {for:'settle'})` |
| Edge `wait` 轮询 | 250 ms | 120 ms |

保留的两个 20 ms 延时是「协议 tick」（等 `will-download` 事件到达），不是页面等待，已在代码里注明。

---

## 5. P1：Edge 批处理观察去重

### 5.1 问题量化

旧流程每一步动作都是三次跨进程采集：

1. `preview`（目标校验 + ticket）
2. `snapshot {mode:"full"}`（整棵控件树）
3. `act` 之后 `snapshot {mode:"diff"}` + `form_summary`（扫全页表单）

6 步批处理 ≈ 18 次采集，其中只有「动作后的那一次」有信息量。

### 5.2 改动

- `edge-extension/page.js`：新增页面版本号 `state.version`，每次 `act` +1；`snapshot` 结果返回 `{version, url}`；扩展侧 `run()` 附带 `documentId`。
- `electron/edge-observation.cjs`：以 `(documentId, url, version)` 为键缓存观察结果，TTL 2.5 s；命中/未命中/过期/失效都计数（`hitRate`、`reusedMs`）。版本变了旧观察自然失效，导航（documentId 变）也不会串页。
- `edge-bridge.cjs`：
  - 动作前只在**没有基线**时取一次全量快照（`ensureBaseline`），不再每步都取；
  - 动作后一次 diff 同时给出「改了什么」和「新版本号」；`form_summary` 同版本只取一次；
  - 批处理中间步骤 `observe:"none"`（照做、不观察），最后一步观察一次；末尾快照直接复用刚拿到的结果（`batchSnapshot`，1.5 s 内）；
  - `browser_plan` 提交同样只在结束时统一观察。

### 5.3 效果

一次 6 步批处理从「18 次采集」降到「1 次基线 + 1 次 diff + 1 次表单摘要 = 3 次」；
每一步仍然保留「动作后立刻 diff」，所以 refs 不会因为跳过快照而失效。

验证：观察缓存单测 `electron/edge-observation.test.cjs`；运行期看 `edgeBrowser.observations.summary()` 的 `hitRate`。

---

## 6. P2：按需页面树与 iframe

### 6.1 主程序（CDP/AXTree）

`electron/browser/snapshot.cjs`

- `frames` 三档：
  - `none`：完全不看 iframe；
  - `index`（默认）：只列 `iframe f1 "url"`，正文用 `frames:"f1"` 按需取；
  - `all`：旧行为（内联全部）。
- `frame:"f1"`：只抓这一个 iframe，主文档不再重复采集；跨域时明确返回「cross-origin，无法读取」而不是空内容。
- `ref:"@e12"`：只采集该节点子树（大表格/长列表按需展开），`ax-compact.cjs` 新增 `rootRef`/`parseRef`。
- 兼容：`scope:"main"` 仍等于 `frames:"none"`。

`browser_snapshot` 参数新增 `frames / frame / ref`，结果带 `frames[]`、`scope`、`truncated`。

### 6.2 Edge 插件（内容脚本）

`edge-extension/page.js` 同语义：

- `frames:"index"` 只列 `iframe f1 "src" [cross-origin?]`，`frames:"all"` 才展开同源文档；
- `frame:"f1"` 读取指定 iframe（用上一份快照建立的 `state.frames` 索引），跨域明确说明；
- `ref:"@eN"` 只展开该元素子树（首行标出元素本身）；
- 快照结果带 `version`，供上一节的观察去重使用。

工具层（`edge-bridge.cjs`）把 `browser_snapshot` 的参数枚举扩充为 `frames/frame/ref`。

验证：`electron/browser/snapshot.test.cjs`（索引 / 全量 / 单 frame / 跨域 / ref 子树），
`tests/edge-browser-regressions.test.mjs`（插件侧回归）。

---

## 7. 改动文件清单

新增：

| 文件 | 作用 |
| --- | --- |
| `electron/browser/timing.cjs` | 计时账本 + 失败语义分类 |
| `electron/browser/timing-log.cjs` | JSONL 落盘/轮转/读取 |
| `electron/edge-observation.cjs` | Edge 观察结果去重缓存 |
| `scripts/browser-timing-report.cjs` | 计时报表（模型/工具/人工拆分） |
| `electron/browser/timing.test.cjs`、`timing-log.test.cjs`、`wait.test.cjs`、`snapshot.test.cjs`、`target.test.cjs`、`tools.test.cjs`、`electron/edge-observation.test.cjs`、`tests/edge-page-frames.test.mjs` | 单测（41 条，覆盖计时口径、超时语义、条件等待、按需 iframe、观察去重） |

修改：

`electron/browser/{controller,target,wait,batch,snapshot,ax-compact,tools,procedures}.cjs`、
`electron/{edge-bridge,model-ipc}.cjs`、`electron/chat-agent.mjs`（含 Edge 专用提示词）、
`edge-extension/{page.js,bridge.js}`、`electron/browser/batch.test.cjs`。

---

## 8. 验证清单

```powershell
# 1) 单测（新增 8 个测试文件）
node --test electron/browser/timing.test.cjs electron/browser/timing-log.test.cjs `
  electron/browser/wait.test.cjs electron/browser/snapshot.test.cjs `
  electron/browser/target.test.cjs electron/browser/tools.test.cjs `
  electron/browser/batch.test.cjs electron/edge-observation.test.cjs `
  tests/edge-page-frames.test.mjs

# 2) 回归（现有插件/技能/边栏用例）
node --test tests/edge-browser-regressions.test.mjs tests/skills-mode.test.mjs

# 3) 计时报表（跑过一轮真实浏览器任务后）
node scripts/browser-timing-report.cjs --limit 20

# 4) 构建 Edge 插件
npm run build:edge
```

人工验收要点：

1. 同一任务连续跑两次，`browser-timing-report` 里 `toolCalls / modelCalls` 应下降（批处理生效）。
2. 打开一个带 iframe 的页面：`browser_snapshot` 默认只列 `iframe f1`，`{frames:"f1"}` 拉取内容，`chars` 明显小于旧版。
3. 触发一次动作超时（把动作超时设置调到很小）：结果里出现 `outcome:"unknown"`，且模型下一步先 `browser_snapshot` 而不是重发点击。
4. Edge 侧 6 步批处理：观察缓存 `hitRate` > 0，批处理 `ms` 与扩展 span 数量下降。
5. 下载：`browser_wait {for:"download"}` 在下载完成/被阻止时立即返回，不等满超时。

---

## 9. 权限口径修订（2026-11-13）：只拦「本人才能完成」的动作

按用户要求放宽：正常的「立即购买 / 下单 / 结算 / 支付按钮」不再停手，只有明确需要用户本人持有的东西才交还用户。

### 9.1 两个概念分开（`electron/browser/policy.cjs`）

| 概念 | 含义 | 处理 | 命中示例 |
| --- | --- | --- | --- |
| `handoff`（L4） | AI 拿不到、也不该代填 | **停下**，工具返回 `requires-handoff`，模型必须 `browser_handoff` | 卡号/银行卡号/持卡人/CVV/安全码/添加或绑定银行卡；扫码支付/付款码/二维码支付；密码/支付密码/短信验证码/动态码/OTP/captcha |
| 不可逆（L3） | 可做，但先确认 | 审批一次（不参与「本会话允许」复用） | 删除/注销/解绑/清空/转账/汇款/提现；`submit:true`；Enter；未知动作 |
| 正常购物（L2） | 直接做 | 不额外确认（仍受授权等级与「每站点首次确认」约束） | 支付/付款/购买/下单/提交订单/结算/立即购买/加入购物车/checkout/pay |

细节：

- `忘记密码 / 找回密码 / 修改密码 / 密码登录` 只是入口按钮，不算 L4；真正输入密码的字段仍然是 L4。
- 选择器里的写法也认：`#card-number`、`credit_card_number`、`#password`。
- 判断函数：`handoffReasonOf(text)` 返回 `card-entry | qr-payment | credential`；`classifyAction()` 额外返回 `handoff` 与 `handoffReason`，审批卡文案由 `handoffLabelOf()` 生成中文说明。

### 9.2 落地位置

| 位置 | 改动 |
| --- | --- |
| `tools.cjs` `authorize()` | 命中 handoff 立即抛 `requires-handoff`（不再走审批后照做），并提示调用 `browser_handoff`；审批 payload 附带 `handoff/handoffReason` |
| `target.pointer()` | 画布坐标命中的标签改用 `handoffReasonOf()`，普通「立即购买」画布不再拒绝 |
| `edge-bridge.cjs` | `requiresHandoff`（act / 计划预演）与指针操作改为只看 `classifyAction(...).handoff`，`submit` 不再单独触发停手；Edge「自动」档位对等级 ≤2 的普通交互（含买/下单/支付按钮）不再逐次弹审批，等级 3 与 handoff 仍然询问/停手 |
| `chat-agent.mjs` | 免确认档位的高风险判断改为「`handoff` 或等级 ≥ 3」，购买词不再触发额外审批；App 与 Edge 两套提示词同步说明「买/下单/支付按钮是正常工作，只有银行卡、扫码支付、密码验证码才交还用户」 |
| `browser-settings.jsx` | 设置页文案改为「购买与下单按等级放行；删除、转账等不可逆动作每次确认；银行卡/扫码支付/密码验证码停下交给用户」 |
| `edge-extension/page.js` | 银行卡/密码/验证码字段的拒绝文案说明「需要本人填写」 |

### 9.3 验证

```powershell
node --test electron/browser/policy.test.cjs electron/browser/tools.test.cjs electron/browser/settings.test.cjs
```

- `policy.test.cjs`：`立即购买/确认支付/提交订单/Buy now/Place order` 均为 L2 且 `handoff=false`；`卡号/持卡人/CVV/扫码支付/付款码/短信验证码/密码` 均 `handoff=true` 且原因码正确；`删除/注销/转账` 为 L3 但不停手；`submit` 仍升级。
- `tools.test.cjs`：「立即购买」执行且不弹审批；卡号/扫码支付/密码被拦下并提示 `browser_handoff`（动作未执行）；删除账号即使关掉每站点确认仍会询问。

> 仍保留的停手项：CAPTCHA、2FA、密码与验证码。这些不是「权限」问题，而是 AI 没有这些信息；如需进一步放宽，应改为「交还用户但自动继续」而不是让 AI 代填。
