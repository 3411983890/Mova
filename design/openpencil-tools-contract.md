# 画板工具面改造 · 内部契约（施工用）

> 依据：`design/openpencil-mcp-优化方案.md`（v2，路线 A + C 合并）
> 本文是**施工契约**，不是用户文档。所有子任务以本文件为准，出现分歧先改本文件。

---

## 0. 结论回顾（为什么这么改）

`design_apply` 是 Mova 手写的适配器，绕过了 `@open-pencil/core` 已有的工具层与 strict 校验：

| 现状 | 目标 |
|---|---|
| 4 种图元 × 14 字段 | 全部图元 + JSX/SVG/图标 |
| 未知字段静默丢弃 | 未知字段**报错**（P0-7） |
| 一错全批回滚 | 逐条容错 `{applied, failed}`（P0-6） |
| 无视觉回读 | `design_screenshot`（P0-1） |
| 无字体枚举 | `design_fonts`（P0-2） |
| 无渐变/图片/描边/阴影/旋转 | `fills[]` / `strokes[]` / `effects[]` / `opacity` / `rotation`（P0-3、P0-4） |
| 无 textAlign/lineHeight/letterSpacing/autoResize | `text` 对象（P0-5） |
| 只能整树读 | `design_read` 的 `query`（XPath，L3-1） |

---

## 1. 已核实的 core 能力（源码位置，勿再猜）

`node_modules/@open-pencil/core/`（dist 为 ESM，已确认导出）：

| 需要 | 可直接用的东西 |
|---|---|
| 工具执行入口 | `ALL_TOOLS` / `CORE_TOOLS` / `EXTENDED_TOOLS`（`ToolDef[]`，含 `name`、`input`、`execute(figma, args)`） |
| Figma 门面 | `class FigmaAPI`：`new FigmaAPI(graph)`、`setRenderer(renderer)`、`currentPageId`、`theme`、`getNodeById`、`createFrame/createRectangle/createEllipse/createText/createLine/createStar/createPolygon/createSection/createVector/createComponent`、`createImage(bytes)`、`loadFontAsync`、`listAvailableFontsAsync()`、`getFontStatus()`、`exportImage?`、`icons`（默认 Iconify） |
| 栅格导出 | `renderNodesToImage(ck, renderer, graph, pageId, nodeIds, { scale, format })` → `Uint8Array \| null` |
| 撤销 | editor 直接有 `captureDocumentChange()` → `() => DocumentChange`、`restoreDocumentChange(change, 'before'\|'after')`、`pushUndoEntry({label, forward, inverse})` |
| 字体 | `fontManager`（`setFallbackUserAgent` / `setCJKFallbackFamily` / `getCJKFallbackFamilies` / `loadLocalFont` / `collectFontKeys`）、`documentFontStatus` |
| 形状字段 | `SceneNode`：`fills` `strokes` `effects` `opacity` `rotation` `cornerRadius` `layoutMode` `itemSpacing` `paddingTop/Right/Bottom/Left` `primaryAxisAlignItems` `counterAxisAlignItems` `layoutSizingHorizontal/Vertical` `layoutGrow` `clipsContent` `lineHeight: number\|null` `letterSpacing: number` `textAlignHorizontal` `textAlignVertical` `textAutoResize` `constraints` `blendMode` |

`lineHeight` / `letterSpacing` **没有**任何 core 工具会写 → 直接 `figma.graph.updateNode(id, { lineHeight, letterSpacing })`，
别去翻译 `set_text_properties`（它没有这两个参数）。

---

## 2. 新增模块与文件归属（**只改自己名下的文件**）

| 文件 | 归属 | 说明 |
|---|---|---|
| `src/features/design/design-tools.js` | **A** | 新。core 工具桥。 |
| `src/features/design/design-node-spec.js` | **B** | 新。严格 schema + 字段落库。 |
| `src/features/design/design-fonts.js` | **C** | 改。字体硬化。 |
| `electron/design-runtime.cjs` | **D** | 改。工具声明。 |
| `electron/chat-agent.mjs` | **D** | 改。图片透传 + 系统提示。 |
| `src/features/design/design-editor.js` | **主控（我）** | 改。命令分发。 |
| `scripts/design-integration-smoke.cjs` | **E** | 改。期望改为逐条容错。 |
| `scripts/design-tools-check.cjs` | **E** | 新。Electron 真机验证。 |
| `design/Mova画板真实接入说明.md` | **F** | 改。 |

禁止：改 `node_modules`；改 `electron/design-ipc.cjs` 的通道名；动 `design-panel-ui.js`（本轮不涉及 UI）。

---

## 3. 模块 A：`design-tools.js`

```js
export function createDesignToolkit({ editor, getCanvasKit }) { ... }

// 返回：
{
  /** 让 figma 门面与 editor 的 graph / 当前页 / renderer 对齐；每次调用工具前都会隐式跑一次。 */
  sync(),
  /** 该工具名是否可用（白名单内）。 */
  has(name),
  /** 执行一个 core 工具；args 为普通对象，走 core 的 valibot strictObject 校验。
   *  失败抛 DesignToolError。 */
  async run(name, args),
  /** 当前 figma 门面（供 B 直接读代理节点）。 */
  figma(),
  /** 栅格导出：{ bytes: Uint8Array, mimeType } */
  async exportImage(ids, options),
}
```

**硬性要求**

1. `sync()`：
   - `figma.graph !== editor.graph` → 重建 `new FigmaAPI(editor.graph)`；重建后重挂 `exportImage`、`renderer`、`theme='dark'`。
   - `figma.setRenderer(editor.renderer ?? null)` 每次同步（renderer 可能后建）。
   - 当前页要这样同步：`FigmaAPI` **只有 `get currentPageId()` 和 `set currentPage(page)`，没有 `currentPageId` 的 setter**（直接赋值在 ESM 严格模式下抛 TypeError）。所以是
     `const page = figma.getNodeById(editor.state.currentPageId); if (page) figma.currentPage = page;`
   - `switch_page` 只动门面、不动 editor，所以 `run()` 结束后要把门面的当前页写回 `editor.state.currentPageId`，否则下一次 `sync()` 会把它悄悄改回去。
2. `exportImage` 实现：
   ```js
   figma.exportImage = async (ids, { scale, format }) => {
     const ck = await getCanvasKit();
     return renderNodesToImage(ck, editor.renderer, editor.graph, editor.state.currentPageId, ids, { scale, format });
   };
   ```
   `renderNodesToImage` 是同步函数、可能 throw；包 try/catch 转 `DesignToolError`。
   `format` 只受 `'PNG' | 'JPG' | 'WEBP'`。
3. **白名单**（`ALL_TOOLS` 里按 `name` 取，未列入的一律 `has() === false`）：

   ```
   render, import_svg, insert_icon, fetch_icons, search_icons,
   create_shape, create_page, delete_node, node_resize, reparent_node,
   group_nodes, ungroup_node, clone_node, rename_node, arrange,
   get_node, get_page_tree, find_nodes, query_nodes, get_selection,
   select_nodes, list_pages, switch_page, get_current_page, page_bounds,
   list_available_fonts, get_font_status, list_fonts,
   export_image, export_svg, export_pdf,
   update_node, set_fill, set_stroke, set_stroke_align, set_image_fill,
   set_effects, set_opacity, set_rotation, set_radius, set_layout, set_layout_child,
   set_text, set_font, set_text_resize, set_text_properties,
   set_visible, set_locked, set_blend, set_constraints,
   batch_update, describe, lint, analyze_spacing, analyze_typography, analyze_colors,
   diff_visual, diff_changes, diff_jsx, get_jsx
   ```

   **不得**列入：`eval_code`、`calc`、`stock_photo`/`pexels`/`unsplash`、`export_pdf` 之外的 codegen、`create_variable` 系列（本轮不做）、任何 `path_*`/`boolean_*`（P1，接口留着但先不进白名单）、以及整个 JSX 家族（`render` / `get_jsx` / `diff_jsx`）。
   > **JSX 为什么整体排除**：Mova 的渲染进程跑在禁用 `unsafe-eval` 的 CSP 下，core 的 `render` 要编译 JSX，到了真实应用里必然抛错（烟测页面没有 CSP，所以早期没暴露）。结构描述统一用 `create` 的嵌套 `children`；矢量用 `svg`（原始标记，走 `import_svg`，不需要 eval）或 `icon`。
   > `export_pdf` 保留在白名单里但 `design_apply` 不暴露；只有 `design_export`（见 §4.7）用。
4. `run()` 语义：
   - `sync()` → 取 `def = registry.get(name)` → `undefined` 抛 `DesignToolError('unknown_tool', ...)`。
   - `args` 必须是普通对象；`null`/`undefined` → `{}`。
   - `const value = await def.execute(figma, args)`。
   - 若返回值是对象且含 `error` 字符串 → 抛 `DesignToolError('tool_failed', value.error)`。
   - catch 里把 `Error.message` 包成 `DesignToolError('tool_failed', message)`，保留 `cause`。
5. `DesignToolError`：`class DesignToolError extends Error { constructor(code, message) { ... } this.code = code }`。导出它。
6. 不要在模块顶层 `import { ALL_TOOLS }` 之外引入重包（`pdf`/`pptx` 由 core 内部按需 `import()`，保持这样）。

---

## 4. 操作协议（`design_apply` 的 `operations[]`）

`design_apply` 输入：

```jsonc
{
  "operations": [ /* 见下，1..200 条 */ ],
  "basedOnRevision": 12        // 可选；与当前 revision 不符则整体拒绝（L3-3 乐观锁）
}
```

七种 `action`。除 `query` 外都要求 `action` 是字符串且在白名单内，否则 `failed[].code = "unknown_action"`。

### 4.1 `create`

```jsonc
{ "action": "create", "parentId": "0:3", "type": "FRAME",
  "name": "Card", "x": 0, "y": 0, "width": 320, "height": 180,
  "clipsContent": true,
  "fills": [Paint], "strokes": [Stroke], "effects": [Effect],
  "opacity": 1, "rotation": 0, "cornerRadius": 12,
  "layout": Layout, "text": Text, "children": [ ...同结构... ],
  // 矢量替代（三选一，与 type 互斥）
  "jsx": "<div .../>", "svg": "<svg .../>", "icon": "lucide:heart" }
```

`type` 取值：`FRAME | RECTANGLE | ELLIPSE | TEXT | LINE | STAR | POLYGON | SECTION | VECTOR | COMPONENT | GROUP`。
`jsx`/`svg`/`icon` 存在时忽略 `type`，改用 core 的 `render` / `import_svg` / `insert_icon`。

**向后兼容**：仍接受 `fill: "#RRGGBB"`（等价 `fills:[{type:"SOLID",color:"#RRGGBB"}]`）、`gap`、`padding`、`layoutMode`、
`fontSize`、`fontFamily`、`fontWeight`、`textAlignHorizontal`、`layoutSizingHorizontal/Vertical`。**但 `fill` 与 `fills` 同时出现 → 报错。**

### 4.2 `update`

```jsonc
{ "action": "update", "id": "1:2", "props": { ...create 里除 type/children/x/y 之外的任意字段... } }
```

`props` 允许 `x`/`y`/`width`/`height`。允许 `children: []`？**不允许**（删子节点请用 `delete`）。

### 4.3 `delete`

```jsonc
{ "action": "delete", "id": "1:2" }
```

### 4.4 `render`

```jsonc
{ "action": "render", "jsx": "<div/>", "parentId": "...", "x": 0, "y": 0, "replaceId": "1:9" }
```

→ core `render`（`replace_id` / `parent_id` / `insert_index` / `x` / `y` / `jsx`）。

### 4.5 `svg`

```jsonc
{ "action": "svg", "svg": "<svg .../>", "parentId": "...", "x": 0, "y": 0, "name"?: "...", "color"?: "#fff" }
```

→ core `import_svg`。

### 4.6 `icon`

```jsonc
{ "action": "icon", "name": "lucide:heart", "parentId": "...", "size": 24, "color": "#fff" }
```

→ core `insert_icon`（`name` 单个）。需要网络；离线时 `failed[].code = "network"`。

### 4.7 `query` / `export`

不放进 `design_apply`。查询走 `design_read.query`，导出走 `design_screenshot`。

---

## 5. Paint / Stroke / Effect / Layout / Text 子结构（**严格**）

任何未知键 → 该条操作失败，`code = "unknown_field"`，`reason` 指明是哪个键。
数值必须是有限数且 `|v| <= 100000`（尺寸/坐标），`opacity ∈ [0,1]`。

```ts
type Paint =
  | { type: "SOLID"; color: string; opacity?: number }                       // color: #RGB | #RRGGBB | #RRGGBBAA
  | { type: "GRADIENT_LINEAR"; stops: { position: number; color: string }[]  // 2..8 个，position 0..1 递增
      angle?: number }                                                       // 度，0 = 从左到右
  | { type: "IMAGE"; scaleMode?: "FILL"|"FIT"|"CROP"|"TILE" }
      & ( { imageHash: string } | { base64: string } | { dataUrl: string } );

type Stroke = { color: string; weight?: number; align?: "INSIDE"|"CENTER"|"OUTSIDE"; opacity?: number };

type Effect =
  | { type: "DROP_SHADOW"|"INNER_SHADOW"; color?: string; x?: number; y?: number;
      blur?: number; spread?: number; visible?: boolean }
  | { type: "LAYER_BLUR"|"BACKGROUND_BLUR"; blur?: number; visible?: boolean };

type Layout = {
  mode: "NONE"|"HORIZONTAL"|"VERTICAL";
  gap?: number;
  padding?: number | { top: number; right: number; bottom: number; left: number };
  align?: "MIN"|"CENTER"|"MAX"|"SPACE_BETWEEN";          // 主轴
  counterAlign?: "MIN"|"CENTER"|"MAX"|"STRETCH";        // 交叉轴
  sizing?: { horizontal?: "FIXED"|"HUG"|"FILL"; vertical?: "FIXED"|"HUG"|"FILL" };
};

type Text = {
  content?: string;                                      // 等价旧字段 text
  fontFamily?: string;                                   // 具体家族名，禁止 sans-serif / serif / monospace / inherit / system-ui
  fontSize?: number;
  fontWeight?: number;                                   // 100..900
  italic?: boolean;
  lineHeight?: number | "auto";                          // px；"auto" → null
  letterSpacing?: number;
  align?: "LEFT"|"CENTER"|"RIGHT"|"JUSTIFIED";
  alignVertical?: "TOP"|"CENTER"|"BOTTOM";
  autoResize?: "NONE"|"WIDTH_AND_HEIGHT"|"HEIGHT"|"TRUNCATE";
  color?: string;
};
```

`GRADIENT_LINEAR` 的 `angle` → `gradientTransform`。core 只有 4 个方向的两停靠渐变（`set_fill`），**不够用**：
A/B 需自己算变换矩阵。参考 `@open-pencil/scene-graph` 的 `linearGradientTransform(start, end)`（`deg` 换成两端点：

```
θ = angle°（0 表示左→右），单位正方形内
start = { x: 0.5 - 0.5*cos(θ*π/180)*?, ... }
```

**做法**：直接用 `linearGradientTransform({x:0.5 - 0.5*Math.cos(t), y: 0.5 - 0.5*Math.sin(t)}, {x:0.5 + 0.5*Math.cos(t), y: 0.5 + 0.5*Math.sin(t)})`，`t = angle*π/180`。
该函数从 `@open-pencil/core` 并未导出 → 从 `@open-pencil/scene-graph/gradient` 导入（已在依赖树中，`@open-pencil/core` 的 dependency）。

`fills` 落库：`figma.getNodeById(id).fills = [...]`（Fill 结构：`{ type, color, opacity, visible, gradientStops?, gradientTransform?, imageHash?, imageScaleMode? }`）。

---

## 6. 返回契约

### `design_apply`

```jsonc
{ "ok": true,
  "created": [{ "index": 0, "id": "1:2", "name": "Card", "type": "FRAME" }],
  "applied": [{ "index": 0, "id": "1:2", "changed": ["fills","cornerRadius"] }],
  "failed":  [{ "index": 3, "code": "unknown_field", "field": "shadow", "reason": "未知字段 shadow；允许：…" }],
  "warnings": ["…"],
  "fonts": { "ready": true, "issues": [] },
  "revision": 13 }
```

- `ok` 为 `failed.length === 0`。
- **逐条容错**：单条失败不影响其他条；单条内部失败必须回滚该条的副作用（见 §7）。
- `warnings` 必须透传 core `render` 的 `warnings`（L3-4）。

### `design_read`

```jsonc
{ "pages":[…], "currentPageId":"…", "selectedIds":[],
  "tree": {...},                 // nodeId/depth 时
  "query": { "count": 3, "nodes": […] },   // query 时
  "fonts": { "ready":true, "cjkFamilies":[], "issues":[], "checked":n, "truncated":false,
             "status": { …core get_font_status… } },
  "revision": 13 }
```

### `design_screenshot`

```jsonc
{ "mimeType":"image/png", "width":640, "height":420, "scale":1, "byteLength":12345 }
```

图片本体通过工具结果的 `image` 内容块回传（`{ type:'image', data:<base64>, mimeType }`），
文本块只放上面的元数据。模型不支持图片时，文本块要显式写「当前模型不支持看图，仅返回尺寸信息」。

### `design_fonts`

```jsonc
{ "count": 212, "families": ["Microsoft YaHei", …],          // 可选 family 过滤
  "cjkFamilies": ["Microsoft YaHei"],
  "status": { …core get_font_status… },
  "issues": [] }
```

---

## 7. 撤销与原子性（主控实现，A/B 不必重复）

每次 `design_apply` 调用（整个 batch）：

```js
const finish = editor.captureDocumentChange();
try {
  …逐条执行，失败条已各自回滚…
  const change = finish();
  if (!isEmpty(change)) editor.pushUndoEntry({
    label: 'AI 设计',
    forward: () => editor.restoreDocumentChange(change, 'after'),
    inverse: () => editor.restoreDocumentChange(change, 'before'),
  });
} catch (error) { editor.restoreDocumentChange(finish(), 'before'); throw error; }
```

单条内部的回滚：该条开始前 `captureDocumentChange()`，失败时 `restoreDocumentChange(t, 'before')`。

> `editor.captureDocumentChange` / `restoreDocumentChange` / `pushUndoEntry` 由 core 的 `undoBridge` 直接挂在 editor 上（已核实）。

---

## 8. 模块 B：`design-node-spec.js`

```js
export class SpecError extends Error { constructor(code, field, message) {...} }  // code: unknown_field|invalid_value|missing_field|unsupported

export const NODE_TYPES;               // Set
export function validateNodeSpec(spec, { index }) -> normalized spec   // 抛 SpecError
export function validateProps(patch, { allowGeometry }) -> normalized patch
export async function createNode({ toolkit, spec, parentId, hooks }) -> { id, name, type }
export async function updateNode({ toolkit, id, patch, hooks }) -> { changed: string[] }
```

- 纯校验部分（`validateNodeSpec` / `validateProps`）**不依赖 editor**，便于单测。
- `hooks = { loadFont(family, style), assertFontFamily(family) }` 由主控注入（模块 C 提供实现）。
- 创建用 `figma.createFrame()` 等（见 §1），然后写字段；`children` 递归。
- 文本节点：`figma.createText()` → `node.fontName = { family, style }` 前必须先 `await hooks.loadFont(family, style)`；
  `weightToStyle(weight)` 由 core 提供（`import { weightToStyle } from '@open-pencil/core'`）。
- 写完字段后必须 `await prepareDesignDocumentFonts(editor.graph)` 由主控负责，B 不用管。
- `updateNode` 返回实际变化的字段名列表（用于 `applied[].changed`）。

---

## 9. 模块 C：`design-fonts.js` 硬化

新增导出：

```js
export async function initializeDesignFonts(canvasKit, bridge)   // 现有，改造
export async function prepareDesignDocumentFonts(graph)          // 现有，保留
export function designFontReport(editor, rootId)                 // 现有，保留
export function availableFontFamilies()                          // 新：字体目录快照（同步，已缓存）
export async function refreshFontCatalog()                       // 新：拉一次系统字体列表并缓存
export function assertFontFamily(family)                         // 新：不在目录里 → throw
export async function loadDocumentFont(family, style)            // 新：loadLocalFont + 失败可重试
```

要求：

1. `initializeDesignFonts` 保留现有 UA 注入 + CJK 探测；**新增**：探测全部失败时不要直接 throw 让画板黑屏，
   改为 `console.warn` + 记录 `fontBootError`，画板继续起来（S-L1-4：绝不无声空白）。
   ——但当前实现会在全失败时 throw、主控据此拒绝启动，**这条改变需要主控确认**（见 §12 争议项）。
2. `refreshFontCatalog()`：用 `fontManager.listAvailableFonts()`（若不存在则用 `fontManager.collectFontKeys` 的族名并集）
   → `Set<string>` 缓存。取不到就返回空集，`assertFontFamily` 在空集时**放行**（宁可不管，不要误杀）。
3. `assertFontFamily(family)`：拒绝通用族名 `sans-serif|serif|monospace|cursive|fantasy|system-ui|inherit|initial|unset`，
   `code = 'generic_font_family'`；目录非空且不含该族 → `code = 'font_not_available'`，`reason` 里给出最多 5 个相近候选。
4. `loadDocumentFont(family, style)`：`loadLocalFont` 失败时清 `fontManager` 内部缓存的失败态并重试一次（S-L1-3），
   两次都失败返回 `null`（不抛）。

---

## 10. 模块 D：`electron/design-runtime.cjs` 工具面

`tools(sender, scope, signal, emit, options = {})`，`options = { images: boolean }`。

返回 6 个工具（顺序固定，测试按 index 取；新工具只能追加在末尾，否则按 index 断言的测试会错位）：

| # | name | label | operation |
|---|---|---|---|
| 0 | `design_read` | 读取设计 | `read` |
| 1 | `design_apply` | 编辑设计 | `apply` |
| 2 | `design_undo` | 撤销设计 | `undo` |
| 3 | `design_fonts` | 查询字体 | `fonts` |
| 4 | `design_screenshot` | 画板截图 | `screenshot` |
| 5 | `design_open` | 打开画板 | `open` |

**只读集合**：`read` / `fonts` / `screenshot` / `open` 不落盘、也不要求 AI 编辑权限；
只有 `apply` / `undo` 走 `save()` 并检查 `aiEdit`。

`design_open` 的意义：画板、浏览器与文件查看器共用右侧一块面板，面板可能关着或正显示网页。
一个改动看不见像素的设计工具没有用，所以 AI 需要一个显式动作把画板摆到用户眼前。
渲染端只需 `host?.showView?.('canvas')`（`openScope` 已经载入文档并让面板可见），然后回
`{ ok, view:'canvas', currentPageId, pages, selectedIds }`。

参数 schema 必须 `additionalProperties: false`。

`design_apply` 的 `description` 要能让模型**不需要额外提示**就写对（见 §11 文案要求）。

`design_screenshot` 的 execute：

```js
const result = await command(sender, scope, 'screenshot', input, signal);
const meta = JSON.stringify({ ...result, base64: undefined });
const content = [{ type: 'text', text: meta }];
if (options.images && result.base64) content.push({ type: 'image', data: result.base64, mimeType: result.mimeType });
else content[0].text += '\n当前模型不支持看图，只返回尺寸与节点信息。';
return { content, details: { ...result, base64: undefined } };
```

`command()` 现有的 `result?.length > 60000` 限制对截图不适用 → `respond()` 里要允许 `screenshot` 操作返回大 payload，
建议：`operation === 'screenshot'` 时上限提到 `3_000_000`（约 2.2MB PNG base64）。

`electron/chat-agent.mjs`：
- 第 1004 行改 `designRuntime.tools(sender, request.conversationId, signal, push, { images: supportsImages })`。
- 第 1177 行系统提示补：截图自检、字体先查 `design_fonts`、`design_apply` 逐条返回 `failed` 要逐条修、禁止 `sans-serif`。

---

## 11. `design_apply` 描述文案硬性要求

必须包含（模型读不到会重犯旧错）：

1. 逐条含义一句话 + 7 种 action 的骨架 JSON。
2. 「坐标相对 parent；省略 parentId 落在当前页」。
3. 「`fills`/`strokes`/`effects`/`layout`/`text` 的键名以此为准，写错键会返回 `failed[].code='unknown_field'` 并列出允许键」。
4. 「`fontFamily` 只接受具体家族名；先调 `design_fonts` 确认；`sans-serif` 之类会报错」。
5. 「返回 `applied`/`failed`；`failed` 是逐条的，其他条已生效，**不要整批重试**，只补失败那几条」。
6. 「画完用 `design_screenshot` 自查，不要只看返回值就说正确」。

---

## 12. 争议项（需主控裁决，子任务遇到就停下问）

1. `initializeDesignFonts` 全失败时：抛错（现状，画板不可用但诚实）vs 继续（画板可用但可能全空白）。**主控裁决：保留抛错**，但把错误信息改成可操作的（列出已探测的族 + 建议）。
2. `design_apply` 是否保留整批 `basedOnRevision` 乐观锁：**保留**，但不作为默认（可选参数）。
3. `VECTOR` 类型：core 的 `createVector()` 需要 vectorNetwork，没有工具直接建空 VECTOR。**裁决**：`type:"VECTOR"` 走 `create_vector` 太复杂，改为要求用 `svg`/`jsx`/`icon`；写 `type:"VECTOR"` 且无 `svg`/`jsx` → `code='unsupported'`，`reason` 指向 `svg`。
4. `GROUP`：`createShape` 不含 GROUP。**裁决**：`type:"GROUP"` 不支持，指向 `group_nodes`（本轮不暴露）→ 直接 `unsupported`。

---

## 12.5 施工中发现的三个运行时坑（已修，勿回退）

1. **`FigmaAPI` 没有 `currentPageId` 的 setter**，只有 `set currentPage(page)`。直接赋值在 ESM 严格模式下抛 TypeError。
2. **proxy 的 `rotation` setter 与 getter 符号不一致**：`node.rotation = 15` 之后读回 `-14.999999999999998`。
   读回走的是 `atan2(-m10, m00)` 快路径、不回舍入，写回走的是「Figma 逆时针绕左上角」的矩阵。
   **结论**：旋转一律直接写 `figma.graph.updateNode(id, { rotation })`。`SceneNode.rotation` 就是渲染用的度数
   （`coordinate.ts` 里 `Matrix.rotated(rotation * PI / 180)`），读写都走它，才能精确往返。
   `lineHeight` / `letterSpacing` 同理（见 §5）。
3. **`instanceOverrides` 是 `Map`，而文档落盘走 JSON**，Map 会变成 `{}`。core 自己的
   `captureDocumentChange` → `cloneInstanceOverrideState` 会 `[...state.self]`，遇到普通对象直接抛
   `e.self is not iterable`——表现为「重载文档后第一次编辑必失败」。
   **结论**：`snapshot()` 存 `serializeInstanceOverrideState(node.instanceOverrides)`，
   `hydrate()` 用 `deserializeInstanceOverrideState(...)`（对旧文档的 `{self:{},descendants:{}}` 也安全）。
   两者都来自 `@open-pencil/scene-graph`。

## 12.6 第二轮修复（R1–R12）落地位置

| 缺陷 | 修在哪 | 关键点 |
|---|---|---|
| R1 `layout.sizing` 不存在、显式宽度被 hug 掉 | `design-node-spec.js#applySizing` | `layout.sizing.{horizontal,vertical}` = `FIXED|HUG|FILL`；`writeFields` 顺序改为「layout → sizing → resize → … → rotation」，显式给了 `width/height` 且未点名该轴时自动钉 `FIXED`，钉完再 `resize` 一次撤销已发生的收缩 |
| R2 假 `imageHash` 静默空白 | `design-node-spec.js#buildFills` | 写入期查 `figma.graph.images`；新增 `base64`/`dataUrl` 通道（4 MB、文件头校验、`createImage` 取 hash） |
| R3 图标依赖 api.iconify.design | `design-icons-offline.js` | 内置 Lucide 几何 → SVG → `import_svg`，离线可用；仅其他前缀才走网络 |
| R4 `render(jsx)` 被 CSP 阻断 | `design-tools.js` 白名单 + `design-node-spec.js#vectorSourceOf` | `render`/`get_jsx`/`diff_jsx` 移出白名单；`jsx` 键仍识别但直接报 `unsupported` 并说明 CSP |
| R5 SECTION 实心深灰 | `design-node-spec.js#createWithFactory` | 无显式填充时用 `SECTION_DEFAULT_FILLS[theme]` 降为 `opacity 0.32` 的区域 |
| R6 渐变 angle 读不回 | `design-editor.js#paintsOf` | `gradientPoint` 反解两端点再 `atan2`，不可逆或奇异时省略而不是瞎报 |
| R7 阴影颜色 alpha 读不回 | `design-editor.js#colorHex` | `a<1` 才输出 `#RRGGBBAA`，量化到 1/255 |
| R8 `layout.sizing` 要可读 | `design-editor.js#layoutOf` | 始终带 `sizing`；值取 `layoutSizingInParent`（与 proxy getter 同一实现）；顺带修正 `align` 读的是 `primaryAxisAlign` 而非 `…Items` |
| R10 `design_read` 带 ~1.5k token 字体状态 | `design-editor.js#readResult` | 默认只给 `issues`/`blockedCount`/`summary`；有缺字或有节点被跳过、或 `fonts: true` 时才带 `status`+`boot` |
| R12 正常文字被标 `substituted` | `design-fonts.js#designFontReport` | 只有**换了家族**才算 `substituted`；同族缺字重进 `styleSubstituted`，并加 `summary` |

> 另一个被这轮暴露的坑：**rotation 必须最后写**。`applySizing` 里的 `resize` 会从变换矩阵重算角度，把先前写入的 15 变成 14.999999999999998；把旋转压到 `writeFields` 末尾才精确往返。

## 13. 验证口径
| 检查 | 手段 | 通过标准 |
|---|---|---|
| 构建 | `npm run build` | 退出 0；`vendor/open-pencil-editor/index.js` 存在 |
| Lint | `npx eslint src/features/design electron scripts/design-*.cjs` | 无 error |
| 端到端 | `node scripts/design-integration-smoke.cjs` | `ok:true`，`errors:[]`，且**逐条容错**断言通过 |
| 真机工具 | `node scripts/design-tools-check.cjs`（新） | 覆盖 §13.1 |
| 无回归 | `node scripts/design-app-smoke.cjs`、`node scripts/design-ui-check.cjs` | `ok:true` |

### 13.1 `design-tools-check.cjs` 必测项

跑 Electron 真机（模式抄 `design-integration-smoke.cjs`），逐条断言：

1. `design_fonts` 返回 `count > 0` 且含 `Microsoft YaHei`。
2. `design_apply` 建 1 个 FRAME + 3 子节点（TEXT/RECTANGLE/ELLIPSE），带 `fills` 渐变、`strokes`、`effects`、`opacity:0.5`、`rotation:15`、`text:{align:'CENTER',lineHeight:24,letterSpacing:0.5,autoResize:'HEIGHT'}`。
3. `design_read`（`nodeId` 指向该 FRAME）读回：`fills[0].type==='GRADIENT_LINEAR'`、`strokes.length===1`、`effects.length===1`、`opacity===0.5`、`rotation===15`、`lineHeight===24`、`letterSpacing===0.5`。
   → **读回字段不全的，由主控补 `tree()` 序列化**（这是 P0-4 的关键）。
4. 一条坏操作（`{action:'create', type:'RECTANGLE', width:10, bogus:1}`）混在 3 条好操作中间 → `failed.length===1`、`code==='unknown_field'`、另 3 条 `applied`/`created` 生效，revision 递增 1 次。
5. `design_apply` 用 `sans-serif` 的 TEXT → 该条失败，`code==='generic_font_family'`。
6. `design_screenshot`（`nodeId`）→ 返回 `base64` 且 `byteLength>1000`、`width>0`；解码后 PNG magic `\x89PNG`。
7. `design_read` 的 `query: '//TEXT'` 返回 `count===` 建过的 TEXT 数。
8. `{action:'icon', name:'lucide:heart'}` → 网络失败时允许 `failed`，但 `code` 必须是 `network`（不得 crash、不得静默成功）。
9. `design_undo` 一次撤销整个 batch（`design_read` 读回后帧消失）。
