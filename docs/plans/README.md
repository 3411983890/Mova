# 方案文档索引（docs/plans）

> 这里是**所有方案 / 设计 / 实施契约**类文档的唯一存放处（见 `../conventions.md` §1、§6「禁止把方案文档写到仓库根目录」）。
> 目录结构看 [`../architecture.md`](../architecture.md)，开发规范看 [`../conventions.md`](../conventions.md)。
> 视觉参照原型（HTML）在 [`../prototypes/`](../prototypes/)。

新增文档：`docs/plans/<中文主题>.md`，开头先写「结论」再写「论证」，然后回到本索引加一行。

---

## 架构类

- [Mova iOS 开发环境与框架](Mova-iOS开发环境与框架.md) — Windows + Expo + iPhone 的独立移动工程、手机预览步骤、原生组件和后续云构建。

- [Mova开发方案](Mova开发方案.md) — 项目总纲：形态、技术栈与分层的最初方案，后出的专项文档都以它为背景。
- [Mova服务版接口约定](Mova服务版接口约定.md) — 多个子代理并行开发时共享的数据、IPC 与设置契约（含 `scripts/services.mjs`、`scripts/pitr.mjs` 的边界）。
- [Mova本地能力技能化与MCP暴露方案](Mova本地能力技能化与MCP暴露方案.md) — 本地能力收敛成独立技能包并通过 MCP 暴露的架构，是 `electron/skills/` 的设计依据。
- [Mova权限设计](Mova权限设计.md) — 权限位、审批与审计的三层模型，对应 `electron/permissions.cjs` / `electron/agent-tools.cjs`。
- [Mova上下文压缩与Agent上下文工程方案](Mova上下文压缩与Agent上下文工程方案.md) — 上下文账本、摘要与压缩队列的设计（`electron/context/`）；结论是「按段计数、超预算才压缩、压缩自身用量单独上报」。
- [Mova长期记忆与聊天体验开发文档](Mova长期记忆与聊天体验开发文档.md) — 长期记忆（抽取/检索/维护/隐私保险柜）与聊天体验的实现文档，对应 `electron/services/memory-*.cjs`。
- [Mova-Bot开发与调研方案](Mova-Bot开发与调研方案.md) — Bot 身份、会话编排与能力挂载的服务端化调研；`electron/bots/` 的预留位置由它而来。
- [Mova 云电脑 CLI 与 iPhone 跨端助手方案](Mova云电脑CLI与iPhone跨端助手方案.md) — 自托管 Linux 运行、三端同步及联网研究、网站代办、邮件日历的首版计划。
- [Mova Linux CLI 详细开发方案](Mova-Linux-CLI详细开发方案.md) — 本机 Ubuntu 验证、ChatGPT 与 Gemini 订阅、VPN 同步、无头浏览器和 Skill 移植。
- [logging-design](logging-design.md) — 运行日志系统的设计取舍：只记日志、绝不 `process.exit`，接线方式与轮转/脱敏边界。

## 能力类

- [Mova桌面操作开发方案](Mova桌面操作开发方案.md) — Desktop Engine / Computer Use v1：截图→元素→动作的闭环与安全闸门（`electron/desktop/`）。
- [Mova浏览器MCP开发方案](Mova浏览器MCP开发方案.md) — Browser Agent v1：CDP 控制、快照/读取/等待/批处理与站点技能（`electron/browser/`）。
- [Mova浏览器提速与计时实施方案](Mova浏览器提速与计时实施方案.md) — 端到端计时语义、批处理复用、导航即观察与条件等待；报表见 `scripts/browser-timing-report.cjs`。
- [Mova联网搜索增强方案](Mova联网搜索增强方案.md) — 把单点搜索升级成「多源并发 + 正文阅读 + 重排融合 + 引用可核验」（`electron/search/`）。
- [Mova搜索增强-实施契约](Mova搜索增强-实施契约.md) — 搜索增强的落地约束清单（子 agent 必读版），定义哪些文件可动、哪些行为不许退化。
- [Mova上下文注入实测](Mova上下文注入实测.md) — 新对话首次请求里到底注入了什么，与主流 Agent 的对比实测记录。

## 界面类

- [Mova设计规范](Mova设计规范.md) — 视觉与交互总规范：颜色/间距/动效/图标来源，以及「先建立映射再收敛」的改造纪律。
- [Mova设置页设计规范](Mova设置页设计规范.md) — 设置页的布局、密度与控件约定（66% 换行规则等），新设置页照此实现。
- [Mova链接与文件视图开发方案](Mova链接与文件视图开发方案.md) — 右侧面板从「看网页」升级为统一的链接与文件视图（网页/代码/Markdown/图片/PDF/目录 + 选区引用），v1.0 已实施。

## 订阅与模型类

- [Mova订阅额度登录方案](Mova订阅额度登录方案.md) — 用 ChatGPT（Plus/Pro）与 Gemini（AI Pro/Ultra）订阅额度驱动 Agent，而不是只靠 API Key（`electron/subscription/`）。
- [Mova-CLI模型-开发文档](Mova-CLI模型-开发文档.md) — CLI 模型（安装、登录、模型列表、额度面板）的开发文档，草案 v0.2，视觉基准见 `../prototypes/cli-models-settings.html`。
- [Mova-Gemini后台执行-前端接入方案](Mova-Gemini后台执行-前端接入方案.md) — Gemini 以「后台 CLI / ACP 执行器」形式运行并把全部事件接回现有前端；结论是 ACP 事件可一一映射到现有行类型。
- [round6-codex-oauth](round6-codex-oauth.md) — 该方案的第一批落地记录：ChatGPT 走 Codex OAuth，Gemini 走 ACP 强制重授权。
- [t3code-auth-analysis](t3code-auth-analysis.md) — t3code 如何接 ChatGPT / Gemini 订阅额度的源码分析，以及对本项目的取舍结论。

## 历史报告

- [cli-models-delivery](cli-models-delivery.md) — CLI 模型三轮并行交付的完结报告（含缺陷证据与复验命令 `node scripts/accept.mjs`）。
- [round5-report](round5-report.md) — 第五轮验收：登录后可用性、模型配置、运行日志。
- [agents-brief](agents-brief.md) — 当时的并行开发简报（划清每个子智能体只碰自己的文件），作为流程记录保留。
