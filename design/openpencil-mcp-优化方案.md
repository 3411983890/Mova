# OpenPencil 画板工具能力评估与优化方案

> 测试对象：本会话暴露给模型的 `design_read` / `design_apply` / `design_undo` 工具面
> 测试方式：真实写入画布 + 读回校验 + 字体探测 + **上游源码定位** + 宿主官方文档/竞品比对
> 记录时间：本次会话（画布 `Page 1`）
> 第 3 节为代码级溯源版（v2），已用项目内 `open-pencil-core` 源码逐条校验

---

## 0. 一句话结论

**宿主能力很强，core 能力也齐全，缺的是「接线」。**

我拿到的接口只有 **4 种图元 × 14 个字段**；而项目内 vendored 的 `@open-pencil/core` 实际注册了 **26 个核心工具 + 约 100 个扩展工具**（`src/tools/registry-core.ts`、`src/tools/registry-extended.ts`），覆盖布尔运算、Iconify 图标、SVG 导入、JSX 渲染、组件/实例、变量 token、渐变描边阴影、视觉 diff、导出。

结论从 v1 的「差距在插件 schema 层」进一步收敛为：

> **差距几乎全部来自 Mova 自研的 `design_apply` 适配器——它绕过了 core 既有的工具与校验层，而不是 core 缺能力。**

这意味着优化主线不是「造功能」，而是「打通已有功能」。第 3、4 节按此重写。

---

## 1. 实测结果：我实际能动用的能力

### 1.1 可用

| 能力 | 结果 | 实测证据 |
|---|---|---|
| 自动布局 `VERTICAL` / `HORIZONTAL` + `gap` + `padding` | ✅ 真实生效 | 子节点被重排到 16/16 → 58 → 100（16+30+12，精确）；横向 10 → 158 |
| 单次批量图层数 | ✅ 20 个通过 | 工具声明上限 200，未触达 |
| 纯色填充 `#RRGGBB` | ✅ | 全页配色正确落库 |
| Frame 嵌套 | ✅ | 登录页为多层嵌套结构，可单独选中 |

### 1.2 不可用 / 受限

| 能力 | 结果 | 错误或表现 |
|---|---|---|
| 批量原子性 | ❌ 全批回滚 | 1 条非法 `fill` 让同批 11 个图层全部丢弃 |
| 图元类型 | 仅 `FRAME`/`RECTANGLE`/`ELLIPSE`/`TEXT` | `VECTOR` 单独测 → 「图层数量或类型不支持」；`COMPONENT`/`GROUP`/`LINE`/`IMAGE`/`STAR`/`POLYGON`/`BOOLEAN` 同批同报错 |
| 渐变填充 | ❌ | `linear-gradient(...)` → 「填充色必须是 #RRGGBB」 |
| 图片填充 | ❌ | URL 填充 → 同上错误 |
| 文字自动换行 / 自动增高 | ❌ | 140 宽 + 60 字长文案 + `textAutoResize:HEIGHT`，高度仍是 20 |
| 视觉回读（截图 / 导出） | ❌ 完全没有 | 只能读 JSON，看不到一个像素 |
| 字体枚举 | ❌ 没有 | 只能猜族名 —— 中文事故的直接源头 |
| 页面管理 / 图层查询 | ❌ | 只能整棵树读，无法按 name/type/parent 过滤 |
| 组件 / 实例 / 变量 / 样式 token | ❌ 无概念 | schema 里不存在 |
| 图标库 / 图片素材 | ❌ | 无网络取材、无 SVG 路径导入 |
| 描边 / 透明度 / 旋转 / 阴影 / 字重 / 对齐 / 行高 / 字距 | ⚠️ 写入不报错，读回全不返回 | 见 1.3 |

### 1.3 关键判据（重要）

`padding` 也属于「读回不返回但真实生效」——这证明读回用的是**白名单序列化**，**没返回 ≠ 没存**。

因此描边 / 透明 / 旋转究竟是「静默丢弃」还是「存了但没暴露」，**必须靠视觉判定**，无法只凭读回下结论。这是 P0-4 优先级的关键依据，见第 7 节。

---

## 2. 竞品与宿主基线对比

| 能力 | OpenPencil 宿主（官方） | 我的 `design_*` |
|---|---|---|
| 图元 | Rectangle / Ellipse / Line / Polygon / **Pen(Bezier)** / Frame / Text | 4 种，无路径 |
| 布尔运算 | union / subtract / intersect | ✗ |
| 图标库 | **Iconify picker** 内置 | ✗ |
| 图片 | 导入 PNG / JPEG / SVG / WebP / GIF | ✗ |
| 自动布局 | gap / padding / **justify / align** | 仅 gap / padding |
| 组件 | 组件 + 实例 + 覆盖 + **slots** | ✗ |
| 设计系统 | 变量 token（`$variable`）+ 多主题 | ✗ |
| 导出 | .fig / PDF / PPTX / SVG / HTML / JSX | ✗ |
| 命令 / 工具数 | 24 条 CLI，**126 个 MCP 工具** | 3 个（read / apply / undo） |
| 字体 | `fonts` 命令 + `list_available_fonts` / `get_font_status` | ✗ |
| 技术栈 | CanvasKit + Yoga（Skia 渲染 + Flexbox 布局） | 同（间接） |

参考来源：

- [OpenPencil README（GitHub）](https://github.com/ZSeven-W/openpencil)
- [openpencil.dev 官网](https://openpencil.dev/)
- [xda-developers 评测：ditched Figma for open-source tool AI does what Figma can't](https://www.xda-developers.com/ditched-figma-for-open-source-tool-ai-does-what-figma-cant)（指出其构建于 CanvasKit + Yoga）
- [Figma Plugin API `SceneNode` 类型定义](https://github.com/rsms/figplug/blob/master/lib/figma-plugin-1.0.0.d.ts)
- 本地源码：`.test-temp/open-pencil-core/package/src/`（以下所有 `文件:行号` 均指此目录）

---

## 3. 根因归因（三层）—— 代码级溯源

### 3.0 证据等级说明

本文把结论分成两级，避免把推断当事实：

- **[码]** = 已读源码确认，给出文件与行号
- **[测]** = 本会话实测行为，有 revision / 报错原文/截图支撑
- **[推]** = 由 [码] 与 [测] 推导出的假设，尚未跑通验证路径

---

### L1 渲染层（CanvasKit + Yoga）

#### L1-1 三种失败形态必须分开看

过去我笼统称为「中文显示不了」，实际是三种不同现象，对应三条不同代码路径：

| 形态 | 观察 | 实际含义 |
|---|---|---|
| ① 豆腐块 □□ | 首版截图，字符位置有方框 | 字体已注册，但该字形的 glyph 为空（`.notdef` 有轮廓） |
| ② 整段空白 | 探测条第 2–6 行，连 `Abc 123` 也不画 | 节点被判定「未就绪」，**整节点跳过绘制** |
| ③ 局部缺失 | 改成 `sans-serif` 后整页：`9:41`/`M`/`Apple` 正常，中文全空 | 走了 substitute，用 Inter 画拉丁、中文无覆盖 |

把三者混为一谈，是我第一轮误判的直接原因。

#### L1-2 渲染门的判定链 [码]

`canvas/text/index.ts` 里有一道显式的**字体就绪门**：

```
nodeFontReadiness(node)
  ├─ requiredFacesReadiness()   // 家族/字重是否已加载
  └─ observedGlyphReadiness()   // 逐字符检查字形覆盖
```

关键分支（`canvas/text/index.ts`）：

- `:33` 若 `fontManager.isStyleLoaded(family, style)` → 视为就绪
- `:85` 若该家族彻底取不到、但默认族 `Inter` 已加载 → 返回 `'substituted'`
- `:108` 用 `hasGlyphCoverage` 走缓存快路径

四种状态最终由 `isNodeFontLoaded` 裁决：

| 状态 | 是否绘制 | 说明 |
|---|---|---|
| `ready` | ✅ 画 | 字体齐全 |
| `substituted` | ✅ 画 | 用替代字体画，**替代字体没有的字符就不画** |
| `pending` | ❌ **完全不画** | 字体需求还在解析中 |
| `exhausted` | ❌ **完全不画** | 解析失败/兜底耗尽 |

而 `buildTextPicture()` / `measureTextNode()` 的门就是这一句：

```ts
if (!r.fontsLoaded || !r.fontProvider || !isNodeFontLoaded(r, node)) return null
```

→ 形态 ② 的来源：`pending`/`exhausted` 时函数返回 `null`，文字**一个像素都不绘制**，不是画错，是根本没画。

#### L1-3 为什么「静默」而不是报错 [码]

三层都没有任何日志或警告：

1. `fonts.ts` 加载失败只写入内部 `unavailableFaces`，不抛错
2. `text/index.ts` 未就绪直接 `return null`
3. `canvas/scene.ts:325` 渲染循环对 blocked 节点直接 `continue`：

```ts
if (node.internalOnly || !node.visible || node.isMask || fontManager.isNodeBlocked(node.id))
```

而 `editor/pages.ts:147` 在页面装载时**主动**把整页节点设为 blocked：

```ts
fontManager.blockNodesUntilFontsResolve(childIds)
```

→ 结论：**字体没就绪 = 节点被主动屏蔽 = 无声空白**。这是「我以为写成功了」的技术根源：写库成功、读回成功、画布上什么都没有，且没有任何一层报错。

#### L1-4 CJK 兜底的三个真实陷阱 [码]

**陷阱 A：缺 `userAgent` 就退回 Linux 列表**

`text/fallbacks.ts`：

```ts
export function cjkLocalFallbackFamilies(userAgent?: string): string[] {
  if (!userAgent) return [...CJK_FALLBACK_FAMILIES_LINUX]
  if (userAgent.includes('Mac')) return [...CJK_FALLBACK_FAMILIES_MACOS]
  if (userAgent.includes('Windows')) return [...CJK_FALLBACK_FAMILIES_WINDOWS]
  return [...CJK_FALLBACK_FAMILIES_LINUX]
}
```

Windows 分支才是 `['Microsoft YaHei', 'Microsoft YaHei UI', 'SimHei', 'SimSun']`；**`userAgent` 为空时拿到的是 Linux 列表**（`Noto Sans CJK SC` / `WenQuanYi Micro Hei` / `Droid Sans Fallback`），在 Windows 上必然全盘未命中。

这与实测高度吻合 [测]：

| 探测行 | `fontFamily` | 是否在 Windows 兜底列表 | 实测 |
|---|---|---|---|
| 1 | `Microsoft YaHei` | ✅ 列表首位 | ✅ 正常 |
| 2 | `SimSun` | ✅ 但排第 4 | 空白 |
| 3 | `Noto Sans SC` | ❌ 属远程 Google Fonts | 空白 |
| 4 | `PingFang SC` | ❌ 仅在 macOS 列表 | 空白 |
| 5 | `Source Han Sans SC` | ❌ 不在任何列表 | 空白 |
| 6 | 空字符串 | — 走默认 `Inter` | 空白 |

→ **`userAgent` 未被注入**是目前最可能的根因 [推]。`setFallbackUserAgent` 在可达的项目代码中**只找到定义，未找到调用点**（搜索上限 5000 文件，宿主 Electron 主进程代码可能未被覆盖，需人工核对一次）。

**陷阱 B：`renderFamily` 忽略 style，且明确不为 CJK 造合成别名**

`text/fonts.ts:496`：

```ts
renderFamily(family: string, _style: string): string {
  // CanvasKit can shape metrics but paint no glyphs for some CJK/Arabic faces registered under a
  // synthetic alias. Keep every shard under the font's source family; ...
  return family
}
```

→ 源码注释直接承认「某些 CJK 字体在合成别名下能算度量但**画不出字形**」。所以「给 CJK 造个家族别名」这条路在架构上被主动封死，只能用真实家族名。

**陷阱 C：兜底失败后不可重试 [推]**

`text/fonts.ts:507`：

```ts
async ensureCJKFallback(): Promise<string[]> {
  if (this.cjkFallbackFamilies.length > 0) return this.cjkFallbackFamilies
  if (this.cjkFallbackPromise) return this.cjkFallbackPromise
  this.cjkFallbackPromise = this.ensureFallbackFamilies('cjk', ...)
  return this.cjkFallbackPromise
}
```

若首次解析得到空结果，`cjkFallbackFamilies` 仍为空、`cjkFallbackPromise` 仍是已 resolve 的 Promise → 后续调用**直接返回那个空结果**，不会重试。这能解释「一旦空白，刷新前一直空白」类现象。

**附带判据分离**：`text/opentype.ts:97` 的 `hasGlyphOutlines` 只查 `fontManager.loadedData`，即「字体能渲染」与「能取轮廓做路径编辑」是两套独立判据，排查时不能互相代替。

#### L1-5 L1 解决方案

| # | 措施 | 落点 | 验收 |
|---|---|---|---|
| S-L1-1 | 启动时注入 `setFallbackUserAgent(navigator.userAgent)`；桌面端再 `setHostFontCatalog(系统字体枚举)` | 宿主启动流程 | `get_font_status` 显示 Windows 兜底列表命中 |
| S-L1-2 | 显式 `setCJKFallbackFamily('Microsoft YaHei')` 作为最低保底，不依赖 UA 推断 | 宿主启动流程 | 即使 UA 缺失也有 CJK 兜底 |
| S-L1-3 | 兜底失败可重试：失败时清空 `cjkFallbackPromise`；对外暴露 `get_font_status` 展示替换与失败原因 | `text/fonts.ts` | 断网→恢复后无需刷新即可恢复 |
| S-L1-4 | **缺字形降级可见**：`pending`/`exhausted` 时用任意可用字体先画（哪怕是替代字体），绝不整节点隐藏；并用回调上报告警 | `canvas/text/index.ts`、`canvas/scene.ts` | 画布上永不出现「无声空白」 |
| S-L1-5 | 写入期校验：设置 `fontFamily` 前查 `list_available_fonts`，未命中直接报错而非接受 | `design_apply` / core `setFont` | 模型不可能再写入无效族名 |

> 历史教训固化：`sans-serif` 这类**通用族名**在 CanvasKit 里无 CSS 语义，实测整页中文消失 [测]。文档与工具说明里应明确禁止，只接受具体家族名。

---

### L2 工具层（主要矛盾）

#### L2-0 关键定位：两套接口并存，`design_apply` 绕过了 core

这是本次最重要的发现。项目内 vendored 的 core 已经具备完整工具面：

| 事实 | 证据 |
|---|---|
| 核心工具 26 个（含 `render`、`describe`、`batch_update`、`diff_visual` 等） | `tools/registry-core.ts`（注释自述 "26 tools, ~5K schema tokens"） |
| 扩展工具约 100 个（变量、布尔、路径、导出、图标、分析） | `tools/registry-extended.ts` |
| 工具有**接口级暴露配置** `mcp` / `ai` / `webmcp` | `tools/schema.ts`：`ToolInterface = 'mcp' \| 'ai' \| 'webmcp'`、`exposure` 字段 |
| 参数校验是 **strictObject**，拼错就报错 | `tools/schema.ts#parseToolArgs`，注释原文：「Inputs are strict objects, so a misspelled or mis-nested argument fails here **instead of being dropped**」 |
| 批量更新**逐条收集错误继续执行**，不整批回滚 | `tools/structure/batch.ts`：`errors.push(...); continue`，返回 `{ updated, results, errors }` |

而我的 `design_apply` 实测行为是：未知字段**静默丢弃**、非法值**整批回滚**、图元只有 4 种 [测]。

→ 结论：**`design_apply` 不是 core 工具的包装，而是一套独立手写适配器**，它既没继承 core 的 strict 校验，也没暴露 core 的能力。上一版把矛头指向 core 是错的，此处修正。

#### L2-1 schema 过窄

- **现象** [测]：4 图元（`FRAME`/`RECTANGLE`/`ELLIPSE`/`TEXT`）× 14 字段；`VECTOR`/`GROUP`/`IMAGE`/`STAR`/`POLYGON`/`BOOLEAN` 全部报「图层数量或类型不支持」。
- **根因** [码]：core 侧完全支持这些类型——`canvas/shapes.ts` 有 `VECTOR` 分支，`canvas/shadows.ts` 处理 `POLYGON`/`STAR`/`VECTOR`，`editor/shapes/vector.ts`、`pen.ts`、`pencil.ts` 各有建图元实现。
- **影响**：无法画真实图标、logo、曲线；信号/WIFI 只能用手搓矩形近似（本次已发生）。
- **上游已有能力**：`createShape`、`createVector`、`importSVG`、`insertIcon`、`booleanUnion/Subtract/Intersect/Exclude`、`render`（JSX，支持内联 SVG path，见 `tools/create/render.ts`）。
- **方案**：至少把 `render(jsx)` 接出来——一条就同时解决图标、路径、复杂形状。

#### L2-2 不支持属性静默丢弃

- **现象** [测]：写 `stroke`/`opacity`/`rotation`/`shadow`/`fontWeight`/`textAlign` 等不报错，读回也没有。
- **根因** [码]：core 的 `parseToolArgs` 用 valibot `strictObject`，未知键**必定报错**；因此这些字段根本没经过 core 校验，是在 `design_apply` 里被吞掉的。
- **影响**：模型无法区分「写对了」与「被忽略」，只能靠人眼发现——这正是中文事故的同构问题。
- **上游已有能力**：`setStroke`、`setStrokeAlign`、`setOpacity`、`setRotation`、`setEffects`、`setBlend`、`setConstraints`、`setTextResize`、`setFont`、`setFontRange`。
- **方案**：要么转发到 core 的 `modify/*`，要么在适配器里对未知字段直接 throw。

#### L2-3 全批原子回滚

- **现象** [测]：1 条非法 `fill` → 同批 11 个图层全部丢弃，报「填充色必须是 #RRGGBB」。
- **根因** [码]：core 的 `batch_update` 是**逐条容错**实现（`tools/structure/batch.ts`：找不到节点 `errors.push` 后 `continue`，其余照做），而 `design_apply` 选择了一错全回滚。
- **影响**：200 条操作里 1 条写错，全部劳动作废，且不告诉我哪条错——代价极高。
- **上游已有能力**：`batch_update` 的 `{updated, results, errors}` 返回契约。
- **方案**：改为逐条容错 + 结构化返回 `{applied: [...], failed: [{index, reason}]}`。

#### L2-4 无视觉回读

- **现象** [测]：我只有 JSON，看不到像素；本次三轮中文问题全靠用户截图才能推进。
- **根因** [码]：core 有 `diff_visual`、`export_image`、`exportSVG`、`describe`、`lint`、`analyze_*`，但都没暴露到 `design_*`。
- **影响**：模型无法自检，一切「显示正常」的断言都是不可靠陈述。
- **上游已有能力**：`diffVisual`、`exportImage`、`describe`、`lint`、`analyzeSpacing/Typography/Colors/Overlaps`。
- **方案**：暴露 `export_image`（或 `diff_visual`）为 `design_screenshot`。

#### L2-5 无字体枚举

- **现象** [测]：我靠猜族名试了 6 个，浪费一轮且误判。
- **根因** [码]：core 有 `list_available_fonts`（`tools/read/fonts.ts`，注释明言「use this to discover what fonts are available to set on a text node」）与 `get_font_status`（报告请求的 face、来源、替换、失败原因、受影响节点），均未暴露。
- **影响**：本地化正确性无保障。
- **方案**：直接转发这两个工具，`exposure` 里显式打开。

#### L2-6 无效字体族静默不画

见 L1-2 / L1-4：状态 `pending`/`exhausted` → 不绘制、不报错。**这是 L1 与 L2 的交汇点**：L1 提供了「静默」的机制，L2 提供了「无校验」的入口。

---

### L3 交互层

| # | 问题 | 根因 | 上游已有 | 方案 |
|---|---|---|---|---|
| L3-1 | 只能整树读，无按条件查询 | `design_read` 无参数化查询；我本轮为找节点读了整棵树 | `query_nodes`、`findNodes`、`nodeChildren`、`nodeAncestors`、`getPageTree`、`getSelection`、`selectNodes` | 暴露 `query_nodes` / `find_nodes`，支持 name/type/parent 过滤 |
| L3-2 | 无事务边界、无局部 undo | `design_undo` 是整页级回退 | `execution.mutation` 分类（`none`/`view`/`properties`/`document`）、`isAtomicTool` 判定 | 按 mutation 类别暴露「撤销上一批操作」 |
| L3-3 | revision 全页级，无并发保护 | 只返回递增 revision | — | 增加 `basedOnRevision` 乐观锁，冲突即拒 |
| L3-4 | `warnings` 被吞 | core `render` 返回值里有 `warnings` 字段 | `tools/create/render.ts` | 透传 `warnings` 到工具结果 |
| L3-5 | 无注释/评审协作 | — | `getComments`/`addComment`/`replyToComment`/`resolveComment` | 按需暴露 |

---

### 3.6 根因 → 修复对照矩阵

| 症状 | L1 渲染层 | L2 工具层 | L3 交互层 | 最小修复 |
|---|---|---|---|---|
| 中文空白 | ✅ 主因（UA 缺省→Linux 列表；pending 不画） | ✅ 无字体校验 | — | S-L1-1/2 + P0-2 |
| 豆腐块 | ✅ 字形缺失 | — | — | S-L1-2 |
| 图标只能手搓 | — | ✅ 无 VECTOR/SVG/Icon | — | 暴露 `render(jsx)` + `insert_icon` |
| 写了没生效 | ✅ 静默不画 | ✅ 静默丢弃 | — | P0-7 报错 + P0-1 截图 |
| 一条错全批作废 | — | ✅ 全批回滚 | — | 转发 `batch_update` |
| 不知道画对没 | — | ✅ 无回读 | — | 暴露 `export_image` |
| 上下文浪费 | — | — | ✅ 无 query | 暴露 `query_nodes` |

---

## 4. 优化方案（v2：从「造能力」改为「接线」）

### 4.0 三条路线

| 路线 | 做法 | 成本 | 收益 |
|---|---|---|---|
| **A（推荐）** | 保留 `design_apply` 名字，内部**转发到 core 工具**；先接 8 个高价值工具 | 低 | 立刻拿到 core 全部能力与 strict 校验 |
| **B** | 直接暴露 core 工具面（按 `exposure` 白名单裁到 20–30 个） | 中 | 与官方 MCP 对齐，语义最正 |
| **C（过渡）** | 只新增 5 个最小工具：`design_fonts` / `design_screenshot` / `design_paint` / `design_text` / `design_insert_jsx` | 最低 | 半天内解决本次全部痛点 |

**优先接线的 core 工具（按投入产出排序）**

| 优先级 | core 工具 | 解决什么 |
|---|---|---|
| 1 | `list_available_fonts` + `get_font_status` | 字体盲猜、中文空白可诊断 |
| 2 | `export_image` / `diff_visual` | 视觉自检，模型能发现画错 |
| 3 | `render`（JSX + 内联 SVG） | 图标、路径、复杂形状一次解决 |
| 4 | `set_fill`（渐变）/ `set_stroke` / `set_effects` / `set_opacity` / `set_rotation` | 视觉质感 |
| 5 | `batch_update` | 逐条容错替代全批回滚 |
| 6 | `set_text_properties` / `set_text_resize` / `set_font_range` | 排版正确性 |
| 7 | `query_nodes` / `find_nodes` | 省上下文 |
| 8 | `insert_icon` / `import_svg` / `search_icons` | 真实图标 |
| 9 | 变量/组件/导出（`create_variable`、`create_component`、`exportSVG`） | 体系化交付 |

### P0 —— 不修就无法稳定交付

| # | 建议 | 对应 core 工具 | 验收标准 |
|---|---|---|---|
| P0-1 | **视觉回读**：`design_screenshot(nodeId)` | `export_image` / `diff_visual` | 能对任一 frame 取图并自行判断对错 |
| P0-2 | **字体枚举 + 就绪确认**：`design_fonts()`；写 text 后返回 `resolvedFont` / `substituted` | `list_available_fonts` / `get_font_status` | 不再猜族名；无效族名立即报错 |
| P0-3 | paint 数组：纯色 / 线性渐变 / 图片 | `set_fill`（已支持 gradient）/ `set_image_fill` | 三种 paint 都能落库并读回 |
| P0-4 | `stroke` / `effects` / `opacity` / `rotation` 真正落库并读回 | `set_stroke` / `set_stroke_align` / `set_effects` / `set_opacity` / `set_rotation` | 读回字段与渲染一致 |
| P0-5 | 文字排版：`textAlign` / `fontWeight` / `lineHeight` / `letterSpacing` / `autoResize` + `textMetrics` | `set_text_properties` / `set_text_resize` | 不用再手算居中偏移 |
| P0-6 | **逐条错误而非整批回滚**：返回 `{applied, failed:[{index,reason}]}` | `batch_update`（已是逐条容错） | 一条错不毁掉其余 199 条 |
| P0-7 | 未知属性**报错**而非静默吞掉 | `parseToolArgs` 的 strictObject | 不再出现「写了但不知道有没有生效」 |

### P1 —— 决定设计稿质量上限

1. **图标库**：`insert_icon` / `search_icons`（Iconify），或 `render` 内联 SVG
2. **矢量**：`create_vector` / `path_set` / 布尔四则 —— 真实 logo 与图标
3. **图片**：`set_image_fill` / `import_svg` / `stock_photo`
4. **组件与实例**：`create_component` / `create_instance` / `create_slot`
5. **查询**：`query_nodes` / `find_nodes` / `node_children`
6. **页面管理**：`create_page` / `switch_page` / `list_pages`
7. **导出**：`exportSVG` / `exportPDF` / `exportImage`；JSX 走 `getJSX`
8. **质量护栏**：`lint` / `describe` / `analyze_spacing` / `analyze_typography`

### P2 —— 体系化

变量 token 与主题（`create_variable` / `bind_variable`）、`constraints`、注释协作、codegen（`designToTokens` / `designToComponentMap`）。

---

## 5. Schema 草案（若走路线 B，供裁剪参考）

```ts
type Paint =
  | { type: "SOLID"; color: string }
  | { type: "GRADIENT_LINEAR"; stops: { pos: number; color: string }[]; angle?: number }
  | { type: "IMAGE"; src: string; fit?: "COVER" | "CONTAIN" | "FILL" };

type Node = {
  id: string;
  type: "FRAME" | "RECTANGLE" | "ELLIPSE" | "TEXT" | "VECTOR" | "GROUP" | "COMPONENT" | "INSTANCE";
  name: string;
  x: number; y: number; width: number; height: number;
  rotation?: number;              // deg
  opacity?: number;               // 0..1
  cornerRadius?: number;
  fills?: Paint[];
  strokes?: { width: number; color: string; align: "INSIDE" | "CENTER" | "OUTSIDE" }[];
  effects?: {
    type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR";
    x?: number; y?: number; blur: number; spread?: number; color?: string;
  }[];
  layout?: {
    mode: "NONE" | "HORIZONTAL" | "VERTICAL";
    gap?: number;
    padding?: number;
    primaryAxisAlign?: "START" | "CENTER" | "END" | "SPACE_BETWEEN";
    counterAxisAlign?: "START" | "CENTER" | "END";
  };
  text?: {
    content: string;
    fontFamily: string;           // 必须是具体家族名，禁止 sans-serif 等通用族
    fontSize: number;
    fontWeight?: number;
    lineHeight?: number;
    letterSpacing?: number;
    align?: "LEFT" | "CENTER" | "RIGHT";
    autoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT";
  };
  children?: Node[];
};
```

### 如果只能要三个

1. **截图回读** —— 信任基础，模型能自己发现画错了
2. **fonts 枚举** —— 本地化正确性，不再盲猜字体族
3. **`render(jsx)`** —— 一条打通图标、SVG 路径与复杂形状

---

## 6. 附录 A：中文显示事故复盘

### 时间线

| 环节 | 发生了什么 | 责任归属 |
|---|---|---|
| 初版 | 文本节点默认 `Microsoft YaHei`，首屏渲染出豆腐块 | 渲染层字体就绪时序（`pending`/字形缺失） |
| 处置 | 全页改成通用族 `sans-serif` | **模型错误**：CanvasKit 无 CSS 通用族语义，`pending` 后整节点不画 |
| 验证 | 只读回「字段已写入」，就宣称「显示正常」 | **模型错误**：把数据写入当成视觉正确 |
| 归因 | 断言「环境没有 CJK 字体」 | **模型错误**：探测条截图直接推翻——`Microsoft YaHei` 行与标题行中文正常 |
| 修复 | 全页 18 个文本节点改回 `Microsoft YaHei` | 中文恢复 |

### 插件/适配器侧放大因素（值得写进改进项）

1. **没有暴露 `list_available_fonts`** → 模型只能猜族名
2. **没有暴露 `export_image`** → 模型无法自检
3. **字体未就绪时整节点静默不画**，不报错、不警告
4. **`design_apply` 绕过 core 的 strict 校验** → 无效值被接受而非拒绝

四者叠加，任何模型都会在这里翻车。P0-1 / P0-2 / P0-7 + S-L1-4 就是针对这四点。

### 字体探测实测表

| 行 | fontFamily | 渲染结果 |
|---|---|---|
| 1 | `Microsoft YaHei` | ✅ 正常 |
| 2 | `SimSun` | 空白 |
| 3 | `Noto Sans SC` | 空白 |
| 4 | `PingFang SC` | 空白 |
| 5 | `Source Han Sans SC` | 空白 |
| 6 | 空字符串（默认 `Inter`） | 空白 |

**结论**：当前环境仅 `Microsoft YaHei` 可用；结合 `text/fallbacks.ts` 的 UA 分支，判定为 **CJK 兜底列表可能取到了 Linux 分支** [推]，需核对 `setFallbackUserAgent` 是否被调用。

---

## 7. 附录 B：遗留验证项

| 探测区 | 位置 | 验证内容 | 状态 |
|---|---|---|---|
| `能力探测-A 文字` | x=880 | P6 红描边 / P7 半透明 / P8 旋转 15° | **待目视确认** |
| `能力探测-B 自动布局` | x=1300 | 子节点重排 | ✅ 已验证生效 |
| `能力探测-C 文字自适应` | x=1300 | 长文案自动换行 | ✅ 已验证不生效 |

**待办**：目视确认 P6 / P7 / P8。core 侧 `set_stroke` / `set_opacity` / `set_rotation` 均存在 [码]，所以这三者是**模型定义内建能力**；关键在于 `design_apply` 是否把它们落库。

- 若画出来了 → 属「存了但读回不暴露」，P0-4 可降为 P1（只需补读回字段）
- 若没画出来 → 属「适配器静默丢弃」，P0-4 维持 P0

确认后清理探测区，画布只保留登录页。

---

## 8. 行动清单

- [ ] 核对 `setFallbackUserAgent` / `setHostFontCatalog` 在宿主启动流程中是否被调用（决定 L1 主因）
- [ ] 目视确认 A 区 `P6/P7/P8` 渲染结果（决定 P0-4 等级）
- [ ] 按路线 C 先接 5 个最小工具（`design_fonts` / `design_screenshot` / `design_paint` / `design_text` / `design_insert_jsx`）
- [ ] 再把 `design_apply` 内部改为转发 core 工具 + strict 校验 + 逐条容错
- [ ] 清理三块探测区，画布只留 `App 登录页`
- [ ] 按接线后的能力重做登录页（真实图标 + 精确排版）

---

# 第二部分：改进后复测报告

> 复测对象：改进后的 `design_*` 工具面
> 复测区间：revision 22 → 29（本会话真实写入）
> 证据等级：**[测]** 工具有返回 / **[视]** 截图亲眼所见 / **[码]** 源码或返回字段可查

## 9. 结论：第一部分的核心缺陷已被修复

改进后的工具面**不再是「4 图元 × 14 字段」的窄接口**。第 1–8 节记录的 P0 级问题几乎全部关闭，且新增了此前完全没有的三项能力。

**最重要的一项**：`design_screenshot` 已可用 [测][视]。模型第一次能**看见自己画的东西**。这直接拆掉了中文事故的根因——「只能读 JSON，不能看像素」。

### 9.1 原 P0 项关闭情况

| 原编号 | 原问题 | 复测结果 | 证据 |
|---|---|---|---|
| P0-1 | 无视觉回读 | ✅ **已修复**：`design_screenshot` 支持整页 / 单节点 / 多节点 `ids` / `scale` / `maxEdge` | [测][视] |
| P0-2 | 无字体枚举，只能猜族名 | ✅ **已修复**：`design_fonts` 返回 9 个族 + `cjkFamilies` + 每个 face 的 `status/substituted` | [测] |
| P0-2b | 无效字体静默不画 | ✅ **已修复**：无效族名直接报 `font_not_available`，并给出可用替代名 | [测] |
| P0-3 | 无渐变 / 图片 | ⚠️ **部分修复**：`GRADIENT_LINEAR` 完全可用；`IMAGE` 写入不报错但画不出来 | [测][视] |
| P0-4 | 描边/透明/旋转「写了不报错、读回没有」 | ✅ **已修复**：三者均落库，读回有值，截图可见 | [测][视] |
| P0-5 | 文字排版不可控 | ✅ **已修复**：`fontWeight`/`italic`/`lineHeight`/`letterSpacing`/`align`/`autoResize` 全部生效 | [测][视] |
| P0-6 | 一条错毁整批（原子回滚） | ✅ **已修复**：返回 `{applied[], created[], failed[{index,code,field,reason}]}`，逐条容错 | [测] |
| P0-7 | 未知字段静默丢弃 | ✅ **已修复**：报 `unknown_field` 并**列出允许的字段名** | [测] |

**P0-6 / P0-7 的实测证据**（同一批 5 条操作，2 成 3 败，成功的没有回滚）：

```
applied: index 0（FRAME 创建）、index 2（SVG 插入）
failed:  index 1 → code:"network"        iconify API 不可达
         index 3 → code:"tool_failed"    CSP 禁止 unsafe-eval
         index 4 → code:"invalid_value"  field:"fills[0].color"
```

### 9.2 新增能力（第一部分完全没有）

| 能力 | 状态 | 说明 |
|---|---|---|
| `STAR` / `POLYGON` / `LINE` | ✅ | 星形、三角形、直线均正确渲染 [视] |
| `SECTION` | ⚠️ 可用但默认样式有问题 | 默认填充 `#444444` + 白色 1px 描边，渲染成不透明深灰块 |
| `COMPONENT` | ⚠️ 可创建，但无法实例化 | 无 `INSTANCE` 类型，组件只是个带标记的 Frame |
| `svg` 动作 | ✅ | 内联 SVG path 可直接插为 FRAME [视] |
| XPath 查询 | ✅ | `//TEXT[@name="..."]`、`//*[@name="A" or @name="B"]` 均命中正确 [测] |
| 颜色 alpha | ✅ | `#RRGGBBAA` 被接受并正确渲染半透明 [视] |
| `align` / `counterAlign` | ✅ | 布局主轴/交叉轴居中，实测子节点坐标精确居中 [测][视] |
| 中文字体族名 | ✅ | `"微软雅黑"` 与 `"Microsoft YaHei"` 等价可用 [测][视] |
| 批量嵌套创建 | ✅ | `children` 嵌套 + 一条批次 13 个节点全部成功 [测] |

### 9.3 布局对齐的实测数值校验

`D12-布局对齐` 容器 60 高、padding 12（内容区 36 高），子节点高 20 与 32：

- 子 A 的 y = 12 + (36−20)/2 = **20** → 读回 `y:20` ✅
- 子 B 的 y = 12 + (36−32)/2 = **14** → 读回 `y:14` ✅

**结论：交叉轴居中是真实几何计算，不是视觉近似。**

---

## 10. 仍然存在的缺陷（按优先级）

### 10.1 高优先级

| 编号 | 缺陷 | 实测表现 | 建议 |
|---|---|---|---|
| **R1** | `layout.sizing` 不存在，布局容器尺寸不可控 | 声明 `width:300` 的布局 Frame 读回只有 **94**——被 hug 收缩到内容宽度；改 `sizing` 报 `unknown_field`，允许字段只有 `mode,gap,padding,align,counterAlign` | 增加 `sizing:{horizontal,vertical}`（`HUG`/`FIXED`/`FILL`）。当前无法做「固定宽度卡片内自动布局」这类最常见结构 |
| **R2** | `IMAGE` 填充不可用且静默失败 | `imageHash:"abc123"` 写入成功、读回成功、**画面上什么都看不到**，也不报错 | ① 无有效 hash 来源 → 提供上传/相册通道；② 无效 hash 必须报错而非空白 |
| **R3** | `icon` 依赖远程 API，离线必失败 | `code:"network"`，`api.iconify.design` 请求 `<no response>` | 内置常用图标子集（本地 JSON / 打包字体），或失败时降级为占位方块并 `warn` |
| **R4** | `render(jsx)` 被 CSP 阻断，完全不可用 | `script-src 'self' 'wasm-unsafe-eval'` 不允许 `unsafe-eval` | 改用**非 eval 的结构化 DSL**（JSON 组件树）替代 JSX 字符串，避免 eval 又能保留简洁语法 |

**R1 影响最大**：它让「固定宽度的自动布局容器」这个最基础的 UI 结构做不出来。当前所有含 `layout` 的 Frame 都会收缩成 hug。

### 10.2 中优先级

| 编号 | 缺陷 | 实测表现 |
|---|---|---|
| R5 | `SECTION` 默认样式不合理 | 默认 `fills:#444444` + `strokes:#ffffff`，深色实心块，无法作为中性分区标识 |
| R6 | 渐变 `angle` 写入生效但读回丢失 | 写入 `angle:90` 视觉上是垂直渐变 [视]，读回 `fills[]` 只有 `stops`，没有 `angle` |
| R7 | effect 颜色 alpha 被剥离 | 写入 `#00000040`，读回变成 `#000000`。视觉阴影正常，但读回信息丢失，模型无法复现 |
| R8 | 无 `INSTANCE` / `GROUP` | 组件创建后无法实例化；也无分组语义 |
| R9 | `undo` 无描述信息 | 只返回 `revision`，不说明撤销了什么；且为整批粒度，无法单节点回退 |

### 10.3 低优先级 / 体验问题

| 编号 | 缺陷 | 说明 |
|---|---|---|
| R10 | `design_read` 每次都附带完整 `fonts.status` | 单次读取额外约 1.5k token；建议改为 `includeFonts:false` 按需开启 |
| R11 | 字体目录仅 9 个族，CJK 只有 `Microsoft YaHei` | `Noto Sans SC`/`PingFang SC`/`Source Han Sans SC` 均标 `substituted → Inter` |
| R12 | 字体报告语义与视觉不一致 | 上述三族被标 `substituted`（issues 非空），但**改进后中文实际渲染正常** [视]。报告说有问题、画面却对，会误导模型 |
| R13 | 无导出到文件 | `design_screenshot` 只把图返回给模型上下文，无法在项目内生成 `.png/.svg` 资产 |
| R14 | 无页面管理 | 只能读当前页，不能建页/改名/排序 |

**R12 值得单独说**：改进前这三族是**空白**，改进后**正常显示**。说明字体回退链修好了，但 `substituted` 的判定逻辑没跟着更新，仍然按「名义字体 ≠ 使用字体」报 issue。建议改为「只有当目标字形确实缺失时才报」。

---

## 11. 实测能力矩阵（汇总）

图例：✅ 可用并已视觉验证 ／ ⚠️ 有条件可用 ／ ❌ 不可用

| 类别 | 项 | 状态 |
|---|---|---|
| 图元 | FRAME / RECTANGLE / ELLIPSE / TEXT / STAR / POLYGON / LINE / COMPONENT | ✅ |
| 图元 | SECTION | ⚠️ 默认样式问题（R5） |
| 图元 | INSTANCE / GROUP / VECTOR | ❌ 不存在 |
| 填充 | SOLID（含 alpha） | ✅ |
| 填充 | GRADIENT_LINEAR | ✅（读回丢 angle，R6） |
| 填充 | IMAGE | ❌（R2） |
| 描边 | color / weight / align | ✅ |
| 效果 | DROP_SHADOW / INNER_SHADOW / LAYER_BLUR | ✅（读回丢 alpha，R7） |
| 效果 | BACKGROUND_BLUR | 未测 |
| 文字 | fontSize / fontWeight / italic / lineHeight / letterSpacing / align | ✅ |
| 文字 | autoResize HEIGHT / WIDTH_AND_HEIGHT | ✅ |
| 文字 | fontFamily（含中文族名） | ✅ |
| 文字 | 无效 fontFamily | ✅ 正确报错 |
| 布局 | mode / gap / padding / align / counterAlign | ✅ |
| 布局 | sizing（HUG/FIXED/FILL） | ❌（R1） |
| 操作 | create / update / delete / undo / query | ✅ |
| 操作 | icon / render(jsx) | ❌（R3 / R4） |
| 校验 | 逐条 failed[]、unknown_field、invalid_value、font_not_available | ✅ |
| 回读 | design_screenshot（页面/节点/多节点/缩放） | ✅ |
| 回读 | design_read（全字段 + XPath 过滤） | ✅ |

---

## 12. 建议的下一步优先级

按「阻塞程度 ÷ 实现成本」排序：

1. **R1 `layout.sizing`** —— 一个字段，解开最基础的布局能力
2. **R2 `IMAGE` 校验** —— 至少让无效 hash 报错，别静默画空白
3. **R4 用 JSON DSL 取代 JSX** —— 顺手解掉 CSP 限制
4. **R3 图标本地化** —— 离线可用
5. **R7 / R6 读回补全** —— 让读回与渲染一致
6. **R5 SECTION 默认透明** —— 一行默认值
7. **R10 字体报告按需返回** —— 省 token
8. **R12 修正 substituted 判定** —— 避免误导
9. **R8 组件实例** —— 体系化能力
10. **R13 导出到文件** —— 交付闭环

---

## 13. 修正记录（对第一部分的更正）

第一部分有几处结论在复测后被推翻，如实记录：

| 位置 | 原结论 | 复测后的实际情况 |
|---|---|---|
| 第 1 节能力表 | 「图元仅 4 种，无 STAR/POLYGON/LINE/SECTION/COMPONENT」 | ❌ 已过时，现均可用 |
| 第 1 节能力表 | 「描边/透明/旋转写入不报错，读回全不返回」 | ❌ 已修复，三者均落库并读回 |
| 第 7 节 | 「`能力探测-A` 的 P6/P7/P8 **待目视确认**」 | ✅ 已确认：三者全部生效（描边红框、半透明、15° 旋转） |
| 第 6 节字体表 | 「SimSun / Noto Sans SC / PingFang SC / Source Han Sans SC **全部空白**」 | ⚠️ 已修复，现均正常渲染；仅 `substituted` 报告仍标异常（R12） |
| 第 8 节行动清单 | 「先接 5 个最小工具」 | ✅ 已完成，且超出预期 |
| 全文 | 「`render` 支持 JSX，是路线 C 的关键工具」 | ❌ 实测被 CSP 阻断，路由走不通（R4） |

**第一部分第 7 节的探测区已清理**：`字体探测`、`能力探测-A/B/C` 四块面板已从画布删除（revision 29）。保留 `探测D-新能力` 作为已生效能力的可视化对照。

**登录页未受影响**：`App 登录页`（390×844）全部 18 个文本节点、信号/WLAN/电池图标中文与图形均正常 [视]。

