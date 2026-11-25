# Mova 浏览器 Agent v1 验收对照（2026-11-11）

> 对照文档：`Mova浏览器MCP开发方案.md`  
> 证据：`design/browser-benchmark.md`、`design/real-sites.md`、`design/real-interactions.md`、`design/browser-spike.md`  
> 结论：**功能面基本闭合；§19 的“真实业务任务成功率”和三项指标仍是部分满足。**

## 1. 九项用户目标

| 目标 | 状态 | 证据 |
| --- | --- | --- |
| Accessibility Snapshot | ✅ | `ax-compact.cjs` + 真实 AXTree；快照 1k–13.6k 字符 |
| Snapshot Diff | ✅ | `diff.cjs`；`snapshot-diff` 任务 4 次调用、732 字符 |
| JavaScript Batch Runner | ✅ | 声明式 `browser_batch` + `browser_run_js`（vm，逐次审批） |
| Smart Wait | ✅ | `wait.cjs`；selector/text/url/load，导航上下文重建重试 |
| Task Spaces | ✅ 基本 | Space 切换、隔离 partition、后台 Space 读写、同 Space 串行 |
| Session Persistence | ✅ | `persist:` 分区跨重启；Space 名称持久化；加密 storageState 的导出/导入工具；登录成功静默保存 cookie/localStorage，下次进入同站点可选用 Cookie 登录 |
| Site Skills | ✅ | 自动沉淀、recipe 重放、技能 UI、站点卡片、L2 记忆镜像 |
| Human Takeover | ✅ | 主动 handoff + 横幅 + 恢复；被动输入抢占（`before-input-event`）已验证 |
| 网页读取/点击/批量/截图/标签页 | ✅ | 25 项夹具 + 3 项真实只读 + 3 项真实交互 |

## 2. §19 指标

| 指标 | 目标 | 当前 | 判定 |
| --- | --- | --- | --- |
| 任务成功率 | ≥ 80% | 夹具 25/25；真实只读 3/3；真实交互 3/3 | ⚠️ 真实业务任务未测 |
| 平均工具调用 | 探索 ≤8；重放 ≤2 | 夹具平均 3.2；技能重放 3 次调用 | ✅/⚠️ 重放略高于 2 |
| 单任务 tokens | ≤25k；重放 ≤4k | 夹具总 15,761 字符 ≈ 3,940 tokens | ✅ |
| 动作 P50 | <300 ms | 11 次 `browser_act`，P50 286 ms | ✅ |
| 误点/误填率 | <3% | 未标注统计 | ❌ 未测 |
| 策略绕过 | 0 | 审批单测 + policy 单测 | ⚠️ 无红队测试 |
| 凭据明文进模型 | 0 | 单测断言表达式不含密码；登录卡 E2E 通过 | ✅ |
| 技能召回准确率 | ≥80% | 未做多技能标注 | ❌ 未测 |
| 接管率 | 敏感 100%，普通 <10% | 未统计 | ❌ 未测 |

## 3. §19 的 12 个任务

| 计划任务 | 状态 | 对应实现/证据 |
| --- | --- | --- |
| 长文阅读 | ✅ | `read-article` |
| 站内搜索 | ✅ | `site-search` |
| 分页表格抽取 | ⚠️ | `table-pagination` 只验证翻页后 read 到新行，未做结构化字段抽取 |
| 多步表单 | ✅ | `batch-form` |
| 弹窗确认 | ✅ | alert 自动接受；confirm dismiss / arm-accept 各有基准 |
| 文件下载 | ✅ | `download` |
| 新标签页 | ✅ | `tabs` |
| 首次登录 + 保存保险柜 | ✅ | `MOVA_TEST_VAULT=1` 内存保险柜下，登录卡保存分支通过：卡片关闭、页面 `Welcome ada`、保险柜出现该 origin 条目 |
| 二次登录自动填充 | ✅ | `login-fill`（fake vault） |
| 双账号隔离 | ✅ | `dual-account` |
| 技能重放 | ✅ | `skill-replay` |
| 懒加载等待 | ✅ | `smart-wait` |
| 跨域 iframe | ✅ | `iframe-cross-origin`（DOM 点击兜底） |

额外完成：后台 Space 操作、并发串行队列、按钮弹文件选择器、对话框结果修复、Space 重命名/持久化。

## 4. 仍未闭合

1. **真实业务任务**：已完成一次 DeepSeek 开放平台“登录 → API keys → 新建 key”闭环，见 [deepseek-acceptance.md](deepseek-acceptance.md)；仍缺可重复的 12 个真实业务任务统计。
2. **真实保险柜的保存 UI 分支**：已用 `MOVA_TEST_VAULT=1` 内存保险柜验证；PostgreSQL vault 的真实写入仍由后端单测覆盖，未在 UI E2E 中写真实 vault。
3. **误差类指标**：误点率、接管率、技能召回准确率没有标注数据。
4. **真实触控/输入法**：被动接管只用 `sendInputEvent` 模拟过键盘。
5. **storageState 设置页**：已有加密导出/导入工具，但没有设置页按钮。

## 5. 建议的收尾顺序

1. 用 1 个真实后台站点跑“登录 → 搜索 → 表单”闭环，记录成功率/接管次数；
2. 补 confirm 对话框的 accept/dismiss 基准；
3. 给 10–20 个动作打标注，统计误点率与动作 P50；
4. 补真实保险柜保存 UI 分支（可用独立测试 vault 或临时用户数据目录）；
5. 视需要做被动接管与 storageState 导入导出。

完成 1–3 后，§19 的核心指标才有真实数据，才能把目标标记为完成。
