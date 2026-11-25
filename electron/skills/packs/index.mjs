/**
 * 负责：把核心能力技能包登记成一张清单（`DEFAULT_PACKS`），供 buildSkillRuntime 直接消费——
 *   每一项都是 `{ manifest, createHandlers(deps) }`，顺序即 `mova_skill_search` 的展示顺序。
 * 不负责：manifest 校验（manifest-schema.mjs）、依赖裁剪（registry.mjs）、执行与事件（index.mjs），
 *   也不负责往 chat-agent.mjs / mcp 侧接线（那是接线层的事）。
 * 被谁调用：electron/skills/index.mjs 的调用方（`buildSkillRuntime({ packs: DEFAULT_PACKS, deps })`）、
 *   tests/skills-packs.test.mjs、tests/skills-pack-handlers.test.mjs。
 *
 * 只在这里做聚合：任何 pack 的 manifest 都必须零 IO、零宿主 import，才能被本文件直接静态 import。
 */

import { createHandlers as createBrowserAutomationHandlers } from './browser-automation/handlers.mjs';
import { manifest as browserAutomationManifest } from './browser-automation/manifest.mjs';
import { createHandlers as createContextLedgerHandlers } from './context-ledger/handlers.mjs';
import { manifest as contextLedgerManifest } from './context-ledger/manifest.mjs';
import { createHandlers as createDesktopControlHandlers } from './desktop-control/handlers.mjs';
import { manifest as desktopControlManifest } from './desktop-control/manifest.mjs';
import { createHandlers as createDesignCanvasHandlers } from './design-canvas/handlers.mjs';
import { manifest as designCanvasManifest } from './design-canvas/manifest.mjs';
import { createHandlers as createGoalPlanHandlers } from './goal-plan/handlers.mjs';
import { manifest as goalPlanManifest } from './goal-plan/manifest.mjs';
import { createHandlers as createMemoryHandlers } from './memory/handlers.mjs';
import { manifest as memoryManifest } from './memory/manifest.mjs';
import { createHandlers as createProjectFsHandlers } from './project-fs/handlers.mjs';
import { manifest as projectFsManifest } from './project-fs/manifest.mjs';
import { createHandlers as createWebResearchHandlers } from './web-research/handlers.mjs';
import { manifest as webResearchManifest } from './web-research/manifest.mjs';

/** `project-fs`：文件读写、检索、Git 与命令（包装 electron/agent-tools.cjs）。 */
export const projectFsPack = Object.freeze({ manifest: projectFsManifest, createHandlers: createProjectFsHandlers });
/** `goal-plan`：目标卡、计划卡、向用户提问与人工审批请求。 */
export const goalPlanPack = Object.freeze({ manifest: goalPlanManifest, createHandlers: createGoalPlanHandlers });
/** `web-research`：联网搜索、读正文、一次性检索与引用校验。 */
export const webResearchPack = Object.freeze({ manifest: webResearchManifest, createHandlers: createWebResearchHandlers });
/** `memory`：长期记忆的检索、原文回查与写入。 */
export const memoryPack = Object.freeze({ manifest: memoryManifest, createHandlers: createMemoryHandlers });
/** `context-ledger`：上下文用量、压缩与原文回查。 */
export const contextLedgerPack = Object.freeze({ manifest: contextLedgerManifest, createHandlers: createContextLedgerHandlers });
/** `browser-automation`：内置浏览器的导航/读取/交互/批量/站点技能/人工接管（包装 electron/browser/tools.cjs）。 */
export const browserAutomationPack = Object.freeze({ manifest: browserAutomationManifest, createHandlers: createBrowserAutomationHandlers });
/** `design-canvas`：共享设计画板的打开/读取/编辑/撤销/截图/字体（包装 electron/design-runtime.cjs）。 */
export const designCanvasPack = Object.freeze({ manifest: designCanvasManifest, createHandlers: createDesignCanvasHandlers });
/** `desktop-control`：桌面窗口的读结构、点按输入、截图、应用启动与人工接管（包装 electron/desktop/tools.cjs）。 */
export const desktopControlPack = Object.freeze({ manifest: desktopControlManifest, createHandlers: createDesktopControlHandlers });

/**
 * 核心能力技能包清单。顺序固定（提示缓存与 mova_skill_search 的稳定前缀都依赖它）：
 * 先「看得见的东西」（文件、目标、检索、记忆、上下文），再接「会动界面的能力」
 * （浏览器、画板、桌面）。后续 pack 一律追加到末尾。
 */
export const DEFAULT_PACKS = Object.freeze([
  projectFsPack,
  goalPlanPack,
  webResearchPack,
  memoryPack,
  contextLedgerPack,
  browserAutomationPack,
  designCanvasPack,
  desktopControlPack,
]);
