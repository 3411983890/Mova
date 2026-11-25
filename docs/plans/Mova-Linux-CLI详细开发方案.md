# Mova Linux CLI 详细开发方案

2026-11-17 · 本机虚拟机验证及后续自托管部署

当前安装、桌面与手机配对、模型配置和备份步骤见本文「当前版本部署与使用」。下面保留原始研发设计与早期实验。

## 结论

先在这台 Windows 电脑上安装独立的 Ubuntu 24.04 LTS WSL2 发行版。Linux 里运行常驻 Mova 服务、Mihomo、官方 Codex、官方 Antigravity CLI 和轻量无头浏览器。`mova` 是控制和聊天入口，常驻服务负责执行任务。Windows 下一个开发阶段就是把现有 Bot 和 VPN 路由配置送到 Linux，并在桌面查看同一项任务。

浏览器第一候选为 `chrome-headless-shell`，用 Chrome DevTools Protocol（CDP）接现有浏览器 Skill。Lightpanda 加入对照测试，完整 Chrome 无头模式作为兼容候选。验收标准是现有工具的实际行为和虚拟机实测开销。

模型分三条执行路径。ChatGPT 订阅首选官方 Codex App Server，Gemini 订阅走官方 `agy acp`，API Key 模型继续走可移植的 Pi 执行链。三条路径共用 Mova 的任务、事件、网络路由和 Skill 权限。ChatGPT 与 Gemini 两个订阅按需求分配 VPN 线路，授权、模型、额度和后台任务都要在同一个 Linux 宿主内验证。

## 1. 本机 Linux 验证环境

现场只读检查显示本机为 Windows 11 家庭版、x64、约 31 GiB 物理内存，已启用 WSL2，现有发行版清单仅见 Docker Desktop。微软明确限制家庭版安装完整 Hyper-V 角色，因此首选独立 Ubuntu WSL2 实例。它可验证 Linux 进程、systemd、SSH、模型、代理和无头浏览器。对开机、网络隔离、云机重启及远程接管做最终验证时，再使用独立 Ubuntu Server 虚拟机或目标云机。[Windows 的 Hyper-V 限制](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v) · [Ubuntu WSL 安装](https://documentation.ubuntu.com/wsl/latest/howto/install-ubuntu-wsl2/) · [WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd)

计划中的首次操作如下。本次调研没有创建发行版或安装组件。

```powershell
wsl --list --online
wsl --install -d Ubuntu-24.04
wsl --list --verbose
```

本机部署记录（2026-11-17）。Ubuntu 24.04.5 LTS 已注册为独立的 `Ubuntu-24.04` WSL2 实例，systemd 为 PID 1，默认用户为 `mova`。Chrome for Testing Headless Shell `157.0.8103.78` 安装在 `/opt/mova/chrome-headless-shell/157.0.8103.78`，终端可直接执行 `chrome-headless-shell`。已验证 HTTPS 页面加载、本地 CDP 连接、可访问性树、表单输入、点击、PNG 截图及渲染进程沙箱。测试的 CDP 监听只绑定回环地址并在结束后释放。结果保存在 Linux 的 `~/.local/state/mova/browser-smoke/`。

首个 Linux CLI 命令已安装到 `~/.local/bin/mova`。进入 Ubuntu 后可运行 `mova browser inspect https://example.com/ --screenshot "$HOME/mova-example.png"`。该入口复用 Mova 浏览器 Skill，输出页面结构与正文，可按需保存截图。它通过进程管道连接 CDP，每次只访问命令中指定的公网 HTTPS 站点。Bot 后台任务、网站交互与跨端审批属于后续接线。

Linux 已安装 Node 24、Codex CLI `0.169.0`、Antigravity CLI `1.5.10` 和 Mihomo `1.19.34`。在同一 Mova 用户下验证了 Codex App Server 和 Agy ACP 的本地协议握手，也用临时配置验证了 Mihomo 的回环监听与 `REJECT` 规则。Windows 桌面配置中已有两个订阅提供商的线路分配。真实调用验收需要把相应线路安全同步到 Linux，再完成各自账号授权。

- 源码、Node 依赖、浏览器 profile 和数据目录放在 Linux 文件系统。通过源码同步或干净检出拿到当前 Mova 项目，再在 Linux 内装依赖。Windows 的 `node_modules`、Electron 构建产物和代理二进制留在原宿主。
- 独立 VM 可先给 4 vCPU、6–8 GiB 内存、约 50 GiB 动态盘。这是验证起点。WSL 首轮沿用现有全局资源配置，先测实际峰值，避免调整当前 Docker Desktop 的共享资源预算。
- 开发配置先跑 Node 24、PostgreSQL、Mihomo 和所选浏览器。云端任务首版使用 PostgreSQL 业务表和持久作业。MinIO、Redis、向量模型随需要该能力的 Skill 加入。Linux 安装分别验证 `npm ci` 的现有依赖安装路径与服务端最小运行产物，部署包仅携带服务实际需要的代码和依赖。
- WSL 基线通过 Windows 到 Linux 的本机连接做桌面联调。真正的云版用私网或受鉴权的 HTTPS。Linux 内的 MCP、CDP、数据库和 Mihomo 控制器走内部连接。验证 Windows 关桌面、Linux 守护进程重启和虚拟机整机重启三种情形。WSL 开关与宿主休眠下的行为记入实测，持续在线用目标云机验收。[WSL 网络](https://learn.microsoft.com/windows/wsl/networking)

## 2. 常驻服务、CLI 与任务协议

| 组件 | 职责 | 首轮落地方式 |
| --- | --- | --- |
| `mova` | 聊天、提交任务、看进度、回答、审批、取消、登录与环境诊断 | Node ESM CLI，提供人读输出和 `--json`。本地管理走用户权限控制的 Unix socket，Windows 与未来 iPhone 走跨端 API。 |
| Mova 服务 | 持久化 Bot、会话、任务、事件、设备配对和配置版本 | systemd 常驻。参考已存在的 `electron/bots`，把 Electron IPC 改成宿主适配层。使用数据库事务落业务状态与事件。 |
| Worker | 领取任务、冻结本次模型与线路配置版本、启动执行器、调用 Skill、写回结果 | 第一阶段一个 Worker，数据库租约与心跳管理运行权。一个已登录浏览器 profile 同时只允许一个主动控制者。 |
| 模型子进程 | 承载 Codex 和 Agy 会话及本地账户状态 | 分开的用户目录和可控进程边界。启动时只注入该模型所需代理环境、当前工作区和 MCP 授权。 |
| Linux 宿主适配 | 浏览器、文件、审批、搜索、凭据、通知、进程生命周期 | 复用现有 skill manifest 和权限判定，替换依赖窗口、注册表、系统加密与 Windows 进程行为的适配。 |

首轮命令面如下，`mova` 命令均为拟实现接口。

```text
mova doctor [--json]
mova bot list
mova chat --bot <bot-id>
mova task submit --bot <bot-id> "比较三个方案，并保存带来源的计划"
mova task list [--status running]
mova task watch <task-id> [--after <cursor>]
mova task answer <request-id>
mova task approve <approval-id>
mova task cancel <task-id>
mova model list
mova model auth <provider>
mova model usage <provider>
mova vpn status
mova vpn sync preview <revision>
mova vpn sync apply <revision>
mova browser doctor
```

`task submit` 落库并返回任务 ID，`task watch` 基于事件游标续接。关闭终端或暂时断网只结束观看，`task cancel` 明确请求停止。任务保存模型和线路归属、计划、工具动作回执、下一步和当前等待项。聊天流保留必要的最终文本与工具摘要。等待审批时可继续从 Windows 或 CLI 操作，批准后重验目标、参数、权限和有效期。Worker 重启时，已确认完成的步骤从检查点恢复，提交状态不明确的外部动作先查询回执。跨端协议沿用上一份方案中的 REST、SSE 和事件补收。[跨端助手方案](Mova云电脑CLI与iPhone跨端助手方案.md)

## 3. 模型迁移与订阅登录

| 模型类型 | 当前项目 | Linux 主路径与验收 |
| --- | --- | --- |
| API Key 模型 | Pi 接 OpenAI Chat Completions 或 Anthropic 等已配置提供商，模型列表、思考强度、视觉能力由提供商与模型目录决定。 | 提取协议、凭据读取、工具装配和事件映射，Linux 独立录入 API Key。保留自定义 API 地址及模型元数据。桌面 `127.0.0.1` 网关在 Linux 要独立部署或显式改地址。 |
| ChatGPT 订阅 | 桌面用 Codex OAuth 及 Pi 的 `openai-codex-responses` 访问 ChatGPT 后端。Bot IPC 调用订阅时主要收集文本和部分用量。 | 首选官方 Codex App Server 以 ChatGPT 账户登录，读取模型目录和账户限额，接 `thread/start`、`turn/start`、中断及审批通知。通过 MCP 挂现有 Skill。验证请求确实按 ChatGPT 登录工作并显示该账户实际可用的 Codex 模型和限额。 |
| Gemini 订阅 | Antigravity CLI 定位已有 Linux 候选路径，ACP 的 JSON-RPC、权限映射、计划、工具和诊断翻译已有实现。部分额度抓取依赖 Windows ConPTY。 | 在同一 Linux 服务身份下从 Google 官方渠道安装 `agy`。走 SSH 官方授权，验证 `agy acp` 初始化、模型目录、真实任务、MCP 和取消。额度探测单独验收，授权可用但额度取不到时显示「额度未知」。 |

桌面链路可直接核对到模型和订阅接线。Linux 要抽出底层执行与能力装配，避免在无窗口环境调用原有 IPC 宿主。统一执行器契约记录 `catalog`、`authStatus`、`usage`、`start`、`cancel` 及其状态事件。三条路径都报告模型所见的工具和手段，执行失败以可诊断状态呈现。[桌面模型入口](../../electron/model-ipc.cjs) · [Pi 与 ACP 装配](../../electron/chat-agent.mjs) · [Bot 当前接线](../../electron/bots/ipc.mjs) · [ACP 客户端](../../electron/acp/client.mjs) · [事件翻译](../../electron/acp/translate.mjs)

### ChatGPT 订阅

1. Linux 安装固定、可升级的官方 Codex 版本。若账户或工作区允许设备码，在验证用的 Linux 服务身份下运行 `codex login --device-auth`，在 Windows 浏览器完成授权。设备码不可用时按官方远程登录说明使用浏览器登录与 SSH 回调转发。服务读取同一运行身份的本地登录状态。窗口中的 OAuth 回调、Windows 加密文件及长期令牌都留在原端。[Codex 认证](https://developers.openai.com/codex/auth/)
2. 用官方 App Server 的 stdio 接口验证 `account/read`、`model/list`、`account/rateLimits/read`、`thread/start`、`turn/start` 与取消事件。配置只包含 Linux 沙箱、指定工作区、Mova MCP 和最小授权。把供应商 thread ID 与 Mova 会话 ID 分开保存。额度来自官方返回，保留各限额窗口/重置时间及未知状态。[Codex App Server](https://developers.openai.com/codex/app-server/)
3. 用一条真实任务验证「ChatGPT 已登录 → 走指定 VPN → 调用 Mova 搜索/浏览器 Skill → 结果回到 Mova」。用官方 MCP 配置及 `bearer_token_env_var` 对接服务内部端点。首轮确认配置作用域、连接器令牌的生命周期、原生工具的可授予范围，以及 VPN 路由发生变化后的进程重建。单用户场景先以一个隔离执行器处理任务，避免把多个任务共用的环境变量当作单任务权限。[Codex MCP](https://developers.openai.com/codex/mcp/)
4. 现有桌面订阅桥继续供桌面使用。Linux 原型以官方运行器为发布门槛。ChatGPT 订阅选用账户内的 Codex 权益。API Key 模型是显式选择的另一条费用和身份渠道，限额耗尽、模型不可用或未登录要提示原因。[Codex 认证](https://developers.openai.com/codex/auth/)

### Gemini 订阅

1. 按 Google 官方说明安装 Antigravity CLI，记录 `agy --version` 和实际 Linux 路径。使用同一个 Linux 运行账户和当前选定线路，通过 SSH 登录 `agy` 后按官方流程打开授权网址并回填验证码。验证使用账户身份、服务重启后还能读取登录态，以及无 GUI 时系统 keyring 或对应的凭据方式是否可用。登录和常驻服务必须使用一致的用户和 profile 配置。[Antigravity 安装与远程授权](https://antigravity.google/docs/install?tab=cli)
2. 驱动 `agy acp` 的 `initialize → session/new → session/prompt`，处理计划、工具动作、权限回调、用量、提示和取消。优先复用 [现有 CLI 定位](../../electron/subscription/cli.mjs)、[授权探测](../../electron/subscription/acp-auth.mjs) 和 [ACP 运行器](../../electron/acp/engine.mjs)。把 `agy` 进程的 stdout 作为协议流，诊断写 stderr。使用真实握手和模型目录判断兼容性。
3. 用当前 `mova-tools` 认证 MCP 服务挂搜索、计划和浏览器。以 pinned Linux 版本验证 `session/new` 后实际出现的 `tools/list` 与 `tools/call`。工具回调最终由 Mova 决定可访问资源，Agy 原生文件和终端能力还需宿主级约束。Windows 版的 ConPTY 探针在 Linux 单独处理。优先使用可稳定验证的 CLI 额度输出。缺字段时保留最近一次成功值、更新时间和降级原因。[Antigravity ACP](https://antigravity.google/docs/cli/acp/) · [当前用量探针](../../electron/subscription/gemini-usage-cli.mjs) · [Mova MCP](../../electron/mcp/server.mjs)
4. Linux 补齐进程树收尾。按执行器启动独立进程组或 systemd 管理单元，先发协议取消，再终止该单元或组内残留进程。验收子进程归零、浏览器控制权释放，以及下一次 `session/new` 恢复。测试中同时运行另一个任务，确认它的进程不受影响。

## 4. 从 Windows 同步 VPN 与模型配置

现有 `router`、`runtime-config`、`mihomo-manager`、订阅解析、节点健康检查可在 Linux 复用，Windows `safeStorage` 与 Electron 对话框用本机适配封装。当前测试明确覆盖「已分配线路、运行端口缺失时降级直连」。Linux 对 ChatGPT 和 Gemini 加入结构化的 `proxy_required` 策略。线路缺失、健康检查失败或没有可用替换节点时，任务暂停在网络等待状态。供应商真实请求必须经过所选线路。[路由](../../electron/vpn/router.mjs) · [运行时](../../electron/vpn/runtime.mjs) · [线路存储](../../electron/vpn/store.mjs) · [Mihomo 官方发行版](https://github.com/MetaCubeX/mihomo/releases)

| 同步类别 | 从桌面到 Linux 的处理 |
| --- | --- |
| 模型和 Bot 配置 | 同步稳定 provider/model ID、模型标签和能力、Bot 选择的模型和思考配置。Linux 用真实目录校验 ID；缺失时提示选择可用模型。 |
| VPN 策略 | 同步策略池、选定节点引用、provider 默认路线、model 级覆盖、允许区域、同区故障回退及代理必需标记。目标仍用「模型覆盖优先于 provider 默认」。 |
| 节点与订阅秘密 | 首次配对后可选择在 Linux 重新录入，或经设备已鉴权的加密连接显式转移选中的订阅 URL 和节点认证数据。可独立撤销。保存在 Linux 凭据存储，UI 只显示掩码；日志和诊断也走脱敏。 |
| 宿主状态 | Linux 自行生成端口、健康状态、监听地址、运行配置和二进制路径。Windows 的账号 OAuth、CLI profile、浏览器 cookie 及操作系统加密文件按照各自服务在 Linux 授权。 |

同步过程是「授权配对 → Windows 发布版本 → Linux 验签或验证已配对设备 → 预览和校验 → 原子激活 → 回报版本与路由健康」。首版由桌面管理已同步的规则，Linux 管额外本机绑定和服务状态。重复导入同一版本复用前次结果。错误节点、版本倒退、配置冲突或服务启动失败时继续使用上一有效版本。正在执行的任务记录所用配置版本，线路变更由新任务使用。用户撤销权限即时生效。Linux 端应验证正式的 Mihomo 配置及本地监听器，再将版本标为已应用。

需要分别验证 Codex/Agy 的浏览器授权与 Linux 侧令牌兑换、模型目录、ACP/模型进程的实际流量、额度探测和更新。API 走按请求绑定的 ProxyAgent，Agy/Codex 用受控子进程代理配置。若某个运行器不遵循代理环境、另起进程或使用不同的网络传输，在 Linux 用进程隔离与出网策略限制其仅接触相应代理和被授权的本地 MCP，同时实测协议可用性。系统健康信号和代理环境存在只能证明配置已注入。需要真实请求、监听器的连接记录和停代理失败测试证明线路生效。`NO_PROXY` 仅包含必要的本地回环。浏览器任务和联网搜索按各自网络策略执行，模型订阅的代理环境只注入相应运行器。

Mihomo 运行 YAML 及本地账户文件按敏感配置处理。Linux 服务用权限隔离与可用的系统凭据存储管理加密材料，目录权限以服务账户为限。其他设备只能通过设备连接看状态和提交配置。同步、额度和诊断的响应中避免包含账号令牌、代理密码、订阅 URL 和原始环境变量。

## 5. 极轻无头浏览器

| 候选 | 适合承担的角色 | 首轮验证重点 |
| --- | --- | --- |
| **`chrome-headless-shell`** | 首选。Chrome 官方独立无头二进制，依赖少，适合截图和自动化。 | Linux x64 下载固定版本，保留沙箱。验证 CDP 可访问性树、DOM、输入、截图、跳转、下载和 cookie 持久化。[Chrome 官方说明](https://developer.chrome.com/docs/automation-and-testing/headless-chrome-shell) |
| **Lightpanda** | 作为极轻量实验组，面向通过能力探针的公开页研究任务。 | 用项目官方 Linux 构建跑同一批页面和工具。只有所需 CDP、DOM 和 JS 测试都通过才纳入该类任务。Chrome 同样参加实测。[Lightpanda 项目](https://github.com/lightpanda-io/browser) |
| **完整 Chrome 无头模式** | 复杂网页、官方 Chrome 行为或 shell 不兼容时的可选引擎。 | 跑真实代表网站，对比新无头模式的功能覆盖、资源用量与登录会话表现。[Chrome 无头模式](https://developer.chrome.com/docs/automation-and-testing/headless/) |

把 `electron/browser/cdp.cjs` 的现有 `send/on/close` 形态作为宿主边界。Linux 侧负责启动 Chromium、连接私有 CDP、维护目标会话与事件、转译下载和关闭进程。`PageTarget` 的 Electron `loadURL`、窗口可见性、输入事件、`DownloadItem` 改由 Linux 适配。快照、正文提取、动作、等待、批处理、差异和站点步骤优先共享。一个用户可复用同一浏览器进程，任务使用隔离的上下文。需要持久登录的站点用单独持久 profile，并锁定切换和控制权。首期用固定小并发和空闲回收控制内存。代理变更或引擎换用时开新上下文，已登录和已提交的任务保持原来的状态记录。[当前 CDP](../../electron/browser/cdp.cjs) · [PageTarget](../../electron/browser/target.cjs) · [浏览器控制器](../../electron/browser/controller.cjs)

基准使用同一 VM、浏览器版本与固定案例，逐项记录冷启动至就绪、首个快照、完成时间、进程组/服务单元峰值内存、空闲 CPU 和功能通过率。至少测试静态页面、动态网页、含 iframe 的表单、截图、文件下载、登录状态恢复，以及提交结果不明确时的处理。把 Web 搜索和正文抽取保留为低开销路径。涉及交互、渲染或登录才启动浏览器。轻量引擎节省多少资源由实测给出。

无头浏览器先提供结构化快照、截图和任务状态。人工接管分两步：第一步遇到登录、验证码或二次验证时让任务进入等待，验证受控恢复；第二步给同一会话接入受保护的画面与输入入口，或在同一默认引擎的专用 profile 上使用独立有头会话。接管期间停止 Bot 输入，恢复时重新观察。CDP 只在服务内部开放。浏览器默认使用隔离的受限工作用户和下载目录。公开网页访问与内部 MCP 走分离网络边界，并对内部地址、重定向和本地文件访问实行限制。真实网站提交只走用户明确授权的流程。

## 6. Skill 迁移清单

当前 8 个 pack 已形成统一 manifest、输入 schema、权限、工具事件和结果预算。Linux 根据已安装的宿主能力注册同一套 pack，再由 Pi 直接调用或由 Codex/Agy 经 MCP 调用。MCP 只暴露当前任务能力，权限和审批仍在服务端验证。保留工具名、结果结构和审计标识，手机、Windows 与 CLI 可以复用任务卡。[当前 Skill 清单](../../electron/skills/packs/index.mjs) · [运行装配](../../electron/skills/turn-runtime.mjs)

| Pack | 迁移批次和宿主替换 | 可验证结果 |
| --- | --- | --- |
| `goal-plan` | 第一批。复用状态和 schema，把窗口审批、提问替换为持久请求与跨端响应。 | 运行卡呈现计划、当前步骤和等待原因。CLI 退出后仍可在桌面答复。 |
| `web-research` | 第一批。复用多查询、正文读取、证据包装与引用校验，改 Linux 出口和搜索凭据。 | Codex、Agy、API 模型返回同结构的检索事件与来源。 |
| `context-ledger` | 第一批。复用账本、预算和原文索引，事件改由任务服务持久化。 | 换端重连能看到最终消息、关键工具摘要和用量。 |
| `browser-automation` | 第一至第二批。按快照、读取、等待、导航和截图起步，追加页面动作、标签、批处理、下载、人工接管、上传、站点步骤。最后补受控登录与状态管理。 | 同一个测试网页能用三条执行链调用 `mova_*` Skill，工具审批、下载路径和提交回执一致。任意脚本与浏览器凭据相关入口在能力审查后单独启用。 |
| `project-fs` | 第二批。Linux 工作区适配、`realpath`/符号链接路径验证、差异和原子写入。按项目授权启用文件工具。命令能力在 OS 隔离和审批验证后独立开放。 | 允许根目录可读写，拒绝审批时保持文件原样。空根目录、越界路径、符号链接和未经授权的命令均拒绝。 |
| `memory` | 第二批。先用云端工作区的 Bot 偏好、历史与来源归属。按需接向量和保留策略。 | 新云 Bot 的授权记忆能跨端读取，主动导入按既定范围保留。 |
| `desktop-control` | 后续。Windows UIA/PowerShell 接线已有，Linux 需要单独的图形宿主能力，再挂同一 manifest。 | 有 Linux 图形宿主时单独验证截图、输入和人工接管，纯无头服务的工具列表根据宿主能力生成。 |
| `design-canvas` | 后续。先验证现有画板运行时和渲染依赖的无窗口方式，再接共享画布。 | 图稿改动和截图回执可在桌面核对。 |

模型原生能力还要独立验证。ACP 回调能管经过宿主的文件和终端请求，权限边界最终由 Linux 沙箱、项目根和服务身份共同保证。Codex/Agy 只看到当前任务允许的项目数据和指定凭据接口，文件、命令、浏览器的权限校验和人工审批沿用已有规则，并记录调用结果。测试覆盖嵌套进程、审批后权限撤销、工作区外访问、人工接管中的工具调用，以及向同一任务重复发送确认。[项目权限和命令](../../electron/agent-tools.cjs) · [ACP 闸门](../../electron/acp/gate.mjs) · [浏览器 manifest](../../electron/skills/packs/browser-automation/manifest.mjs)

## 7. 实施顺序和交付门槛

| 阶段 | 实现工作 | 放行条件 |
| --- | --- | --- |
| P0 · 本机探针，2–4 个工作日 | 独立 Ubuntu、Node 和 PostgreSQL；Mihomo；固定版本的浏览器和两种官方 CLI。对照 Lightpanda 与完整 Chrome。 | 一条线路跑通两个订阅的真实探针；浏览器快照、截图和表单在本地测试页有记录；盘点 Linux 原生依赖及版本。 |
| P1 · 服务与 CLI，约 1 周 | 健康检查、Unix socket、Bot 和任务存储、事件游标、终端输出及 systemd。 | 提交联网研究任务，退出终端后任务继续。重连能看同一结果。停止服务后只读任务可恢复，显式取消无残留运行。 |
| P2 · 订阅、桌面同步和联网 Skill，1–2 周 | Codex App Server、`agy acp`、API 模型，统一事件与 MCP。桌面配对、VPN 配置增量同步和状态回读。 | 真实账户各跑一项联网任务，模型目录和额度明确区分可用/未知。Windows 修改路由并同步到 Linux，断开代理后没有订阅直连。 |
| P3 · 浏览器操作与权限，1–2 周 | CDP 宿主、共享工具表、截图、填表预览、审批、下载及人工接管试验。接文件工作区和基础记忆。 | 同一浏览器 Skill 由三种执行链调用。重复审批去重，失败可查回执，Windows 与 CLI 可追踪。用实测决定默认浏览器。 |
| P4 · 云机交付验证，约 1 周 | 安装、升级和回滚，数据备份，重启及线路/模型异常演练，准备 iPhone 接入。 | 干净 Linux 云机从安装到可执行；云机和设备分别重连。可用旧版运行配置回滚；外联错误不回退直连。 |

建议先做 P0 探针，验证目标机的账号授权、网络出口和 CDP 覆盖，再冻结依赖版本。按一人集中开发粗估，完整 Linux CLI 及本机 Windows 接入约 5–7 周，取决于两种订阅运行器的授权和代理实测、浏览器接管范围与设备环境。iPhone 原生开发按跨端总方案排期。

规划阶段在 Windows 跑了 ACP、VPN、订阅、Skill 和浏览器专项测试，共 749 项通过。Ubuntu 和浏览器 Skill 的实测结果见本方案第 1 节。真实订阅账号、模型线路和三组浏览器的资源对照仍需验证。

## 当前版本部署与使用

Ubuntu 或 Debian x86_64 的普通用户可从源码目录或解包目录运行下面的安装命令。安装程序保留已有依赖，按需安装 Node.js 24、Bubblewrap、Chrome Headless Shell、Mihomo、Codex CLI 和 Antigravity CLI。

```bash
bash scripts/install-mova.sh --runtime --service
export PATH="$HOME/.local/bin:$PATH"
mova doctor
```

如果需要将安装包复制到另一台 Linux 主机，在当前源码目录运行 `bash scripts/package-mova-cli.sh /tmp/mova-cli.tar.gz`，记录命令返回的 SHA-256。到目标机解包后进入 `mova-cli` 目录，再运行相同的安装命令。已有环境可省略 `--runtime`。要让普通用户服务在注销后和主机重启时运行，可用 `sudo loginctl enable-linger "$(id -un)"` 启用 systemd 用户实例常驻。

本机 WSL 验证时，从 Windows 项目目录运行 `powershell -File scripts/start-mova-wsl.ps1` 启动 Ubuntu 并保持本机连接。Windows 重启后再次运行。结束验证可传入 `-Stop`。Linux 云主机由 systemd 管理服务。[WSL 的 systemd 生命周期](https://learn.microsoft.com/en-us/windows/wsl/systemd#how-does-enabling-systemd-affect-wsl-architecture)

### 配对 Windows 和 iPhone

1. 在 Linux 运行 `mova pair code`，取得五分钟内有效的桌面管理员配对码。
2. 在 Windows Mova 打开「设置 → 云端与连接」，填写服务地址、检测连接，再输入配对码。当前 WSL 验证地址为 `http://127.0.0.1:17642`。
3. 在「网络与线路」为两种订阅提供商选好线路，回到「云端与连接」执行「同步线路」。随后在 Linux 用 `mova model login codex` 或 `mova model login gemini` 授权。Google 的远程登录流程在终端显示 URL，供本机浏览器完成授权。[Antigravity 远程登录](https://antigravity.google/docs/install/#remote-ssh-oauth-flow)
4. iPhone 配对需要手机可访问、系统信任的 HTTPS 域名。TLS 反向代理将流量发送到 Linux 的 `127.0.0.1:17642`。Windows 同样填写该 HTTPS 地址，在「云端与连接」生成手机配对码，再到 iPhone「设置 → 服务连接」填写。
5. 可在桌面「云端工作区」新建共享会话、选 Bot 或主动导入 JSON 档案。手机设置里的 Bot 选择用于新对话。两端打开后自动取回近期会话及任务状态。

桌面「创建项目 → 源文件夹」和「新建群聊 → 工作位置」也可直接添加或选择远程主机。主机的默认模型及「自动同步线路」在「云端与连接」管理。选中主机后，项目和群聊的文本任务会交给该 Linux 服务，结果显示在原聊天里。

Caddy 的单主机配置示例，部署时将域名换为实际服务地址。

```caddy
mova.example.com {
    reverse_proxy 127.0.0.1:17642
}
```

### 运行任务

```bash
mova task submit "查找 Ubuntu 官方安装资料" --provider research
mova task watch <任务ID>
mova chat "总结官方发布资料" --provider codex --research
mova model status codex
mova model status gemini
mova vpn status
```

在 `~/.config/mova/cloud.env` 设置本机运行参数，权限设为 `0600`，然后执行 `systemctl --user restart mova-cloud.service`。联网搜索配置 `MOVA_SEARXNG_URL`、`MOVA_TAVILY_API_KEY`、`MOVA_ANYSEARCH_API_KEY` 中至少一项。配置自托管 SearXNG 时服务需允许 JSON 格式。API 模型配置 `MOVA_API_BASE_URL`、`MOVA_API_KEY`、`MOVA_API_MODEL`，使用 OpenAI Chat Completions 兼容接口。Anthropic Messages 接口另设 `MOVA_API_PROTOCOL=anthropic`。模型任务启用 `--research` 后先走这些搜索源，再把引用资料交给选定模型。

任务和事件保存在单用户 SQLite，两个客户端按游标轮询近期工作区。服务重启后恢复未结束任务。订阅 CLI 使用独立账号目录和隔离网络，线路失效时任务进入等待处理，可按同一任务 ID 重试。订阅模型的目录与额度通过 `mova model status` 检查，供应方没有返回额度时显示「额度未知」。

### 用本地模型管理云项目

在 Mova 桌面打开普通的本地聊天，选择可调用工具的模型。可以直接发「列出 WSL 云主机上的云项目和 API 档案」。桌面通过已配对的管理员连接执行操作。创建或修改项目、从 GitHub 导入文件和提交任务会显示桌面审批。

项目保存名称、项目指令、模型通道、模型 ID、API 档案和导入的工具。`mova_cloud_hosts` 查找主机，`mova_cloud_projects_list` 查看项目和 API 档案，`mova_cloud_project_get` 读取配置。`mova_cloud_project_save` 和 `mova_cloud_project_import` 使用项目当前的 `revision`，新建项目用 `revision=0`。`mova_cloud_project_run` 提交任务，`mova_cloud_task_get` 查看状态或结果。若另一端先修改了项目，重新读取后再提交。

可以在 `~/.config/mova/cloud.env` 配置多个 API 档案。例如命名为 `work` 的档案使用 `MOVA_API_PROFILE_WORK_BASE_URL`、`MOVA_API_PROFILE_WORK_KEY`、`MOVA_API_PROFILE_WORK_MODEL`，Anthropic Messages 接口另填 `MOVA_API_PROFILE_WORK_PROTOCOL=anthropic`。重启云服务后，桌面模型可以选用 `provider=api` 和 `apiProfile=work`。项目的 `model` 留空时使用档案默认模型。桌面只读到档案 ID、模型名和协议，密钥存放在 Linux。

导入公开 GitHub 文件时提供 `repository`（`owner/repo`）、完整 40 位 `commit`、`filePath` 和 `toolName`。仓库也可以自带 `mova-tool.json`，此时省略 `filePath` 与 `toolName`，如使用其他清单则传 `manifestPath`。

```json
{
  "schemaVersion": 1,
  "kind": "github_file",
  "name": "release-notes",
  "description": "读取固定提交的发布说明",
  "file": "docs/release-notes.md"
}
```

云端按提交 SHA 保存 UTF-8 文件和内容摘要，文件上限 32 KiB。使用 API 模型的云任务可以按需调用这些只读工具。导入机制只读取文件，仓库中的代码和安装脚本需要由管理员另行部署。任务提交时记录所用的项目版本和工具内容，后续项目修改适用于新任务。

```bash
mova project list
mova project profiles
mova project show work
mova project save work ./project-settings.json
mova project import-tool work ./tool-source.json
mova chat "读取导入的发布说明并总结" --project work
```

### 备份、恢复和回滚

```bash
mova backup "$HOME/mova-$(date +%F).sqlite"
systemctl --user stop mova-cloud.service
mova restore "$HOME/mova-$(date +%F).sqlite"
systemctl --user start mova-cloud.service
bash scripts/install-mova.sh --rollback --service
```

恢复会保留一份恢复前的工作区备份，并要求桌面和手机重新配对。工作区备份覆盖 Bot、对话、任务和事件。将 VPN、API 密钥和订阅授权作为独立的主机配置管理。升级和回滚使用同一个工作区目录，操作前保留 SQLite 备份。

