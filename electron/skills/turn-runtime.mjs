/**
 * 负责：把一个聊天回合的宿主依赖装配成 `{ runtime, toolTable }`——三件套审批/权限/路径
 *   适配器、对象数组形态的 projectRoots、按场景置顶工具（`pinnedSkills` → `pickPinnedTools`），
 *   装配后核对核心工具是否齐全，缺了就 warn（并可选地发一条 notice）：「静默少工具」是这次改造
 *   最容易复发的故障。
 * 不负责：工具实现（packs/**）、审批判定（approval-bridge.mjs）、宿主签名差异（host-adapters.mjs）、
 *   MCP 传输与鉴权（mcp/server.mjs）、pi-ai 的 tools[] 投影（adapters/pi-ai.mjs）、
 *   「用户正在用浏览器吗」的判定（调用方给，本文件只提供 `pinnedSkillsFor` 这份依赖→工具的映射）。
 * 被谁调用：electron/chat-agent.mjs 的两条链路——ACP 支路（runAcpSubscriptionTurn 的 mcpServers 钩子，
 *   用 `toolTable`）与 pi-ai 主循环（runChatAgent，用 `runtime` + toPiAiTools），
 *   tests/skills-wiring.test.mjs。
 *
 * 两条链路**同一个装配函数、同一份 packs**：工具定义、schema、截断预算与审批口径只有一处来源。
 * 差别只在「谁消费结果」：MCP 要 `{list, call}` 形状的工具表，pi-ai 要 `{name, execute}` 的数组。
 *
 * 三条接线事实（改之前先读，都是踩过的坑）：
 * 1) `projectRoots` 必须是**对象数组** `{ id, name, path, capabilities }`：`createProjectTools` 只认
 *    这种形态，传字符串会让 16 个项目工具静默消失；`roots`（字符串）只给权限适配器做诊断提示。
 * 2) `projectTools` 必须是**每次调用新建**的工厂：`write_file` 的 diff 只存在于 agent-tools 的 emit
 *    事件里，复用同一份实例就拿不到本次调用的 diff，前端变更卡会空。
 * 3) `approvals` 用适配器（`(request, signal)`）；packs 里 goal-plan 的 `request_approval` 仍按宿主
 *    签名 `(sender, request, signal)` 调，所以这里包一层双签名壳，两条都不会拿错参数。
 */

import { CORE_TOOL_NAMES } from '../mcp/tools.mjs';
import { pickPinnedTools, toMcpToolTable } from './adapters/mcp.mjs';
import {
  createApprovalsAdapter, createGateAdapter, createPermissionsAdapter, resolveSkillLogger,
} from './host-adapters.mjs';
import { buildSkillRuntime } from './index.mjs';
import { DEFAULT_PACKS } from './packs/index.mjs';
import { manifest as cloudProjectsManifest } from './packs/cloud-projects/manifest.mjs';
import { createHandlers as createCloudProjectsHandlers } from './packs/cloud-projects/handlers.mjs';

const cloudProjectsPack = { manifest: cloudProjectsManifest, createHandlers: createCloudProjectsHandlers };

/** 与 mcp/normalize.mjs 的 MAX_TEXT_CHARS 一致：两条链路同一个截断预算。 */
const MAX_TEXT_CHARS = 8_192;

/**
 * 场景 → 置顶工具的唯一映射（方案 §3.1 的「按场景动态置顶」）。
 *
 * 判据只有一条：**宿主依赖在不在**。注入了浏览器控制器就置顶浏览器三件套，没有就一个都不置顶
 * （`tools/list` 与改造前逐字一致）。不根据用户这句话的措辞去猜「他现在是不是在设计画板」——
 * 猜错会让工具表每轮抖动，反而伤提示缓存与模型判断。
 *
 * 每组的顺序就是优先级：几组同时命中、总数超过 MAX_PINNED_TOOLS 时从尾部截断
 * （顺序见 adapters/mcp.mjs 的 pickPinnedTools / MAX_PINNED_TOOLS）。
 */
const PINNED_BY_DEPENDENCY = Object.freeze([
  { dependency: 'browser', tools: Object.freeze(['browser_navigate', 'browser_snapshot', 'browser_read']) },
  { dependency: 'designRuntime', tools: Object.freeze(['design_open', 'design_read', 'design_apply']) },
  { dependency: 'desktop', tools: Object.freeze(['desktop_snapshot', 'desktop_act', 'desktop_screenshot']) },
]);

/**
 * 按本轮真实存在的宿主依赖算出 `pinnedSkills`（每项是一个工具名，顺序即优先级）。
 * 纯函数：只在依赖**存在**（非 undefined / null）时置顶，不调用任何宿主能力。
 * @param {{ browser?: object|null, designRuntime?: object|null, desktop?: object|null }} [deps]
 * @returns {string[]} 置顶工具名（可能为空数组）
 */
export function pinnedSkillsFor(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  return PINNED_BY_DEPENDENCY
    .filter(item => d[item.dependency] !== null && d[item.dependency] !== undefined)
    .flatMap(item => [...item.tools]);
}

/**
 * `request_approval` 与授权协调器共用同一个 approvals 对象，但签名不同：
 * 协调器调 `ask(request, signal)`，goal-plan 调 `ask(sender, request, signal)`。
 * 用第一参是否「像 webContents」（有 send 方法）分流——两个真实形状不会混淆。
 * @param {{ ask: (request: object, signal?: AbortSignal) => Promise<string> }} adapter
 */
function dualSignatureApprovals(adapter) {
  return {
    ask(first, second, third) {
      const looksLikeSender = first && typeof first === 'object' && typeof first.send === 'function';
      return looksLikeSender ? adapter.ask(second, third) : adapter.ask(first, second);
    },
  };
}

/** `mcpName` / `name` / 别名 → 所属 pack id（只用于把「缺哪个包」说准，不做鉴权）。 */
const TOOL_PACK = (() => {
  const map = new Map();
  for (const pack of DEFAULT_PACKS) {
    const id = pack?.manifest?.id;
    if (!id) continue;
    for (const def of pack.manifest.tools ?? []) {
      for (const name of [def.name, def.mcpName, ...(def.aliases ?? [])]) {
        if (typeof name === 'string' && name) map.set(name, id);
      }
    }
  }
  return map;
})();

/** 缺少的核心工具：一律按 MCP 名比对（别名、mova_ 前缀由工具表自己解析）。 */
function missingCoreTools(toolTable) {
  const has = typeof toolTable?.has === 'function' ? name => toolTable.has(name) : () => false;
  return CORE_TOOL_NAMES.filter(name => !has(name));
}

/**
 * 缺工具的「原因」：**只报与缺失工具有关的包**。
 *
 * 为什么必须过滤：早先把所有被跳过的包都列出来，于是用户看到
 * 「（project-fs 缺少宿主依赖：projectTools；context-ledger 缺少宿主依赖：contextTools）」——
 * 而 context-ledger 的工具本来就不是核心工具、在 ACP 支路也没有台账实例（设计如此），
 * 把它写进「为什么少了 4 个核心工具」里纯属误导。
 */
function reasonText(runtime, missing = []) {
  const wanted = new Set((Array.isArray(missing) ? missing : []).map(name => TOOL_PACK.get(name)).filter(Boolean));
  const skipped = Array.isArray(runtime?.registry?.skipped) ? runtime.registry.skipped : [];
  const relevant = wanted.size ? skipped.filter(item => wanted.has(item.pack)) : skipped;
  if (relevant.length) {
    return relevant.slice(0, 4).map(item => `${item.pack} ${item.message ?? item.reason}`).join('；');
  }
  const warnings = Array.isArray(runtime?.warnings) ? runtime.warnings : [];
  const related = wanted.size ? warnings.filter(text => [...wanted].some(id => text.includes(`[${id}]`))) : warnings;
  if (related.length) return related.slice(0, 4).join('；');
  return '相关依赖未注入（详见日志 skills-runtime built 的 skipped）';
}

/**
 * 缺核心工具 → **只写日志**。返回缺失名单（供测试与诊断用）。
 *
 * 为什么不再上屏：这一层列出来的「缺」绝大多数是**正常状态**——没有项目文件夹、临时会话不加载
 * 记忆、没配提问通道、Edge 会话不开文件工具。早期它会发一条「本轮缺少 N 个核心工具：…」的旁白，
 * 在 ACP 支路每轮都出现，读起来像软件坏了，用户的实际反馈就是「把那条提醒删掉」。
 * 真正接线断了会由下面 `skills-runtime built` 的 `skipped`（含每个包的 reason）暴露，排查够用。
 * @returns {string[]}
 */
function reportMissingCore({ runtime, toolTable, logger }) {
  const missing = missingCoreTools(toolTable);
  if (!missing.length) return [];
  logger.warn(`本轮缺少 ${missing.length} 个核心工具：${missing.join('、')}（${reasonText(runtime, missing)}）`);
  return missing;
}

/**
 * @param {{
 *   approvals?: { ask: Function }|null,
 *   permissions?: { list?: Function, check?: Function, authorize?: Function }|null,
 *   gate?: object|null,
 *   sender?: object|null,
 *   emit?: Function|null,
 *   audit?: { record?: Function }|Function|null,
 *   projectRoots?: Array<object>,
 *   roots?: string[],
 *   approvalPreset?: 'default'|'auto'|'full',
 *   aim?: object|null,
 *   conversationId?: string,
 *   sessionKey?: string,
 *   historyDir?: string|null,
 *   temporary?: boolean,
 *   browserOnly?: boolean,
 *   search?: Function|null,
 *   searchService?: object|null,
 *   searchOptions?: object|null,
 *   searchKey?: string|null,
 *   memorySearch?: Function|null,
 *   memoryRuntime?: object|null,
 *   contextTools?: object|null,
 *   projectTools?: Function|object[]|null,
 *   asks?: object|null,
 *   chatImages?: object|null,
 *   supportsImages?: boolean,
 *   designRuntime?: object|null,
 *   browser?: object|null,
 *   browserSettings?: object|null,
 *   desktop?: object|null,
 *   pinnedSkills?: string[],
 *   mcpManager?: object|null,
 *   logger?: object,
 *   reportMissingCore?: boolean,
 * }} [deps] 键与"缺了少哪个工具"的对应关系见 tests/skills-wiring.test.mjs
 *   `pinnedSkills` 是本轮要直出到 `tools/list` 的置顶项（包 id 或工具名）；
 *   生产接线用 `pinnedSkillsFor({ browser, designRuntime, desktop })` 生成，见 tests/skills-pinning.test.mjs。
 * @returns {{ runtime: object, toolTable: object }} 两条链路拿到的是同一个装配结果
 */
export function createSkillRuntimeForTurn(deps = {}) {
  const d = deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {};
  const logger = resolveSkillLogger(d.logger);
  const emit = typeof d.emit === 'function' ? d.emit : null;

  const approvals = createApprovalsAdapter({ broker: d.approvals, sender: d.sender, logger });
  const runtimeDeps = {
    // 三件套全是适配器，不是原始宿主对象（approval-bridge.mjs 的契约）。
    approvals: dualSignatureApprovals(approvals),
    // 权限适配器同时提供 check（按 rootId 查文件能力位）与 checkRootless（桌面/浏览器/画板/记忆
    // 这类非文件能力位，见 host-adapters.mjs 的 checkRootless 函数头）。`projectRoots: []` 时
    // 文件类工具会被拒，但 rootless 工具照常可用——这就是「用户没打开项目文件夹也能桌面操控」。
    permissions: createPermissionsAdapter({ store: d.permissions, roots: d.roots, logger }),
    gate: createGateAdapter({ gate: d.gate, logger }),
    sender: d.sender ?? null,
    emit: emit ?? undefined,
    approvalPreset: d.approvalPreset,
    // 授权审计（approval-bridge 的 `audit.record`）：接线层注入了才落盘，缺了不阻断。
    // 这一行以前漏了，导致桥里的审计路径在生产装配下永远是 undefined。
    audit: d.audit ?? null,
    // 对象数组：packs 按 `.path` 用；字符串 hint 单独走 roots。
    projectRoots: Array.isArray(d.projectRoots) ? d.projectRoots : [],
    aim: d.aim ?? null,
    conversationId: d.conversationId,
    sessionKey: d.sessionKey,
    historyDir: d.historyDir,
    temporary: d.temporary === true,
    browserOnly: d.browserOnly === true,
    search: d.search,
    searchService: d.searchService,
    searchOptions: d.searchOptions,
    searchKey: d.searchKey,
    memorySearch: d.memorySearch,
    memoryRuntime: d.memoryRuntime,
    contextTools: d.contextTools,
    projectTools: typeof d.projectTools === 'function' || Array.isArray(d.projectTools) ? d.projectTools : null,
    asks: d.asks,
    chatImages: d.chatImages,
    supportsImages: d.supportsImages === true,
    designRuntime: d.designRuntime,
    browser: d.browser,
    browserSettings: d.browserSettings,
    desktop: d.desktop,
    mcpManager: d.mcpManager,
    cloudProjects: d.cloudProjects,
    logger,
  };

  const runtime = buildSkillRuntime({ packs: typeof d.cloudProjects === 'function' ? [...DEFAULT_PACKS, cloudProjectsPack] : DEFAULT_PACKS, deps: runtimeDeps });
  // 场景置顶：调用方给「现在在用什么」（pinnedSkills），这里只做「取哪几个工具」的裁剪。
  // 没给 / 给了也解析不到（比如该技能包本轮因缺依赖被跳过）→ pinned 为空，tools/list 与今天一致。
  const pinned = pickPinnedTools(runtime, { pinnedPacks: Array.isArray(d.pinnedSkills) ? d.pinnedSkills : [] });
  const toolTable = toMcpToolTable(runtime, { maxTextChars: MAX_TEXT_CHARS, pinned });
  // 只记日志，不上屏（原因见 reportMissingCore 的头注释）。`reportMissingCore:false` 仍然可以
  // 连日志一起关掉：pi-ai 主循环里缺依赖是常态，免得每轮都写一条同义记录。
  const missingCore = d.reportMissingCore === false
    ? []
    : reportMissingCore({ runtime, toolTable, logger });

  // 只记数量与被跳过包的 id+reason：值里可能带路径与凭据，不进日志。
  logger.info('skills-runtime built', {
    packs: runtime.packs.length,
    tools: runtime.listEntries().length,
    core: toolTable.list().length,
    pinned: pinned.map(row => row.name),
    skipped: (runtime.registry?.skipped ?? []).map(item => ({ id: item.pack, reason: item.reason })),
  });
  return { runtime, toolTable, missingCore };
}
