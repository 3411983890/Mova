/**
 * 负责：把「技能包数组 + 宿主注入依赖」编成一张可查询的注册表——manifest 准入、
 *   依赖裁剪、会话策略裁剪、缺 handler 的工具不暴露、同名/别名冲突检测、弃用过滤。
 * 不负责：执行 handler、发事件、审批（那些在 index.mjs / approval-bridge.mjs）、
 *   manifest 字段级校验（在 manifest-schema.mjs）。
 * 被谁调用：electron/skills/index.mjs（buildSkillRuntime）、tests/skills-registry.test.mjs。
 *
 * 纯函数、零 IO：`deps` 只是宿主对象包，本模块不调用其中任何能力（除了 createHandlers(deps)）。
 */

import { assertValidManifest, normalizeManifest } from './manifest-schema.mjs';

/**
 * 「没注入」只认 undefined / null / 空串 / NaN。
 * `false` 与 `0` 是**已注入的值**（例如 `temporary:false`、`port:0`）：把它们当缺失会把整包裁掉。
 */
function hasDep(deps, key) {
  const value = deps?.[key];
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return true;
}

/**
 * @param {Array<{ manifest: object, createHandlers: (deps: object) => Record<string, Function> }>} packs
 * @param {object} [deps] 宿主注入包（projectRoots / permissions / approvals / sender / emit …）
 * @returns {{
 *   entries: Map<string, { pack: object, def: object, handler: Function }>,
 *   aliases: Map<string, string>,
 *   packs: Array<{ id: string, title: string, version: string, manifest: object, tools: string[] }>,
 *   warnings: string[],
 *   skipped: Array<{ pack: string, reason: string, missing?: string[], message: string }>,
 * }}
 */
export function buildRegistry(packs = [], deps = {}) {
  const entries = new Map();
  const aliases = new Map();
  const accepted = [];
  const warnings = [];
  const skipped = [];
  const context = { entries, aliases, warnings, skipped };

  const list = Array.isArray(packs) ? packs : [];
  list.forEach((pack, index) => admitPack(pack, index, deps, context, accepted));
  checkReplacedBy(accepted, entries, aliases, warnings);

  return { entries, aliases, packs: accepted, warnings, skipped };
}

/**
 * 弃用的 replacedBy 指向的工具必须真的存在——这一步只有注册表能做（单个 manifest 里看不到别的包）。
 * 找不到只告警不拒绝：弃用是迁移提示，不该让可用技能包跟着消失。
 */
function checkReplacedBy(accepted, entries, aliases, warnings) {
  for (const pack of accepted) {
    const replacedBy = pack.manifest?.deprecation?.replacedBy;
    if (typeof replacedBy !== 'string' || !replacedBy) continue;
    const canonical = aliases.get(replacedBy) ?? replacedBy;
    if (!entries.has(canonical)) {
      warnings.push(`[${pack.id}] deprecation.replacedBy 指向不存在的工具：${replacedBy}`);
    }
  }
}

function packLabel(pack, index) {
  const id = pack?.manifest?.id;
  return typeof id === 'string' && id ? id : `#${index}`;
}

function skip(context, label, reason, message, extra = {}) {
  context.skipped.push({ pack: label, reason, message, ...extra });
  context.warnings.push(`[${label}] ${message}`);
}

function admitPack(pack, index, deps, context, accepted) {
  const label = packLabel(pack, index);
  if (!pack || typeof pack !== 'object' || typeof pack.createHandlers !== 'function') {
    skip(context, label, 'pack_shape', 'pack 必须导出 { manifest, createHandlers(deps) }：缺少 createHandlers');
    return;
  }

  let manifest;
  try {
    // pack 的 manifest 是程序错误，但一个坏 pack 不该拖垮整张表：记 warning 后跳过。
    manifest = normalizeManifest(assertValidManifest(pack.manifest));
  } catch (error) {
    skip(context, label, 'invalid_manifest', `manifest 校验失败：${error?.message ?? error}`);
    return;
  }

  // 同一个 id 出现两次说明 DEFAULT_PACKS 挂重了：后到者整包跳过，否则同 id 的两个包会互相抢别名。
  const duplicate = accepted.find(item => item.id === manifest.id);
  if (duplicate) {
    skip(context, label, 'duplicate_pack', `技能包 id 重复（已由前一个同 id 包注册）：${manifest.id}`);
    return;
  }

  const missing = manifest.dependencies.filter(key => !hasDep(deps, key));
  if (missing.length) {
    skip(context, label, 'missing_dependencies', `缺少宿主依赖：${missing.join(', ')}`, { missing });
    return;
  }

  const policy = manifest.sessionPolicy ?? {};
  if (policy.allowTemporary === false && deps.temporary === true) {
    skip(context, label, 'session_temporary', 'sessionPolicy.allowTemporary:false，临时会话不加载此技能包');
    return;
  }
  if (policy.allowBrowserOnly === false && deps.browserOnly === true) {
    skip(context, label, 'session_browser_only', 'sessionPolicy.allowBrowserOnly:false，浏览器专属会话不加载此技能包');
    return;
  }

  let handlers;
  try {
    handlers = pack.createHandlers(deps) ?? {};
  } catch (error) {
    skip(context, label, 'create_handlers_failed', `createHandlers(deps) 抛错：${error?.message ?? error}`);
    return;
  }
  if (typeof handlers !== 'object') {
    skip(context, label, 'create_handlers_failed', 'createHandlers(deps) 必须返回 { [toolName]: Function }');
    return;
  }

  const registered = registerTools(manifest, handlers, context);
  if (!registered.length) {
    context.warnings.push(`[${manifest.id}] 没有任何工具同时具备定义与实现，此包本轮不生效`);
    return;
  }
  accepted.push({
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    manifest,
    tools: registered,
  });
}

/** 工具级准入：缺实现不暴露（延续 mcp/tools.mjs 的原则）、跨 pack 同名冲突后到者让位。 */
function registerTools(manifest, handlers, context) {
  const registered = [];
  for (const def of manifest.tools) {
    const handler = handlers[def.name];
    if (typeof handler !== 'function') {
      context.warnings.push(`[${manifest.id}] 工具 ${def.name} 没有 handler，本轮不暴露`);
      continue;
    }
    const existing = context.entries.get(def.name);
    if (existing) {
      context.warnings.push(
        `[${manifest.id}] 工具名 ${def.name} 已被技能包 ${existing.pack.id} 占用，后到者跳过（conflict）`,
      );
      continue;
    }
    // canonical 名和别名共用一个命名空间：若这个名字已被**别的工具**的别名占用，
    // 后到者必须让位——否则 resolve 会把 A 的别名解析成 B 的 canonical（调用 B 执行 A）。
    const claim = context.aliases.get(def.name);
    if (claim && claim !== def.name) {
      context.warnings.push(
        `[${manifest.id}] 工具名 ${def.name} 已被别名占用（该别名当前指向 ${claim}），后到者跳过（conflict）`,
      );
      continue;
    }
    context.entries.set(def.name, { pack: manifest, def, handler });
    registerAliases(def, context);
    registered.push(def.name);
  }
  return registered;
}

/** name / mcpName / 自定义别名共用一个命名空间；指向两个 canonical 名时保留第一个。 */
function registerAliases(def, context) {
  const names = [def.name, def.mcpName, ...(def.aliases ?? [])];
  for (const raw of names) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const name = raw.trim();
    const owner = context.aliases.get(name);
    if (owner && owner !== def.name) {
      context.warnings.push(`别名 ${name} 同时指向 ${owner} 与 ${def.name}，保留 ${owner}（conflict）`);
      continue;
    }
    context.aliases.set(name, def.name);
  }
}

/**
 * 弃用过滤。entries 接受 Map（registry.entries）或 entry 数组，一律返回数组。
 * `deprecation.deprecated === true` 的判定同时看 tool 级与 pack 级。
 * @param {Map<string, object>|object[]} entries
 * @param {{ includeDeprecated?: boolean }} [options]
 * @returns {object[]}
 */
export function filterDeprecated(entries, { includeDeprecated = false } = {}) {
  const rows = entries instanceof Map ? [...entries.values()] : Array.isArray(entries) ? entries : [];
  if (includeDeprecated) return rows;
  return rows.filter(entry => !isDeprecated(entry));
}

/** @returns {boolean} 该 entry（或它所属 pack）是否已被标记弃用 */
export function isDeprecated(entry) {
  return entry?.def?.deprecation?.deprecated === true || entry?.pack?.deprecation?.deprecated === true;
}
