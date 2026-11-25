/* 表单卡（elicitation）纯逻辑：把 JSON-Schema 降成可直接渲染的字段模型，并负责
   值状态、校验、回填内容三件事。
   不负责：渲染、React/DOM、网络、落盘——所以 node --test 能脱离 Electron 直接跑。
   被 src/features/ask/ask-form.jsx（渲染层）调用；规则来源见
   Mova-CLI模型-开发文档.md §12.4.2（类型→控件映射）、§12.4.4（校验）、§12.4.7（限制与降级）。 */

const DEFAULTS = Object.freeze({ maxDepth: 5, maxFields: 40, maxItems: 20, maxSchemaBytes: 65536 });
const TEXTAREA_MAX = 240; // §12.4.2：maxLength ≤ 240 走单行，超过才给多行
const SEGMENT_MAX = 4; // §12.4.2：2–4 项内联分段，≥5 项下拉
// Node 与浏览器都提供 TextEncoder；用 globalThis 取，避免把模块锁在 node（不依赖 Buffer）。
const encoder = new globalThis.TextEncoder();

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target ?? {}, key);

function baseType(schema) {
  if (!isPlainObject(schema)) return null;
  const type = schema.type;
  if (Array.isArray(type)) return type.find(item => item !== 'null') ?? null;
  if (typeof type === 'string') return type;
  // 无 type 时按结构猜：elicitation 里 enum-only / properties-only 很常见
  if (isPlainObject(schema.properties) || schema.additionalProperties) return 'object';
  if (schema.items) return 'array';
  if (Array.isArray(schema.enum)) return 'string';
  return null;
}

// enum 里的 null 只用于「留空」，不能当选项渲染，所以单独用 allowNull 表达
function enumOf(schema) {
  if (!Array.isArray(schema?.enum)) return null;
  return schema.enum.filter(item => item !== null);
}

function allowsNull(schema) {
  if (Array.isArray(schema?.enum) && schema.enum.includes(null)) return true;
  return Array.isArray(schema?.type) && schema.type.includes('null');
}

function labelOf(schema, key) {
  const title = typeof schema?.title === 'string' ? schema.title.trim() : '';
  return title || key;
}

function unsupportedReasonOf(schema) {
  if (schema?.$ref) return '暂不支持 $ref 引用，请在终端填写';
  if (schema?.format === 'file') return '暂不支持文件选择，请在终端填写';
  if (schema?.oneOf || schema?.anyOf || schema?.allOf) return '暂不支持 oneOf/anyOf 分支，请在终端填写';
  const type = baseType(schema);
  if (type === 'array') return '暂不支持该数组的项类型';
  if (type === 'object') return '对象没有可填写的字段';
  return '暂不支持该字段类型';
}

export function describeFieldType(schema) {
  if (!isPlainObject(schema)) return 'unsupported';
  if (schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) return 'unsupported';
  if (schema.format === 'file') return 'unsupported';

  const type = baseType(schema);
  if (type === 'string') {
    if (Array.isArray(schema.enum)) {
      const values = enumOf(schema);
      if (!values.length) return 'text'; // 只有 null 可选：退化成文本框，不渲染空分段
      return values.length <= SEGMENT_MAX ? 'segment' : 'select';
    }
    if (schema.format === 'multi') return 'textarea';
    if (typeof schema.maxLength === 'number' && schema.maxLength > TEXTAREA_MAX) return 'textarea';
    return 'text'; // path / uri / email 等都只是字符串，统一文本（不弹系统选择器、不渲染链接）
  }
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'switch';
  if (type === 'array') {
    const items = schema.items;
    if (!isPlainObject(items) || items.$ref || items.format === 'file') return 'unsupported';
    const itemType = baseType(items);
    if (itemType === 'object') return 'object-list';
    if (itemType === 'array') return 'unsupported';
    return 'string-list';
  }
  if (type === 'object') {
    if (isPlainObject(schema.properties) && Object.keys(schema.properties).length) return 'object';
    if (schema.additionalProperties && schema.additionalProperties !== false) return 'key-value';
    return 'unsupported';
  }
  return 'unsupported';
}

function utf8Bytes(value) {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return null;
    return encoder.encode(json).length;
  } catch {
    return null; // 循环引用等：交给调用方整体降级，不在这里抛
  }
}

/* ---------------------------------------------------------------- 建模 */

export function buildFormModel(schema, options) {
  const opts = { ...DEFAULTS };
  if (isPlainObject(options)) {
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof options[key] === 'number' && options[key] > 0) opts[key] = options[key];
    }
  }

  const bytes = utf8Bytes(schema);
  if (bytes === null || !isPlainObject(schema) || !isPlainObject(schema.properties)) {
    return {
      kind: 'degraded',
      fields: [],
      degradedReason: bytes === null ? 'schema 无法解析，请在终端填写' : 'schema 不是带 properties 的对象，无法渲染表单',
      stats: { fields: 0, depth: 0, bytes: bytes ?? 0 },
    };
  }

  const ctx = { opts, count: 0, depth: 0, tooMany: false, tooDeep: false };
  const fields = buildFields(schema, ctx, '', 0);

  const reasons = [];
  if (bytes > opts.maxSchemaBytes) reasons.push(`schema 过大（${bytes} 字节 > ${opts.maxSchemaBytes}）`);
  if (ctx.tooMany) reasons.push(`字段过多（超过 ${opts.maxFields} 个）`);
  if (ctx.tooDeep) reasons.push(`嵌套过深（超过 ${opts.maxDepth} 层）`);

  return {
    kind: reasons.length ? 'degraded' : 'form',
    fields,
    ...(reasons.length ? { degradedReason: reasons.join('；') } : {}),
    stats: { fields: ctx.count, depth: ctx.depth, bytes },
  };
}

function buildFields(schema, ctx, parentPath, depth) {
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  const requiredKeys = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const out = [];
  for (const [key, child] of Object.entries(props)) {
    if (ctx.count >= ctx.opts.maxFields) {
      ctx.tooMany = true;
      break; // 超限直接停手：多余字段既渲染不了，也会把卡片撑爆
    }
    out.push(buildNode(key, child, ctx, joinPath(parentPath, key), depth, requiredKeys.has(key)));
  }
  return out;
}

function buildNode(key, schema, ctx, path, depth, required) {
  const spec = isPlainObject(schema) ? schema : {};
  const kind = describeFieldType(spec);
  const type = baseType(spec);
  ctx.count += 1;
  ctx.depth = Math.max(ctx.depth, depth);

  const node = { path, key, depth, kind, label: labelOf(spec, key), required: Boolean(required) };
  if (typeof spec.description === 'string' && spec.description.trim()) node.description = spec.description.trim();
  if (Array.isArray(spec.enum)) {
    node.enumValues = enumOf(spec);
    node.allowNull = allowsNull(spec);
  } else if (allowsNull(spec)) {
    node.allowNull = true;
  }
  if (type === 'integer') node.integer = true; // 校验要用：integer 拒绝小数
  if (typeof spec.pattern === 'string' && spec.pattern) node.pattern = spec.pattern;
  for (const bound of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems']) {
    if (typeof spec[bound] === 'number') node[bound] = spec[bound];
  }
  const unit = spec.unit ?? spec['x-unit'];
  if (typeof unit === 'string' && unit.trim()) node.unit = unit.trim();

  if (kind === 'unsupported') {
    node.unsupportedReason = unsupportedReasonOf(spec);
    return node;
  }

  if (kind === 'object' || kind === 'object-list') {
    if (depth + 1 > ctx.opts.maxDepth) {
      ctx.tooDeep = true;
      node.unsupportedReason = `嵌套过深（超过 ${ctx.opts.maxDepth} 层），请在终端填写`;
      return node; // 停止展开，但保留节点让上层能提示
    }
  }

  if (kind === 'object') {
    node.children = buildFields(spec, ctx, path, depth + 1);
    if (!node.children.length) {
      node.kind = 'unsupported';
      node.unsupportedReason = '对象没有可填写的字段';
    }
    return node;
  }

  if (kind === 'object-list') {
    const items = isPlainObject(spec.items) ? spec.items : {};
    node.itemKind = 'object';
    applyItemBounds(node, spec, ctx.opts.maxItems);
    node.children = buildFields(items, ctx, `${path}[0]`, depth + 1);
    if (!node.children.length) {
      node.kind = 'unsupported';
      node.unsupportedReason = '数组项没有可填写的字段';
    }
    return node;
  }

  if (kind === 'string-list') {
    node.itemKind = baseType(spec.items) ?? 'string';
    applyItemBounds(node, spec, ctx.opts.maxItems); // §12.4.7：20 项封顶，到顶禁用「添加」
  }
  return node;
}

function applyItemBounds(node, spec, cap) {
  const declaredMax = typeof spec.maxItems === 'number' ? spec.maxItems : cap;
  node.maxItems = Math.min(declaredMax, cap);
  if (typeof spec.minItems === 'number') node.minItems = Math.min(spec.minItems, cap);
}

/* ---------------------------------------------------------------- 路径 */

function joinPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

// 'jobs[2].name' → [{key:'jobs'},{index:2},{key:'name'}]
function parsePath(path) {
  const tokens = [];
  for (const segment of String(path ?? '').split('.')) {
    const text = segment.trim();
    if (!text) continue;
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(text);
    if (!match) {
      tokens.push({ key: text });
      continue;
    }
    tokens.push({ key: match[1] });
    for (const bracket of match[2].matchAll(/\[(\d+)\]/g)) tokens.push({ index: Number(bracket[1]) });
  }
  return tokens;
}

/* ---------------------------------------------------------------- 状态 */

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item);
    return out;
  }
  return value;
}

// 只保留 schema 声明过的键：模型侧塞进来的额外字段在这里就被丢掉（§12.4.8）
function pickDeclared(fields, source) {
  const out = {};
  for (const field of fields) {
    if (!field || field.kind === 'unsupported' || !hasOwn(source, field.key)) continue;
    const raw = source[field.key];
    if (field.kind === 'object') {
      if (!isPlainObject(raw)) continue;
      const child = pickDeclared(field.children ?? [], raw);
      if (Object.keys(child).length) out[field.key] = child;
      continue;
    }
    if (field.kind === 'object-list') {
      if (!Array.isArray(raw)) continue;
      const rows = raw
        .filter(isPlainObject)
        .map(row => pickDeclared(field.children ?? [], row))
        .filter(row => Object.keys(row).length);
      if (rows.length) out[field.key] = rows;
      continue;
    }
    out[field.key] = cloneValue(raw);
  }
  return out;
}

export function createFormState(fields, initial) {
  const list = Array.isArray(fields) ? fields : [];
  return { values: pickDeclared(list, isPlainObject(initial) ? initial : {}) };
}

export function setFieldValue(state, path, value) {
  const current = isPlainObject(state?.values) ? state.values : {};
  const tokens = parsePath(path);
  if (!tokens.length) return { ...state, values: current };
  return { ...state, values: assignAt(current, tokens, 0, value) };
}

function assignAt(container, tokens, index, value) {
  const token = tokens[index];
  const last = index === tokens.length - 1;

  if (token.key !== undefined) {
    const base = isPlainObject(container) ? { ...container } : {};
    if (last) {
      if (value === undefined) delete base[token.key];
      else base[token.key] = value;
      return base;
    }
    const child = hasOwn(container, token.key) ? container[token.key] : undefined;
    base[token.key] = assignAt(child, tokens, index + 1, value);
    return base;
  }

  const list = Array.isArray(container) ? container.slice() : [];
  while (list.length < token.index) list.push(null); // 补空位，保证数组稠密
  if (last) {
    if (value === undefined) list.splice(token.index, 1);
    else list[token.index] = value;
    return list;
  }
  list[token.index] = assignAt(container?.[token.index], tokens, index + 1, value);
  return list;
}

/* ---------------------------------------------------------------- 校验 */

function toNumber(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return Number.NaN;
}

function toBoolean(raw) {
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function keyValueRows(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter(row => isPlainObject(row) || Array.isArray(row))
      .map(row => (Array.isArray(row) ? { key: row[0], value: row[1] } : row));
  }
  if (isPlainObject(raw)) return Object.entries(raw).map(([key, value]) => ({ key, value }));
  return [];
}

function isMissing(field, raw) {
  if (raw === undefined) return true;
  if (raw === null) return field.allowNull !== true; // 显式「留空」算已填
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'select':
    case 'segment':
      return String(raw).trim() === '';
    case 'number':
      return !Number.isFinite(toNumber(raw));
    case 'switch':
      return raw === '';
    case 'string-list':
      return !Array.isArray(raw) || raw.every(item => String(item ?? '').trim() === '');
    case 'key-value':
      return keyValueRows(raw).every(row => !String(row?.key ?? '').trim());
    default:
      return false;
  }
}

function compilePattern(source) {
  try {
    return { ok: true, regex: new RegExp(source) };
  } catch {
    return { ok: false }; // §12.4.4：编译失败忽略该规则，只记一次诊断，绝不上抛
  }
}

export function validateForm(fields, values) {
  const errors = [];
  const warnings = [];
  validateFields(Array.isArray(fields) ? fields : [], isPlainObject(values) ? values : {}, '', errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}

function validateFields(fields, values, prefix, errors, warnings) {
  for (const field of fields) {
    if (!field || field.kind === 'unsupported') continue; // 不可填的字段不能卡住提交
    const path = joinPath(prefix, field.key);
    const raw = values[field.key];

    if (field.kind === 'object') {
      validateFields(field.children ?? [], isPlainObject(raw) ? raw : {}, path, errors, warnings);
      continue;
    }

    if (field.kind === 'object-list') {
      const rows = Array.isArray(raw) ? raw : [];
      if (!rows.length) {
        if (field.required) errors.push({ path, message: `${field.label}不能为空` });
        continue;
      }
      checkCount(field, path, rows.length, errors);
      rows.forEach((row, index) => {
        validateFields(field.children ?? [], isPlainObject(row) ? row : {}, `${path}[${index}]`, errors, warnings);
      });
      continue;
    }

    if (isMissing(field, raw)) {
      if (field.required) errors.push({ path, message: `${field.label}不能为空` });
      continue;
    }
    validateValue(field, path, raw, errors, warnings);
  }
}

function checkCount(field, path, count, errors) {
  if (typeof field.minItems === 'number' && count < field.minItems) {
    errors.push({ path, message: `${field.label}至少 ${field.minItems} 项` });
  }
  if (typeof field.maxItems === 'number' && count > field.maxItems) {
    errors.push({ path, message: `${field.label}最多 ${field.maxItems} 项` });
  }
}

function validateValue(field, path, raw, errors, warnings) {
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'select':
    case 'segment': {
      const text = String(raw);
      if (typeof field.minLength === 'number' && text.length < field.minLength) {
        errors.push({ path, message: `${field.label}至少 ${field.minLength} 个字符` });
      }
      if (typeof field.maxLength === 'number' && text.length > field.maxLength) {
        errors.push({ path, message: `${field.label}最多 ${field.maxLength} 个字符` });
      }
      if (typeof field.pattern === 'string') {
        const compiled = compilePattern(field.pattern);
        if (!compiled.ok) warnings.push({ path, message: `${field.label}的 pattern 无法编译，已忽略该规则` });
        else if (!compiled.regex.test(text)) errors.push({ path, message: `${field.label}格式不正确` });
      }
      if (Array.isArray(field.enumValues) && field.enumValues.length && raw !== null
        && !field.enumValues.includes(raw)) {
        errors.push({ path, message: `${field.label}不在可选范围内` });
      }
      return;
    }
    case 'number': {
      const num = toNumber(raw);
      if (!Number.isFinite(num)) {
        errors.push({ path, message: `${field.label}需要填写数字` });
        return;
      }
      if ((field.integer === true || field.type === 'integer') && !Number.isInteger(num)) {
        errors.push({ path, message: `${field.label}需要填写整数` });
        return;
      }
      if (typeof field.minimum === 'number' && num < field.minimum) {
        errors.push({ path, message: `${field.label}不能小于 ${field.minimum}` });
      }
      if (typeof field.maximum === 'number' && num > field.maximum) {
        errors.push({ path, message: `${field.label}不能大于 ${field.maximum}` });
      }
      return;
    }
    case 'switch': {
      const ok = raw === true || raw === false || raw === 'true' || raw === 'false' || raw === 1 || raw === 0;
      if (!ok) errors.push({ path, message: `${field.label}需要选择是或否` });
      return;
    }
    case 'string-list': {
      if (!Array.isArray(raw)) {
        errors.push({ path, message: `${field.label}需要是列表` });
        return;
      }
      checkCount(field, path, raw.length, errors);
      return;
    }
    case 'key-value': {
      const seen = new Set();
      for (const row of keyValueRows(raw)) {
        const key = String(row?.key ?? '').trim();
        if (!key) continue; // 键为空：忽略该行（§12.4.4）
        if (seen.has(key)) errors.push({ path: `${path}.${key}`, message: `键重复：${key}` });
        seen.add(key);
      }
      return;
    }
    default:
      return;
  }
}

/* ---------------------------------------------------------------- 回填 */

export function collectContent(fields, values) {
  const content = {};
  fillContent(Array.isArray(fields) ? fields : [], isPlainObject(values) ? values : {}, content);
  return content;
}

function fillContent(fields, values, target) {
  for (const field of fields) {
    if (!field || field.kind === 'unsupported') continue;
    const raw = values[field.key];

    if (field.kind === 'object') {
      const child = {};
      fillContent(field.children ?? [], isPlainObject(raw) ? raw : {}, child);
      if (Object.keys(child).length) target[field.key] = child;
      continue;
    }

    if (field.kind === 'object-list') {
      const rows = Array.isArray(raw) ? raw : [];
      const items = [];
      for (const row of rows) {
        const item = {};
        fillContent(field.children ?? [], isPlainObject(row) ? row : {}, item);
        if (Object.keys(item).length) items.push(item); // 空项不发，避免刷出一堆 {}
      }
      if (items.length) target[field.key] = items;
      continue;
    }

    if (isMissing(field, raw)) continue; // 未填的可选字段不出现（§12.4.6）
    const value = outputValue(field, raw);
    if (value !== undefined) target[field.key] = value;
  }
}

function outputValue(field, raw) {
  switch (field.kind) {
    case 'number': {
      const num = toNumber(raw);
      return Number.isFinite(num) ? num : undefined; // 数字保持 number
    }
    case 'switch':
      return toBoolean(raw);
    case 'string-list': {
      const items = (Array.isArray(raw) ? raw : []).map(item => {
        if (field.itemKind === 'number') return toNumber(item);
        if (field.itemKind === 'boolean') return toBoolean(item);
        return String(item ?? '').trim();
      });
      return items.filter(item => item !== '' && !(typeof item === 'number' && !Number.isFinite(item)));
    }
    case 'key-value': {
      const map = {};
      for (const row of keyValueRows(raw)) {
        const key = String(row?.key ?? '').trim();
        if (!key) continue; // 键为空忽略
        map[key] = String(row?.value ?? ''); // 重复键已被校验拦住，这里后写覆盖
      }
      return Object.keys(map).length ? map : undefined;
    }
    default:
      return raw === null ? null : String(raw);
  }
}

export function countMissing(fields, values) {
  return countMissingIn(Array.isArray(fields) ? fields : [], isPlainObject(values) ? values : {});
}

function countMissingIn(fields, values) {
  let total = 0;
  for (const field of fields) {
    if (!field || field.kind === 'unsupported') continue;
    const raw = values[field.key];
    if (field.kind === 'object') {
      total += countMissingIn(field.children ?? [], isPlainObject(raw) ? raw : {});
      continue;
    }
    if (field.kind === 'object-list') {
      const rows = Array.isArray(raw) ? raw : [];
      if (!rows.length) {
        if (field.required) total += 1;
        continue;
      }
      for (const row of rows) total += countMissingIn(field.children ?? [], isPlainObject(row) ? row : {});
      continue;
    }
    if (field.required && isMissing(field, raw)) total += 1;
  }
  return total;
}
