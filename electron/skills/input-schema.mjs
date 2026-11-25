/**
 * 负责：**技能层唯一的入参校验入口** —— 按 tool 的 inputSchema 子集做「校验 + 归一」，
 *   缺参 / 类型 / 长度 / 范围 / 枚举 / 数组项 / 嵌套对象 / 多余键都只在这里判一次；
 *   并把 MCP 形状的 `invalid_arguments` 错误结果也收在这一个文件里（错误码只有一处拼写）。
 * 不负责：业务判断（路径是否越界、ref 是否存在、站点风险、动作是否合法）、审批、结果截断
 *   （electron/mcp/normalize.mjs）、manifest 字段校验（manifest-schema.mjs）；
 *   也不决定某个工具的 schema 该写成什么样——那是各 pack 的 manifest 与 handlers 里的 SPECS。
 * 被谁调用：electron/skills/packs/{project-fs,browser-automation,desktop-control,design-canvas}/handlers.mjs、
 *   tests/skills-input-schema.test.mjs。
 *
 * 纯函数、零 IO、零 electron import：能被 `node --test` 裸跑。
 *
 * 方言（JSON Schema 子集 + 四个本仓库扩展，不要再发明第六种写法）：
 * - 对象：`{ type: 'object', properties, required?: string[], additionalProperties?: false }`
 * - 字段：`{ type, required?: true, ... }`，type ∈ string | number | integer | boolean | array | object
 * - string：`minLength` / `maxLength` / `allowEmpty`（默认 false）
 * - number / integer：`minimum` / `maximum`
 * - string + 枚举：`enum: string[]`（可配 `normalize: 'upper'`）
 * - array：`items`（`{ type: 'string' | 'object' }`，items 上可写 `minLength` / `maxLength` / `trim`）、
 *   `minItems` / `maxItems`
 * - object：`properties` / `required` / `additionalProperties`（内嵌结构按同一方言递归）
 * - 扩展 1：字段级 `required: true`，等价于把字段名写进父级 `required` 数组（既有 pack 的写法，保留）
 * - 扩展 2：`allowEmpty: true`（必填也允许空串，例如 write_file 的 content）
 * - 扩展 3：`normalize: 'upper'`（枚举大小写宽容：模型常把 "png" 当格式名传）
 * - 扩展 4：`items.trim`（数组项 trim 后再校验/返回）
 *
 * `additionalProperties: false` 的语义是「声明即白名单」：未声明的键被**丢弃**而不是报错——
 *   模型多写一个键不该让整次调用失败，但它也绝不能悄悄流进下游实现。
 *
 * 错误消息的约定：`path` 是点分路径（顶层就是字段名），`message` 以字段名开头且说清怎么改。
 *   为什么 message 里再写一遍字段名：pack 的 handler 只把第一条 message 交给模型，
 *   嵌套字段的 path 到不了那边，消息自己必须带上是哪个字段。
 */

import { errorResult } from '../mcp/normalize.mjs';

/** `emptyStrings` 可选的两值，见 validateInput 的 options。 */
const EMPTY_STRING_MODES = Object.freeze(['drop', 'keep']);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function finiteOf(rule, key) {
  const value = rule?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 校验并归一一份入参。
 * @param {object} schema `{ type: 'object', properties, required?, additionalProperties? }`
 * @param {unknown} input 模型/调用方给的对象（非对象按空对象处理，与 handler 的既有兜底一致）
 * @param {{ emptyStrings?: 'drop'|'keep' }} [options]
 *   `emptyStrings`：可选字符串为空串时的处理。默认 `'drop'`（等于「当成没传」，project-fs /
 *   desktop-control / design-canvas 的既有行为）；`'keep'` 时原样保留——browser-automation 必须用它，
 *   因为 `browser_act{action:'fill', value:''}` 的真实意图是「清空输入框」，不能被当成没传。
 * @returns {{ ok: true, value: object } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export function validateInput(schema, input, options = {}) {
  if (!isPlainObject(schema)) {
    return { ok: false, errors: [{ path: '', message: '入参规则必须是 { type: "object", properties } 对象' }] };
  }
  const errors = [];
  const config = {
    emptyStrings: EMPTY_STRING_MODES.includes(options?.emptyStrings) ? options.emptyStrings : 'drop',
  };
  const source = isPlainObject(input) ? input : {};
  const value = validateObject(schema, source, '', errors, config);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * 把校验错误收敛成 MCP 形状的 `invalid_arguments` 结果（与 normalize.mjs 的 errorResult 同形）。
 * 只取第一条消息：错误是摘要，模型看到第一条就够改了；堆八条只会把上下文挤满。
 * @param {Array<{ path?: string, message?: string }>|string} errors
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError: true }}
 */
export function invalidArgumentsResult(errors) {
  const list = Array.isArray(errors) ? errors : (errors === undefined ? [] : [errors]);
  const first = list[0];
  const message = typeof first === 'string'
    ? first
    : (typeof first?.message === 'string' && first.message.trim() ? first.message : '参数不合法');
  return errorResult('invalid_arguments', message);
}

/** 递归校验一个对象：只输出声明过的键（声明即白名单），并处理 required。 */
function validateObject(schema, input, prefix, errors, config) {
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const out = {};
  for (const [key, rule] of Object.entries(properties)) {
    if (!isPlainObject(rule)) {
      errors.push({ path: joinPath(prefix, key), message: `${key} 的校验规则未定义` });
      continue;
    }
    const path = joinPath(prefix, key);
    const isRequired = required.has(key) || rule.required === true;
    const value = input[key];
    if (value === undefined || value === null) {
      if (isRequired) errors.push({ path, message: `缺少必填参数 ${key}` });
      continue;
    }
    const checked = validateField(key, path, rule, value, errors, { ...config, isRequired });
    if (!checked.ok || checked.dropped === true) continue;
    out[key] = checked.value;
  }
  return out;
}

/**
 * 校验单个字段。
 * @returns {{ ok: true, value?: unknown, dropped?: true } | { ok: false }}
 */
function validateField(key, path, rule, value, errors, config) {
  const fail = message => {
    errors.push({ path, message });
    return { ok: false };
  };

  // 枚举优先：`{ type: 'string', enum }` 是最常见的写法，归一（大写/trim）也在这一步做。
  if (Array.isArray(rule.enum)) {
    const normalized = typeof value === 'string' && rule.normalize === 'upper'
      ? value.trim().toUpperCase()
      : value;
    if (!rule.enum.includes(normalized)) return fail(`${key} 只能是 ${rule.enum.join(' / ')}`);
    return { ok: true, value: normalized };
  }

  if (rule.type === 'string') {
    if (typeof value !== 'string') return fail(`${key} 必须是字符串`);
    const maxLength = finiteOf(rule, 'maxLength');
    const minLength = finiteOf(rule, 'minLength');
    if (rule.allowEmpty !== true && !value.trim()) {
      if (config.isRequired) return fail(`${key} 不能为空`);
      // 可选空串：当成没传（默认）或原样保留（emptyStrings:'keep'）。
      return config.emptyStrings === 'keep' ? { ok: true, value } : { ok: true, dropped: true };
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return fail(`${key} 超过 ${maxLength} 字符上限（当前 ${value.length}）`);
    }
    if (minLength !== undefined && value.trim().length < minLength) return fail(`${key} 至少 ${minLength} 个字符`);
    return { ok: true, value };
  }

  if (rule.type === 'number' || rule.type === 'integer') {
    // 模型常把数字写成字符串（"5"）：在边界处转成数字，比让它报「必须是整数」更有用。
    const number = typeof value === 'number' ? value : Number(value);
    if (rule.type === 'integer') {
      if (!Number.isInteger(number)) return fail(`${key} 必须是整数`);
    } else if (!Number.isFinite(number)) {
      return fail(`${key} 必须是数字`);
    }
    const minimum = finiteOf(rule, 'minimum');
    const maximum = finiteOf(rule, 'maximum');
    if (minimum !== undefined && number < minimum) return fail(`${key} 不能小于 ${minimum}`);
    if (maximum !== undefined && number > maximum) return fail(`${key} 不能大于 ${maximum}`);
    return { ok: true, value: number };
  }

  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return fail(`${key} 必须是布尔值`);
    return { ok: true, value };
  }

  if (rule.type === 'array') return validateArray(key, path, rule, value, errors, config);

  if (rule.type === 'object') {
    if (!isPlainObject(value)) return fail(`${key} 必须是对象`);
    // 只声明了 `{ type:'object' }` 的自由对象（如 desktop_act.expect）原样透传：
    // 它的键由下游实现判，这里多校验一层就会变成第二份 schema。
    if (!isPlainObject(rule.properties)) return { ok: true, value };
    return { ok: true, value: validateObject(rule, value, path, errors, config) };
  }

  return fail(`${key} 的校验规则未定义`);
}

function validateArray(key, path, rule, value, errors, config) {
  if (!Array.isArray(value)) {
    errors.push({ path, message: `${key} 必须是数组` });
    return { ok: false };
  }
  const minItems = finiteOf(rule, 'minItems');
  const maxItems = finiteOf(rule, 'maxItems');
  if (minItems !== undefined && value.length < minItems) {
    errors.push({ path, message: `${key} 至少 ${minItems} 项` });
    return { ok: false };
  }
  if (maxItems !== undefined && value.length > maxItems) {
    errors.push({ path, message: `${key} 最多 ${maxItems} 项（当前 ${value.length}）` });
    return { ok: false };
  }
  const items = isPlainObject(rule.items) ? rule.items : null;
  if (!items) return { ok: true, value }; // 数组项由下游自己判（如 browser_batch 的 steps）

  const trimmed = items.trim === true && items.type === 'string';
  const out = [];
  for (const item of value) {
    if (items.type === 'string') {
      if (typeof item !== 'string') {
        errors.push({ path, message: `${key} 的每一项都必须是字符串` });
        return { ok: false };
      }
      const text = trimmed ? item.trim() : item;
      const minLength = finiteOf(items, 'minLength');
      if (minLength !== undefined && text.trim().length < minLength) {
        errors.push({ path, message: `${key} 的每一项都必须是非空字符串` });
        return { ok: false };
      }
      const maxLength = finiteOf(items, 'maxLength');
      if (maxLength !== undefined && text.length > maxLength) {
        errors.push({ path, message: `${key} 的每一项不得超过 ${maxLength} 字符` });
        return { ok: false };
      }
      out.push(text);
      continue;
    }
    if (items.type === 'object') {
      if (!isPlainObject(item)) {
        errors.push({ path, message: `${key} 的每一项都必须是对象` });
        return { ok: false };
      }
      out.push(item);
      continue;
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

function joinPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}
