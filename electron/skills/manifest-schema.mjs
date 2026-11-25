/**
 * 负责：技能包 manifest 的唯一校验与归一实现——字段类型、semver、kebab 命名、
 *   ≤2 行且每行 ≤160 字符的 mcpSummary、JSON Schema 形状（含 required ⊆ properties）、examples、
 *   别名冲突、MCP 元工具保留名、permissions 未知键、弃用字段语义、工具结果预算（`maxResultChars`），
 *   并提供默认值填充与 `resultBudgetOf()`（结果预算的唯一读者）。
 * 不负责：读写任何文件、读取 deps、加载 pack、跨 pack 的名字冲突（那些在 registry.mjs）；
 *   `deprecation.replacedBy` 指向的是不是真工具也只有 registry 能判；
 *   真正执行截断（electron/mcp/normalize.mjs 的 truncateText）。
 * 被谁调用：electron/skills/registry.mjs（buildRegistry 的准入门槛）、
 *   electron/skills/index.mjs 与 adapters/{mcp,pi-ai}.mjs（resultBudgetOf）、
 *   tests/skills-manifest.test.mjs、以及后续 pack 作者的自检脚本。
 *
 * 纯函数、零 IO、零 electron import：manifest 校验必须能在 `node --test` 里裸跑。
 * 错误 vs 告警的分界：**会改变运行时行为或安全边界**的写错是 error（拒绝加载），
 *   只是「作者多写了一个不会生效的字段」是 warning（照常加载但必须看得见）。
 */

import { MAX_TEXT_CHARS } from '../mcp/normalize.mjs';

/** Manifest 规范主版本。不兼容变更时 +1，旧 manifest 会在启动时被明确拒绝而不是静默失效。 */
export const SKILL_API_VERSION = 1;
/** 单次调用超时预算默认值（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 工具结果的文本预算默认值：直接沿用 MCP 层的 `MAX_TEXT_CHARS`。
 * **同一个数字只允许来自一处**（electron/mcp/normalize.mjs 的 MAX_TEXT_CHARS）——
 * 结果是「工具自己的预算」和「MCP 边界」共用同一个上限，两处各写一份必然漂移。
 */
export const DEFAULT_MAX_RESULT_CHARS = MAX_TEXT_CHARS;
/** `maxResultChars` 的下限：比这更小的预算连一条结构化结果都装不下，属于写错而不是省 token。 */
export const MIN_RESULT_CHARS = 1_024;
/** `maxResultChars` 的上限：一次工具结果再大也不该超过 6 万字符（约 1.5 万 token）。 */
export const MAX_RESULT_CHARS = 60_000;
/** 技能包 id 的长度上限：id 会进日志与错误文案，太长没有意义。 */
export const MAX_ID_CHARS = 40;
/** mcpSummary 允许的最大行数（MCP tools/list 的 token 预算，兼容 mcp-tools 的既有断言）。 */
export const MAX_MCP_SUMMARY_LINES = 2;
/** mcpSummary 单行长度上限：tools/list 里每条描述都进模型输入，一行超过 160 字符就是浪费。 */
export const MAX_MCP_SUMMARY_CHARS = 160;
/** examples 的条数上限。 */
export const MAX_EXAMPLES = 2;

export const RISK_LEVELS = Object.freeze(['none', 'read', 'write', 'exec']);
export const APPROVAL_MODES = Object.freeze(['none', 'policy', 'always']);
export const APPROVAL_CAPABILITIES = Object.freeze(['write', 'exec']);
export const MCP_EXPOSURES = Object.freeze(['core', 'on_demand', 'off']);
export const FS_LEVELS = Object.freeze(['none', 'read', 'write']);
export const MEMORY_LEVELS = Object.freeze(['none', 'read', 'write']);
/** permissions 的七个键必须齐全：漏一个就等于「这一项没声明」，运行时只能猜。 */
export const PERMISSION_KEYS = Object.freeze(['fs', 'exec', 'net', 'desktop', 'browser', 'canvas', 'memory']);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 工具名沿用既有下划线风格（`design_apply` / `browser_batch`），pi-ai 链路原样使用。 */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const MAX_TOOL_NAME_CHARS = 60;

const MANIFEST_KEYS = new Set([
  'apiVersion', 'id', 'version', 'title', 'summary', 'capabilities', 'dependencies',
  'permissions', 'sessionPolicy', 'deprecation', 'tools',
]);

/** tool 级白名单：与顶层 MANIFEST_KEYS 同样的做法——拼错字段名要能被发现，但不阻断加载。 */
const TOOL_KEYS = new Set([
  'name', 'mcpName', 'aliases', 'label', 'description', 'mcpSummary', 'risk', 'approval',
  'exposure', 'timeoutMs', 'maxResultChars', 'supportsProgress', 'imageOutput', 'inputSchema', 'examples', 'deprecation',
]);

/**
 * MCP 边界上的三个元工具名。任何技能工具（含默认 `mova_${name}` 推导值）占用它们
 * 都会让「发现」和「执行」自相矛盾：tools/list 里会出现两个同名条目，调用永远进元工具分支。
 */
export const RESERVED_MCP_NAMES = Object.freeze(['mova_skill_search', 'mova_skill_call', 'mova_tools_search']);

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isFilled = value => typeof value === 'string' && value.trim().length > 0;

function clone(value) {
  return isObject(value) ? { ...value } : value;
}

/** @returns {boolean} 是否是合法 semver（允许 prerelease / build 后缀） */
export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value.trim());
}

/** @returns {boolean} 是否是 kebab-case（小写、短横线分隔，无首尾/连续短横线） */
export function isKebabCase(value) {
  return typeof value === 'string' && KEBAB.test(value);
}

/**
 * 校验一个 manifest。
 * @param {unknown} manifest
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }>, warnings: Array<{ path: string, message: string }> }}
 */
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const fail = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isObject(manifest)) {
    fail('', 'manifest 必须是一个纯对象');
    return { ok: false, errors, warnings };
  }

  checkHeader(manifest, fail, warn);
  checkPermissions(manifest.permissions, fail);
  checkSessionPolicy(manifest.sessionPolicy, fail);
  checkDeprecation(manifest.deprecation, fail);
  checkTools(manifest.tools, fail, warn);

  return { ok: errors.length === 0, errors, warnings };
}

function checkHeader(manifest, fail, warn) {
  if (manifest.apiVersion !== SKILL_API_VERSION) {
    fail('apiVersion', `apiVersion 必须是 ${SKILL_API_VERSION}，实际是 ${JSON.stringify(manifest.apiVersion)}`);
  }
  if (!isFilled(manifest.id)) fail('id', 'id 必须是非空字符串');
  else if (!isKebabCase(manifest.id)) fail('id', `id 必须是 kebab-case（小写字母/数字/短横线）：${manifest.id}`);
  else if (manifest.id.length > MAX_ID_CHARS) fail('id', `id 不得超过 ${MAX_ID_CHARS} 字符：${manifest.id}`);

  if (!isSemver(manifest.version)) fail('version', `version 必须是 semver（如 1.0.0）：${JSON.stringify(manifest.version)}`);
  if (!isFilled(manifest.title)) fail('title', 'title 必须是非空字符串（中文展示名）');
  if (!isFilled(manifest.summary)) fail('summary', 'summary 必须是非空字符串（一句话能力摘要）');

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    fail('capabilities', 'capabilities 必须是非空字符串数组');
  } else if (manifest.capabilities.some(item => !isFilled(item))) {
    fail('capabilities', 'capabilities 里每一项都必须是非空字符串');
  }

  if (!Array.isArray(manifest.dependencies)) fail('dependencies', 'dependencies 必须是字符串数组（可为空数组）');
  else if (manifest.dependencies.some(item => !isFilled(item))) fail('dependencies', 'dependencies 里每一项都必须是非空字符串');

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.has(key)) warn(key, `未知字段 ${key}：拼错字段名会被静默忽略`);
  }
}

/** 七个键必须齐全、枚举合法，且不允许出现不认识的键（多写的键不会生效，只会让人以为它生效了）。 */
function checkPermissions(permissions, fail) {
  if (!isObject(permissions)) {
    fail('permissions', 'permissions 必须包含全部七个键：' + PERMISSION_KEYS.join(' / '));
    return;
  }
  for (const key of PERMISSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(permissions, key)) {
      fail(`permissions.${key}`, `permissions 缺少 ${key}（七项必须全部声明）`);
    }
  }
  for (const key of Object.keys(permissions)) {
    if (!PERMISSION_KEYS.includes(key)) {
      fail(`permissions.${key}`, `permissions 不认识的键 ${key}（只允许 ${PERMISSION_KEYS.join(' / ')}）`);
    }
  }
  for (const key of ['fs', 'memory']) {
    const level = permissions[key];
    const allowed = key === 'fs' ? FS_LEVELS : MEMORY_LEVELS;
    if (level !== undefined && !allowed.includes(level)) {
      fail(`permissions.${key}`, `permissions.${key} 必须是 ${allowed.join('|')}，实际是 ${JSON.stringify(level)}`);
    }
  }
  for (const key of ['exec', 'net', 'desktop', 'browser', 'canvas']) {
    const value = permissions[key];
    if (value !== undefined && typeof value !== 'boolean') {
      fail(`permissions.${key}`, `permissions.${key} 必须是 boolean，实际是 ${typeof value}`);
    }
  }
}

function checkSessionPolicy(policy, fail) {
  if (policy === undefined || policy === null) return;
  if (!isObject(policy)) {
    fail('sessionPolicy', 'sessionPolicy 必须是对象');
    return;
  }
  for (const key of ['allowTemporary', 'allowBrowserOnly', 'requiresVision']) {
    const value = policy[key];
    if (value !== undefined && typeof value !== 'boolean') {
      fail(`sessionPolicy.${key}`, `sessionPolicy.${key} 必须是 boolean`);
    }
  }
}

function checkDeprecation(deprecation, fail) {
  if (deprecation === undefined || deprecation === null) return;
  if (!isObject(deprecation)) {
    fail('deprecation', 'deprecation 必须是对象或 null');
    return;
  }
  if (typeof deprecation.deprecated !== 'boolean') {
    fail('deprecation.deprecated', 'deprecation.deprecated 必须是 boolean');
    return;
  }
  if (deprecation.deprecated !== true) return;
  // 只有确实弃用时才要求 since：deprecated:false 的模板不该被迫写迁移信息。
  if (!isFilled(deprecation.since)) fail('deprecation.since', 'deprecated:true 时 since 必填（如 1.4.0）');
  if (deprecation.removeIn !== undefined && !isSemver(deprecation.removeIn)) {
    fail('deprecation.removeIn', `removeIn 存在时必须是 semver：${JSON.stringify(deprecation.removeIn)}`);
  }
  if (deprecation.replacedBy !== undefined && !isFilled(deprecation.replacedBy)) {
    fail('deprecation.replacedBy', 'replacedBy 存在时必须是非空工具名');
  }
}

function checkTools(tools, fail, warn) {
  if (!Array.isArray(tools) || tools.length === 0) {
    fail('tools', 'tools 必须是非空数组');
    return;
  }
  const seen = new Map(); // 暴露名（name / mcpName / alias）-> 归属工具名
  const names = new Set();
  tools.forEach((def, index) => {
    const at = `tools[${index}]`;
    const toolName = checkToolShape(def, at, fail, warn);
    if (toolName && names.has(toolName)) fail(`${at}.name`, `工具名重复：${toolName}`);
    if (toolName) names.add(toolName);
    registerExposedNames(def, at, toolName, seen, fail);
  });
}

/** 单个 tool 的字段校验；返回可用的工具名（不可用时返回 ''）。 */
function checkToolShape(def, at, fail, warn) {
  if (!isObject(def)) {
    fail(at, '每个 tool 必须是对象');
    return '';
  }
  let name = '';
  if (!isFilled(def.name)) fail(`${at}.name`, 'name 必须是非空字符串');
  else if (!TOOL_NAME.test(def.name)) fail(`${at}.name`, `name 只允许小写字母/数字/下划线且字母开头：${def.name}`);
  else if (def.name.length > MAX_TOOL_NAME_CHARS) fail(`${at}.name`, `name 不得超过 ${MAX_TOOL_NAME_CHARS} 字符`);
  else name = def.name;

  // 与顶层 MANIFEST_KEYS 同策：未知字段只告警——拼错的字段会被静默忽略，作者必须看到提示。
  for (const key of Object.keys(def)) {
    if (!TOOL_KEYS.has(key)) warn(`${at}.${key}`, `${at} 上的未知字段 ${key}：拼错字段名会被静默忽略`);
  }

  if (def.mcpName !== undefined && !isFilled(def.mcpName)) fail(`${at}.mcpName`, 'mcpName 存在时必须是非空字符串');
  if (def.aliases !== undefined) {
    if (!Array.isArray(def.aliases)) fail(`${at}.aliases`, 'aliases 存在时必须是字符串数组');
    else if (def.aliases.some(item => !isFilled(item))) fail(`${at}.aliases`, 'aliases 里每一项都必须是非空字符串');
  }
  // 保留名：显式写的 mcpName 与 `mova_${name}` 默认推导值都要避开三个元工具。
  const exposed = isFilled(def.mcpName) ? def.mcpName : (name ? `mova_${name}` : '');
  if (exposed && RESERVED_MCP_NAMES.includes(exposed)) {
    fail(`${at}.mcpName`, `暴露名 ${exposed} 是 MCP 元工具保留名（${RESERVED_MCP_NAMES.join(' / ')}），换一个名字或显式声明其他 mcpName`);
  }

  if (!isFilled(def.label)) fail(`${at}.label`, 'label 必须是非空字符串（前端 tool 行展示名）');
  if (!isFilled(def.description)) fail(`${at}.description`, 'description 必须是非空字符串');

  if (!isFilled(def.mcpSummary)) fail(`${at}.mcpSummary`, 'mcpSummary 必须是非空字符串（MCP tools/list 摘要）');
  else {
    const lines = def.mcpSummary.split('\n');
    if (lines.length > MAX_MCP_SUMMARY_LINES) {
      fail(`${at}.mcpSummary`, `mcpSummary 不得超过 ${MAX_MCP_SUMMARY_LINES} 行（当前 ${lines.length} 行）`);
    }
    if (lines.some(line => line.length > MAX_MCP_SUMMARY_CHARS)) {
      fail(`${at}.mcpSummary`, `mcpSummary 每行不得超过 ${MAX_MCP_SUMMARY_CHARS} 字符（当前最长 ${Math.max(...lines.map(line => line.length))} 字符）`);
    }
  }

  if (!RISK_LEVELS.includes(def.risk)) {
    fail(`${at}.risk`, `risk 必须是 ${RISK_LEVELS.join('|')}，实际是 ${JSON.stringify(def.risk)}`);
  }
  checkApproval(def.approval, at, def.risk, fail);
  checkExposure(def.exposure, at, fail);
  checkNumbers(def, at, fail);
  checkResultBudget(def, at, fail);
  checkInputSchema(def.inputSchema, `${at}.inputSchema`, fail);
  checkExamples(def.examples, at, fail);
  return name;
}

function checkApproval(approval, at, risk, fail) {
  if (approval === undefined || approval === null) return;
  if (!isObject(approval)) {
    fail(`${at}.approval`, 'approval 必须是对象');
    return;
  }
  if (!APPROVAL_MODES.includes(approval.mode)) {
    fail(`${at}.approval.mode`, `approval.mode 必须是 ${APPROVAL_MODES.join('|')}，实际是 ${JSON.stringify(approval.mode)}`);
  }
  if (approval.capability !== undefined && !APPROVAL_CAPABILITIES.includes(approval.capability)) {
    fail(`${at}.approval.capability`, `approval.capability 必须是 ${APPROVAL_CAPABILITIES.join('|')}`);
  }
  if (approval.allowSession !== undefined && typeof approval.allowSession !== 'boolean') {
    fail(`${at}.approval.allowSession`, 'approval.allowSession 必须是 boolean');
  }
  if (approval.mode === 'none' && (risk === 'write' || risk === 'exec')) {
    fail(`${at}.approval.mode`, `risk:${risk} 的工具不允许 approval.mode:'none'（必须过审批闸门）`);
  }
}

function checkExposure(exposure, at, fail) {
  if (!isObject(exposure)) {
    fail(`${at}.exposure`, 'exposure 必须声明 { piAi: boolean, mcp: core|on_demand|off }');
    return;
  }
  if (typeof exposure.piAi !== 'boolean') fail(`${at}.exposure.piAi`, 'exposure.piAi 必须是 boolean');
  if (!MCP_EXPOSURES.includes(exposure.mcp)) {
    fail(`${at}.exposure.mcp`, `exposure.mcp 必须是 ${MCP_EXPOSURES.join('|')}，实际是 ${JSON.stringify(exposure.mcp)}`);
  }
}

function checkNumbers(def, at, fail) {
  if (def.timeoutMs !== undefined && !(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0)) {
    fail(`${at}.timeoutMs`, 'timeoutMs 存在时必须是正数（毫秒）');
  }
  for (const key of ['supportsProgress', 'imageOutput']) {
    if (def[key] !== undefined && typeof def[key] !== 'boolean') fail(`${at}.${key}`, `${key} 必须是 boolean`);
  }
}

/**
 * 结果预算：**越界是 error 而不是 warning**——声明写错的结果是「工具自己说能出 24000 字，
 * 技能层却按 8192 砍掉」，模型拿到的是一份被截断的页面快照还以为看全了，这种错误必须拒绝加载。
 */
function checkResultBudget(def, at, fail) {
  const value = def.maxResultChars;
  if (value === undefined) return;
  if (!Number.isInteger(value)) {
    fail(`${at}.maxResultChars`, `maxResultChars 存在时必须是整数（默认 ${DEFAULT_MAX_RESULT_CHARS}），实际是 ${JSON.stringify(value)}`);
    return;
  }
  if (value < MIN_RESULT_CHARS || value > MAX_RESULT_CHARS) {
    fail(`${at}.maxResultChars`, `maxResultChars 必须在 ${MIN_RESULT_CHARS}–${MAX_RESULT_CHARS} 之间，实际是 ${value}`);
  }
}

/**
 * 读一个 tool def 的结果预算（唯一读者：skills/index.mjs 与两条适配器）。
 * 没声明就用 fallback（默认 DEFAULT_MAX_RESULT_CHARS）；声明越界时同样退到 fallback——
 * 越界在 manifest 校验阶段已经是 error，这里只保证「坏值不会变成 0 或 NaN 把结果全都砍光」。
 * @param {{ maxResultChars?: number }|null|undefined} def
 * @param {number} [fallback]
 * @returns {number} 正整数字符预算
 */
export function resultBudgetOf(def, fallback = DEFAULT_MAX_RESULT_CHARS) {
  const declared = def?.maxResultChars;
  if (Number.isInteger(declared) && declared >= MIN_RESULT_CHARS && declared <= MAX_RESULT_CHARS) return declared;
  return Number.isInteger(fallback) && fallback > 0 ? fallback : DEFAULT_MAX_RESULT_CHARS;
}

function checkInputSchema(schema, at, fail) {
  if (!isObject(schema)) {
    fail(at, 'inputSchema 必须是 JSON Schema 对象');
    return;
  }
  if (schema.type !== 'object') fail(at, `inputSchema.type 必须是 'object'，实际是 ${JSON.stringify(schema.type)}`);
  if (schema.additionalProperties !== false) fail(at, 'inputSchema.additionalProperties 必须是 false');
  if (schema.properties !== undefined && !isObject(schema.properties)) fail(at, 'inputSchema.properties 必须是对象');
  if (schema.required !== undefined && !Array.isArray(schema.required)) fail(at, 'inputSchema.required 必须是数组');
  // required 必须是 properties 的子集：required 里写了 schema 没声明的参数，模型传了也会被校验器丢掉。
  if (!Array.isArray(schema.required)) return;
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const key of schema.required) {
    if (!isFilled(key)) {
      fail(`${at}.required`, 'required 里每一项都必须是非空字符串');
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      fail(`${at}.required`, `required 里的 ${key} 不在 properties 里（模型照 schema 传参永远缺这一项）`);
    }
  }
}

function checkExamples(examples, at, fail) {
  if (!Array.isArray(examples) || examples.length === 0) {
    fail(`${at}.examples`, `examples 必须有 1-${MAX_EXAMPLES} 条可执行示例`);
    return;
  }
  if (examples.length > MAX_EXAMPLES) fail(`${at}.examples`, `examples 最多 ${MAX_EXAMPLES} 条（当前 ${examples.length} 条）`);
  examples.forEach((item, index) => {
    const path = `${at}.examples[${index}]`;
    if (!isObject(item)) {
      fail(path, '示例必须是 { title, arguments } 对象');
      return;
    }
    if (!isFilled(item.title)) fail(`${path}.title`, '示例 title 必须是非空字符串');
    if (!isObject(item.arguments)) fail(`${path}.arguments`, '示例 arguments 必须是对象');
  });
}

/** 把 name / mcpName / aliases 都登记进同一张表：两个工具抢同一个暴露名，模型必然选错。 */
function registerExposedNames(def, at, ownName, seen, fail) {
  if (!isObject(def)) return;
  const exhausted = [];
  if (ownName) exhausted.push({ value: ownName, path: `${at}.name` });
  exhausted.push({ value: isFilled(def.mcpName) ? def.mcpName : (ownName ? `mova_${ownName}` : ''), path: `${at}.mcpName` });
  const aliases = Array.isArray(def.aliases) ? def.aliases : [];
  aliases.forEach((alias, index) => exhausted.push({ value: alias, path: `${at}.aliases[${index}]` }));
  for (const { value, path } of exhausted) {
    if (!isFilled(value)) continue;
    if (value === ownName && path === `${at}.mcpName`) continue; // mcpName 显式等于 name 属于无意义的冗余，不报冲突
    const owner = seen.get(value);
    if (owner && owner !== ownName) {
      fail(path, `暴露名 ${value} 已被工具 ${owner} 占用（name / mcpName / aliases 三者共用一个命名空间）`);
      continue;
    }
    seen.set(value, ownName || value);
  }
}

/**
 * 校验并抛错：pack 自身是程序错误而不是用户输入，静默跳过会把作者的手误藏起来。
 * @param {unknown} manifest
 * @returns {unknown} 同一个 manifest（便于链式调用）
 * @throws {Error & { code: 'invalid_manifest' }}
 */
export function assertValidManifest(manifest) {
  const result = validateManifest(manifest);
  if (result.ok) return manifest;
  const first = result.errors[0];
  const error = new Error(`无效的技能包 manifest（${first.path || '<root>'}）：${first.message}`);
  error.code = 'invalid_manifest';
  error.path = first.path;
  error.errors = result.errors;
  error.warnings = result.warnings;
  throw error;
}

function defaultApproval(def) {
  if (def.approval && typeof def.approval === 'object') {
    const mode = APPROVAL_MODES.includes(def.approval.mode) ? def.approval.mode : 'policy';
    const capability = APPROVAL_CAPABILITIES.includes(def.approval.capability)
      ? def.approval.capability
      : (def.risk === 'write' || def.risk === 'exec' ? def.risk : undefined);
    return { ...def.approval, mode, ...(capability ? { capability } : {}), allowSession: def.approval.allowSession === true };
  }
  // 保守默认：none 直接放行，其余按风险走审批闸门（write/exec 带能力位）。
  const mode = def.risk === 'none' ? 'none' : 'policy';
  const capability = def.risk === 'write' || def.risk === 'exec' ? def.risk : undefined;
  return { mode, ...(capability ? { capability } : {}), allowSession: false };
}

/**
 * 补默认值，返回新对象（不修改入参；manifest 通常是 Object.freeze 的纯数据）。
 * 不校验：需要校验请先 `validateManifest` / `assertValidManifest`。
 * @param {any} manifest
 * @returns {any} 归一后的 manifest（tools 每项都带 mcpName / aliases / timeoutMs / approval / exposure）
 */
export function normalizeManifest(manifest) {
  if (!isObject(manifest)) return manifest;
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  return {
    ...manifest,
    apiVersion: manifest.apiVersion ?? SKILL_API_VERSION,
    dependencies: Array.isArray(manifest.dependencies) ? [...manifest.dependencies] : [],
    capabilities: Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : [],
    sessionPolicy: {
      allowTemporary: true,
      allowBrowserOnly: true,
      requiresVision: false,
      ...(isObject(manifest.sessionPolicy) ? manifest.sessionPolicy : {}),
    },
    deprecation: isObject(manifest.deprecation) ? clone(manifest.deprecation) : null,
    tools: tools.map(def => (isObject(def) ? normalizeTool(def) : def)),
  };
}

function normalizeTool(def) {
  const name = typeof def.name === 'string' ? def.name : '';
  return {
    ...def,
    mcpName: isFilled(def.mcpName) ? def.mcpName : `mova_${name}`,
    aliases: Array.isArray(def.aliases) ? [...def.aliases] : [],
    timeoutMs: Number.isFinite(def.timeoutMs) && def.timeoutMs > 0 ? def.timeoutMs : DEFAULT_TIMEOUT_MS,
    supportsProgress: def.supportsProgress === true,
    imageOutput: def.imageOutput === true,
    approval: defaultApproval(def),
    // `maxResultChars` 刻意**不**在这里补默认值：适配器的全局上限（toMcpToolTable 的 maxTextChars）
    // 只有在「工具没声明预算」时才该生效，填了默认值就再也分不清「没声明」和「声明了 8192」。
    // 读预算一律走 resultBudgetOf()。
  };
}
