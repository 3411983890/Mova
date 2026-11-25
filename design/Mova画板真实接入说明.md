# Mova 设计画板：程序接入

2026-11-13。本文件记录桌面程序里的真实实现；`canvas.html` 继续作为独立布局原型保留。

入口：应用左侧活动栏的画板图标。设置：设置 → 集成 → 设计。

## 已接入

- 使用 `@open-pencil/core` / `@open-pencil/vue` 0.16.0 的实际 SceneGraph、Skia/CanvasKit 渲染、选区、拖动、尺寸调整、钢笔、文字输入、布局和撤销历史。
- 画板是右侧浏览器面板的第三种视图：浏览器网页、文件查看器和设计画板共用同一块 `.browser-stage` 与同一套顶栏，画板不再是并列的独立面板。打开画板会切到画板视图并适当加宽面板；在画板里打开任何链接、地址或文件引用都只把这块视图切回浏览器，不新开窗口。画板视图的顶栏复用浏览器工具栏的组件与尺寸（`browser-toolbar` / `browser-nav-group` / `browser-icon-button` / `browser-address`，43px、23px 圆形按钮、药丸地址栏）：左侧圆形胶囊是撤销、重做、页面与图层、**选取元素**四个按钮，中间地址药丸「设计画板」只显示位置、内部不放按钮，**播放**单独占药丸右侧一个圆形按钮；**没有关闭按钮**，关闭统一走聊天顶栏的面板开关。
- 选取元素（左侧胶囊第四个按钮，`cursor-click` 字形，和浏览器工具栏的选取按钮同一个图标）：点一下进入选取态（光标变十字），再点画板上的图层，该图层就以「画板图层 名字 · 类型 图层 id …」的形式引用到输入栏，附带位置、尺寸、填充、圆角、旋转、自动布局与文字摘要；Esc 取消。引用走的是聊天既有的 `mova:quote-to-chat`，与网页元素引用同一条通道，模型用 `design_read` 拿 `nodeId` 就能读细节。
- 侧栏关着时，点聊天顶栏的面板开关会先弹出视图选择：内置浏览器 / 内置画板 / 资源管理器；选完才进入对应视图。侧栏开着时同一个按钮就是关闭。资源管理器复用现有文件视图，回到上次看过的文件位置（没有记录时提示先打开一个文件）。
- 底部工具按 OpenPencil 的 3/4 等比缩小：栏高 30px、按钮 24px、图标 12px、圆角 9px、内边距 3px，深色 `#2a2a2a`。八项为移动、画板、矩形、钢笔、文字、抓手、评论、插入图标；画板（画板/分区）与矩形（矩形/直线/椭圆/多边形/星形）带弹出的二级菜单（定宽 168px，选中项灰底、快捷键右对齐）。插入图标按钮目前只给出提示，未接入图标库。
- 页面与图层：点击顶栏图标从画布左侧弹出 232px 面板，只保留 Pages 与 Layers 两块。页面支持新增、切换、双击重命名；图层树 24px 行高、16px 缩进、按类型换图标（画板/自动布局/组件/实例/文字/分组…），行内可锁定与显隐，蓝底为选中行。
- 无限画布的背景是小点矩阵，随缩放改变点距、随平移改变原点，点位于画布元素之下，不会压在画板上。引擎原本用不透明页面色清屏，`scripts/open-pencil-vite.mjs` 在构建时让清屏沿用页面色的 alpha，画布因此可以透明；`refresh()` 把 `pageColor` 的 alpha 保持为 0，页面切换或载入文档后仍然透明。
- 右侧属性面板按 OpenPencil 的 `PanelSection`/`PanelField`/`PanelGrid` 复刻，选中即出现，244px 并挤占画布而非覆盖：视图 15px 文字、11px 分区标题、24px 字段、6px 栅格间距，深色 token 与 OpenPencil 一致（面板 `#2a2a2a`、字段 `#383838`、描边 `#3a3a3a`、文字 `#f0f0f0`）。内容从对象标题（名称 + 关闭按钮）开始，依次是画板尺寸预设、位置、布局/自动布局、外观（圆角与圆角平滑同一行）、填充、描边、效果、布局参考线、导出；不出现 Design/Code/AI 行与分享行。菜单里当前值用字段灰底标出，与控件本身同一灰色。
- 位置、大小、圆角、不透明度、混合模式、填充、描边、效果、布局模式/方向/对齐/间距/内边距、裁剪内容、蒙版、锁定与显隐直接写入引擎节点并进入撤销历史；翻转、独立内边距、导出设置与插入图标尚未接入，按钮保持可见但不可用或只给提示。
- AI 通过真实聊天代理获得六个工具：`design_read`（页面、选区、图层树，并可用 XPath `query` 过滤，如 `//TEXT`、`//FRAME[@width < 300]`；读取包含结构、文字、坐标、尺寸、颜色及布局信息）、`design_apply`、`design_undo`、`design_fonts`、`design_screenshot`、`design_open`。工具执行后回传真实图层 ID 和版本；聊天显示执行状态。`design_open` 把右侧面板切到画板视图并把文档载入——画板、浏览器和文件查看器共用一块面板，AI 改了看不见的像素没有意义，所以它动手前可以先把画板摆到用户眼前。
- `design_apply` 转发到 `@open-pencil/core` 自己的工具层，不再是手写适配器：`import_svg`、`insert_icon`、`export_image`、`query_nodes`、`list_available_fonts`、`get_font_status`。转发口是 `src/features/design/design-tools.js` 里的白名单，`eval_code`、`calc`、图库素材、变量、路径与布尔运算这类危险工具不在表内；`fills`/`strokes`/`effects`/`layout`/`text` 这些属性子结构另由 `src/features/design/design-node-spec.js` 的严格 schema 校验。core 的 `render`（JSX）**没有**接入：应用的内容安全策略禁用 `eval`，JSX 无法执行，`jsx` 与 `render` 动作已移除并给出明确理由，结构一律用 `create` 的嵌套 `children` 表达。
- 五个 `action`：`create` / `update` / `delete` / `svg` / `icon`。`create` 支持 FRAME、RECTANGLE、ELLIPSE、TEXT、LINE、STAR、POLYGON、SECTION、COMPONENT；VECTOR 与 GROUP 直接拒绝，并提示改用 `svg` / `icon`。
- 自动布局可精确控制尺寸：`layout.sizing.horizontal/vertical` 取 `FIXED|HUG|FILL`，显式给了 `width`/`height` 的容器在开启自动布局后仍保持该尺寸（需要随内容收缩时把对应轴设为 `HUG`）。读回同样带 `layout.sizing`，因此「设了 300 宽却变成 94」这类问题不用再猜。
- 可写字段：`fills[]`（纯色、自定义停靠点与角度的线性渐变、图片）、`strokes[]`、`effects[]`（投影/内阴影、图层/背景模糊）、`opacity`、`rotation`、`cornerRadius`、`layout`，以及 `text` 对象的 `fontFamily`、`fontSize`、`fontWeight`、`lineHeight`、`letterSpacing`、`align`、`autoResize`。图片填充分两条：`base64`/`dataUrl` 直接建图（校验大小与文件头，4 MB 上限），`imageHash` 只用于复用文档里已有的图；伪造的 hash 在写入时就报 `invalid_value`，不会静默画出空白。SECTION 默认建成半透明区域，不覆盖用户显式给的填充。
- 逐条容错：一条坏操作不再作废整批。回复里的 `created[]`/`applied[]`/`failed[]` 逐条对应操作，`failed[]` 带 `code`，未知键报 `unknown_field` 并列出该子结构允许的键，模型只补失败的那几条。未知字段一律报错而不是静默丢弃，这是旧适配器最有害的行为。一次 `design_apply` 仍是一步撤销，记录由 `editor.captureDocumentChange` 按实际改动生成，不复制整页快照。
- `design_screenshot` 在模型能看图时把 PNG 作为图片块回传，否则只回尺寸与节点元数据；`design_fonts` 枚举真实可用族名，`fontFamily` 在写入前校验，`sans-serif` 这类通用族名直接拒绝——CanvasKit 没有 CSS 通用族语义，这种文字根本不画。未指定字体时保留引擎默认 Inter，本机中文字体作为渲染 fallback，兼容既有微软雅黑文字和画布标题。
- 读取回传 `fills`（含渐变读回的角度）/`strokes`/`effects`（含颜色 alpha）/`opacity`/`rotation`/`layout`（含 `sizing`）/`lineHeight`/`letterSpacing`/`textAlign`/`autoResize`，并给出渲染器 `blocked` 节点列表（渲染时整节点跳过的图层）与 `substituted` 替代字体；「写入成功」因此可以核对成「确实画出来了」。字体报告默认只带可信信号（`issues`、`blockedCount`、`summary`），完整状态只在检出缺字/跳过节点时，或显式传 `fonts: true` 时回传——正常文档的一次读取因此不会再被上千 token 的字体状态占满。同族的「字重替代」单独计入 `styleSubstituted`，不再让正常渲染的文字看起来像坏掉了。
- 每个对话独立文档，保存到应用用户数据目录的 `design/`，包含图层、图片数据、变量和当前页。保存校验版本，并通过临时文件替换；新聊天草稿转为正式聊天时迁移文档。项目改名同步迁移已载入会话对应文档。
- 手动编辑先保存，再处理 AI 请求；渲染端串行执行 AI 操作，批次执行期间暂停手动修改，避免异步字体加载与用户操作交错。
- 设置页复用《Mova设置页设计规范》的骨架、卡片、行、色阶、内容列和开关。提供画板开关、AI 编辑开关、引擎信息、模型来源与保存说明，设置真实落盘。关闭 AI 编辑后，`design_read`/`design_fonts`/`design_screenshot` 与手动编辑仍可用，只有 `design_apply`/`design_undo` 被拒绝。
- 临时聊天不提供设计工具，也不打开持久化画板。Edge 浏览器模式不提供本机画板工具。设计模型沿用当前对话，需支持工具调用。

## 验证

- `npm run build`：打包实际编辑器、CanvasKit WASM、字体和许可文件。
- `npm run typecheck`。
- `node --test tests/design-runtime.test.cjs tests/temporary-chat.test.mjs tests/chat-send-contract.test.mjs tests/agent-prompt.test.mjs`。只读的 `read`/`fonts`/`screenshot` 不再要求 AI 编辑权限，`apply`/`undo` 仍然要求，因此这些用例照旧通过。
- `scripts/design-integration-smoke.cjs`：Electron 中运行实际聊天代理；使用模型流响应夹具依次调用读取、创建、复读，实际渲染中文画板；验证修改、撤销、逐条容错、权限撤销、重载与持久化。模型响应使用夹具，不调用收费服务。
- `scripts/design-app-smoke.cjs`：启动完整 Mova 主进程，通过真实 mova:// 协议、内容安全策略、preload 和设置页修改开关；真实鼠标绘制画框，验证属性栏与落盘。
- `scripts/design-ui-check.cjs`：同一主进程里逐项截图核对新界面——画板挂载在 `.browser-canvas` 内、顶栏高度 43px、底栏 8 个工具/30px/24px 按钮/12px 图标、属性面板 244px 与分区顺序；并验证在画板里提交网址后视图切回浏览器（画板隐藏、浏览器工具栏恢复、顶部不再弹红色提示条）、再点画板图标回到同一块画板且画布仍就绪；另验证顶栏没有关闭按钮、选取与播放都在地址药丸内、点选图层产生一条 `kind=element` 引用、以及侧栏关闭时面板开关弹出 web/canvas/file 三项并能进画板。
- `scripts/design-tools-check.cjs`：Electron 真机逐项验证 `design_open`、字体枚举、渐变/描边/阴影/透明度/旋转/排版的写入与读回、逐条失败隔离、通用族名拒绝、截图的 PNG 魔数、XPath 查询与整批撤销。

## 与旧适配器的差别

旧行为取自《openpencil-mcp-优化方案》§1 的实测记录，新行为取自 `design-tools.js`、`design-node-spec.js` 与契约 §13.1 的验证口径。

| 项目 | 旧适配器 | 现在 |
|---|---|---|
| 图元与字段 | 4 种 × 14 字段 | 9 种，另有 `svg`/`icon` 两条旁路 |
| 未知字段 | 静默丢弃 | 报错，并列出允许的键 |
| 一条坏操作 | 整批回滚 | 逐条失败，其余照常生效 |
| 视觉回读 | 没有 | `design_screenshot` 回 PNG |
| 字体 | 无枚举，靠猜族名 | `design_fonts` 枚举 + 写入前校验 |
| 渐变/描边/阴影/旋转 | 不落库 | 写入并读回 |
| 撤销粒度 | 整页快照 | 按实际改动的单步 |

## 当前边界

中文字体修复：启动前向 Skia 注册并验证 CJK 字形，标签和文字共用 fallback；Windows 字体目录来自系统配置，常规、粗体、细体按实际文件加载并缓存，雅黑不可用时尝试黑体、宋体。重新打开文档先准备全部文字字重，并清除旧文字渲染图片缓存；更新文字不覆盖已有字体选择。`design_read` 返回实际渲染段落的缺字报告，最多检查 200 项，可指定 nodeId 分段检查。`tests/design-font-render.test.mjs` 先复现无 fallback 的缺字，再验证修复后的标签、正文、粗体及新渲染器。启动探测现在按族记录结果（`fontBootReport`），随 `design_read` 和 `design_fonts` 一起回传；全族失败时仍拒绝启动面板，但报错逐个点名该族是 未安装 还是 安装但无中文字形，并说明字体文件被裁剪或损坏的可能。

这是可真实编辑、可被 AI 操作的首版设计集成。AI 操作覆盖基础界面图层，暂未提供专门的图片生成、Figma 文件导入、组件库发布或 HTML 应用导出工具。播放调用 OpenPencil 现有播放能力，完整交互原型还需要配置组件行为。界面生成效果取决于当前模型的设计与工具调用能力。

AI 文档限 5,000 个节点、8 MB，一次 `design_apply` 最多 200 项操作；新增节点总量受 5,000 个图层上限约束，批量中途触顶时该条记入 `failed[]`，其余照常生效。读取结果过大时需降低 depth 或指定 nodeId 分段读取（返回最多 400 个节点）。更换文档或重载后重新开始撤销历史，已保存设计内容保留。

图标默认离线：`lucide:` 前缀或内置图标名（`heart`、`home`、`settings`… 共 108 个）直接从仓库内的 Lucide 几何数据生成 SVG，再走 `import_svg` 落成本地矢量图层，不访问网络；只有其他图标集前缀（如 `mdi:home`）才走 Iconify，离线时该条操作返回 `failed[].code === "network"`。`VECTOR`/`GROUP` 创建、变量、组件、布尔与路径工具本轮尚未开放。
