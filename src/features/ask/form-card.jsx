import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  buildFormModel, createFormState, setFieldValue, validateForm, collectContent, countMissing,
} from './schema-form.mjs';
import './form-card.css';

/* 表单卡（elicitation）：把 agent 给的 JSON Schema 渲染成紧凑可填卡片，走
   编辑 → 提交中 → 已提交 三段；提交成功后收成一行摘要（可展开看 JSON），不弹 toast。
   只做渲染与交互：字段归一化 / 校验 / 内容回填全部委托 ./schema-form.mjs（纯逻辑，另有测试）。
   不解析 markdown 与 HTML、不起系统文件选择器；超限或不可解析时整卡降级为「到终端确认」。
   被对话页在「需要用户确认结构化参数」时挂载：<FormCard request={...} onRespond={...} />。 */

const CONTENT_LIMIT = 65536; // §12.4.7：回填内容序列化后 64KB 封顶，超了让用户精简
const BLOCK_KINDS = new Set(['textarea', 'object', 'string-list', 'object-list', 'key-value', 'unsupported']);
// 这些 kind 有唯一的可聚焦控件，可以用 <label for> 直接关联
const LABELABLE_KINDS = new Set(['text', 'textarea', 'number', 'select', 'switch']);
const META_KEYS = new Set(['ok', 'valid', 'errors', 'warnings']);
const EMPTY_MAP = new Map();
const EMPTY_LIST = [];

const textOf = value => String((value && value.message) || value || '').slice(0, 180);
const slug = value => String(value ?? 'field').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isBlank = value => value === undefined || value === null
  || (typeof value === 'string' && value.trim() === '')
  || (Array.isArray(value) && value.length === 0)
  || (isPlainObject(value) && Object.keys(value).length === 0);
const isOn = value => value === true || value === 1 || value === 'true';

function safeCall(task, fallback) {
  try {
    return task();
  } catch {
    return fallback;
  }
}

/* 列宽：switch / number 2 列、segment 按项数 3–4 列、text 3 列、其余整行；行尾再按 6 列贪心补齐 */
function spanOf(field) {
  if (field.kind === 'switch' || field.kind === 'number') return 2;
  if (field.kind === 'segment') return (field.enumValues?.length ?? 0) <= 2 ? 3 : 4;
  if (field.kind === 'select') return 4;
  if (field.kind === 'text') return 3;
  return 6;
}

const capOf = field => (field.kind === 'switch' || field.kind === 'number' ? 4 : 6);

/* 行尾补齐：6 列贪心打包，一行填不满就把该行最后一个字段加宽到行尾，避免右侧留空档 */
function packSpans(fields) {
  const rows = (fields ?? []).map(field => ({ field, span: spanOf(field) }));
  let used = 0;
  let last = -1;
  const fill = index => {
    const room = 6 - used;
    if (index < 0 || room <= 0) return;
    const row = rows[index];
    row.span = Math.min(capOf(row.field), row.span + room);
  };
  rows.forEach((row, index) => {
    if (last >= 0 && used + row.span > 6) {
      fill(last);
      used = 0;
      last = -1;
    }
    used += row.span;
    last = index;
    if (used >= 6) {
      used = 0;
      last = -1;
    }
  });
  fill(last);
  return rows;
}

/* 校验结果 → Map<path, message>。schema-form 给的是 { ok, errors:[], warnings:[] }，
   这里也容一下数组与扁平对象，免得上层被纯逻辑的小改打穿。 */
function toErrorMap(result) {
  const map = new Map();
  const add = (path, message) => {
    if (!path || message === undefined || message === null || message === '' || message === false) return;
    if (!map.has(String(path))) map.set(String(path), String(message));
  };
  const addItem = item => {
    if (!item || typeof item !== 'object') return;
    add(item.path ?? item.field, item.message ?? item.msg);
  };
  if (!result) return map;
  if (Array.isArray(result)) {
    result.forEach(addItem);
    return map;
  }
  if (Array.isArray(result.errors)) {
    result.errors.forEach(addItem);
    return map;
  }
  if (isPlainObject(result)) {
    for (const [key, value] of Object.entries(result)) {
      if (META_KEYS.has(key)) continue;
      if (Array.isArray(value)) add(key, value[0]);
      else if (isPlainObject(value)) add(key, value.message ?? value.msg);
      else add(key, value);
    }
  }
  return map;
}

/* 默认值只用于「使用默认值」按钮：schema-form 有意不预填 default，
   必填字段即使有默认值也必须由用户输入或显式点一下，避免静默替用户做决定。 */
function collectDefaults(schema, prefix = '', out = new Map(), depth = 0) {
  const props = isPlainObject(schema?.properties) ? schema.properties : null;
  if (!props || depth > 5) return out;
  for (const [key, child] of Object.entries(props)) {
    if (!isPlainObject(child)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child.default !== undefined) out.set(path, child.default);
    if (isPlainObject(child.properties)) collectDefaults(child, path, out, depth + 1);
    else if (isPlainObject(child.items)) {
      if (isPlainObject(child.items.properties)) collectDefaults(child.items, `${path}[0]`, out, depth + 1);
      else if (child.items.default !== undefined) out.set(`${path}[0]`, child.items.default);
    }
  }
  return out;
}

const WarnIcon = () => (
  <svg className="fc-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4 3 20h18L12 4Z" />
    <path d="M12 10v4M12 17.4h.01" />
  </svg>
);

const CloseIcon = () => (
  <svg className="fc-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
);

/* ── 各控件：全部受控，值按字段 path 在 FieldGrid 里写回 ───────────────── */

function NumberControl({ id, field, value, describedBy, invalid, onChange }) {
  // 数字框内部保留原始字符串：直接受控于 Number 会把「1.」抹成「1」，光标乱跳
  const [text, setText] = useState(() => (value == null ? '' : String(value)));
  const pushed = useRef(value);
  useEffect(() => {
    if (Object.is(pushed.current, value)) return; // 自己刚写回的值，不回灌文本
    pushed.current = value;
    setText(value == null ? '' : String(value));
  }, [value]);
  const change = raw => {
    setText(raw);
    const trimmed = raw.trim();
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
    const next = Number.isFinite(parsed) ? parsed : null;
    pushed.current = next;
    onChange(next);
  };
  return (
    <>
      <input id={id} className="fc-input" type="number" step={field.integer === true ? 1 : 'any'}
        value={text}
        min={Number.isFinite(field.minimum) ? field.minimum : undefined}
        max={Number.isFinite(field.maximum) ? field.maximum : undefined}
        aria-required={field.required || undefined}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={describedBy}
        onChange={event => change(event.target.value)} />
      {field.unit ? <span className="fc-unit">{field.unit}</span> : null}
    </>
  );
}

function SegmentControl({ id, field, value, labelId, describedBy, onChange }) {
  const options = (field.enumValues ?? []).map(item => String(item));
  const all = field.allowNull ? [null, ...options] : options;
  return (
    <div className="fc-segment" role="radiogroup" aria-labelledby={labelId} aria-describedby={describedBy}>
      {all.map((option, index) => {
        const selected = option === null ? value === null : String(value ?? '') === option;
        return (
          <label className="fc-segment-item" key={`${option ?? 'null'}-${index}`} data-selected={selected || undefined}>
            <input className="fc-sr" type="radio" name={id} value={option ?? ''} checked={selected}
              onChange={() => onChange(option)} />
            <span className="fc-segment-text">{option ?? '（不设置）'}</span>
          </label>
        );
      })}
    </div>
  );
}

function SelectControl({ id, field, value, describedBy, invalid, onChange }) {
  const options = (field.enumValues ?? []).map(item => String(item));
  const current = value == null ? '' : String(value);
  const showEmpty = field.allowNull || current === '' || !options.includes(current);
  return (
    <span className="fc-select-wrap">
      <select id={id} className="fc-select" value={current}
        aria-required={field.required || undefined}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={describedBy}
        onChange={event => onChange(event.target.value === '' ? null : event.target.value)}>
        {showEmpty ? <option value="">{field.allowNull ? '（不设置）' : '请选择'}</option> : null}
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </span>
  );
}

function StringListControl({ field, value, labelId, describedBy, onChange }) {
  const items = Array.isArray(value) ? value.map(item => String(item ?? '')) : [];
  const [draft, setDraft] = useState('');
  const limit = Number.isFinite(field.maxItems) ? field.maxItems : 20;
  const commit = () => {
    const next = draft.trim();
    if (next && !items.includes(next)) onChange([...items, next]);
    setDraft('');
  };
  return (
    <div className="fc-chips" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
      {items.map((item, index) => (
        <span className="fc-chip" key={`${item}-${index}`}>
          <span className="fc-chip-text">{item}</span>
          <button type="button" aria-label={`删除 ${item}`}
            onClick={() => onChange(items.filter((_, position) => position !== index))}>
            <CloseIcon />
          </button>
        </span>
      ))}
      {items.length < limit ? (
        <input className="fc-input fc-chip-input" type="text" value={draft} data-enter="local"
          aria-label={`添加到${field.label}`} placeholder="输入后回车"
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft('');
            }
          }} />
      ) : null}
    </div>
  );
}

const rowsOf = value => (isPlainObject(value) ? Object.entries(value).map(([key, item]) => [key, String(item ?? '')]) : []);

function KeyValueControl({ field, value, labelId, describedBy, onChange }) {
  // 本地保留「空行」：用户点了「添加」还没填键时，值里没有它的位置
  const [rows, setRows] = useState(() => {
    const list = rowsOf(value);
    return list.length ? list : [['', '']];
  });
  const pushed = useRef(value);
  useEffect(() => {
    if (Object.is(pushed.current, value)) return;
    pushed.current = value;
    const list = rowsOf(value);
    setRows(list.length ? list : [['', '']]);
  }, [value]);
  const push = next => {
    setRows(next);
    const out = {};
    for (const [key, item] of next) {
      const name = String(key).trim();
      if (name) out[name] = String(item);
    }
    pushed.current = out;
    onChange(out);
  };
  const limit = 20;
  return (
    <div className="fc-kv" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
      {rows.map((row, index) => (
        <div className="fc-kv-row" key={index}>
          <input className="fc-input" type="text" value={row[0]} placeholder="键" data-enter="local"
            aria-label={`键 ${index + 1}`}
            onChange={event => push(rows.map((item, position) => (position === index ? [event.target.value, item[1]] : item)))} />
          <input className="fc-input" type="text" value={row[1]} placeholder="值" data-enter="local"
            aria-label={`值 ${index + 1}`}
            onChange={event => push(rows.map((item, position) => (position === index ? [item[0], event.target.value] : item)))} />
          <button type="button" className="fc-kv-del" aria-label={`删除第 ${index + 1} 项`}
            onClick={() => push(rows.length > 1 ? rows.filter((_, position) => position !== index) : [['', '']])}>
            <CloseIcon />
          </button>
        </div>
      ))}
      {rows.length < limit ? (
        <button type="button" className="fc-add" onClick={() => push([...rows, ['', '']])}>+ 添加</button>
      ) : null}
    </div>
  );
}

function ObjectListControl({ field, value, errors, defaults, idBase, labelId, describedBy, onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const children = Array.isArray(field.children) ? field.children : EMPTY_LIST;
  const limit = Number.isFinite(field.maxItems) ? field.maxItems : 20;
  const pathFor = (child, index) => String(child.path ?? child.key)
    .replace(`${field.path}[0]`, `${field.path}[${index}]`);
  return (
    <div className="fc-array" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
      {rows.map((row, index) => (
        <div className="fc-array-item" key={index}>
          <div className="fc-array-head">
            <span>第 {index + 1} 项</span>
            <span className="fc-spacer" />
            <button type="button" className="fc-kv-del" aria-label={`删除第 ${index + 1} 项`}
              onClick={() => onChange(rows.filter((_, position) => position !== index))}>
              <CloseIcon />
            </button>
          </div>
          <FieldGrid fields={children} values={row ?? {}} errors={errors} idBase={`${idBase}-i${index}`}
            defaults={defaults} pathOf={child => pathFor(child, index)}
            onFieldChange={(child, next) => onChange(rows.map((item, position) => (
              position === index ? { ...(item ?? {}), [child.key]: next } : item
            )))} />
        </div>
      ))}
      <button type="button" className="fc-add" disabled={rows.length >= limit}
        onClick={() => onChange([...rows, {}])}>+ 添加</button>
    </div>
  );
}

/* ── 字段：标签与控件同排（块级字段标签独占一行） ───────────────────── */

function Field({ field, span, value, errors, defaults, idBase, errorPath, onChange }) {
  const uid = `${idBase}-${slug(field.path || field.key)}`;
  const labelId = `${uid}-label`;
  const errorId = `${uid}-error`;
  const descId = field.description ? `${uid}-desc` : null;
  const error = (errors && errors.get(errorPath ?? field.path)) || '';
  const invalid = Boolean(error);
  const block = BLOCK_KINDS.has(field.kind);
  const labelable = LABELABLE_KINDS.has(field.kind);
  const describedBy = [descId, errorId].filter(Boolean).join(' ');
  const children = Array.isArray(field.children) ? field.children : EMPTY_LIST;
  const requiredMark = field.required ? <span className="fc-req" aria-hidden="true">*</span> : null;
  const fallback = defaults ? defaults.get(field.path) : undefined;
  const showDefault = fallback !== undefined && field.required && isBlank(value);
  const countText = blockCount(field, value);

  const label = labelable ? (
    <label className="fc-label" htmlFor={uid} id={labelId}>{field.label || '未命名'}{requiredMark}</label>
  ) : (
    <span className="fc-label" id={labelId}>{field.label || '未命名'}{requiredMark}</span>
  );

  let control;
  switch (field.kind) {
    case 'switch': {
      const on = isOn(value);
      control = (
        <>
          <button type="button" id={uid} className="fc-switch" role="switch" aria-checked={on}
            aria-labelledby={labelId} aria-describedby={describedBy}
            aria-invalid={invalid ? 'true' : undefined}
            onClick={() => onChange(!on)}>
            <span aria-hidden="true" />
          </button>
          <span className="fc-switch-text" aria-hidden="true">{on ? '是' : '否'}</span>
        </>
      );
      break;
    }
    case 'number':
      control = <NumberControl id={uid} field={field} value={value}
        describedBy={describedBy} invalid={invalid} onChange={onChange} />;
      break;
    case 'segment':
      control = <SegmentControl id={uid} field={field} value={value} labelId={labelId}
        describedBy={describedBy} onChange={onChange} />;
      break;
    case 'select':
      control = <SelectControl id={uid} field={field} value={value} describedBy={describedBy}
        invalid={invalid} onChange={onChange} />;
      break;
    case 'text':
      control = (
        <input id={uid} className="fc-input" type="text" value={value == null ? '' : String(value)}
          maxLength={Number.isFinite(field.maxLength) ? field.maxLength : undefined}
          aria-required={field.required || undefined}
          aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedBy}
          onChange={event => onChange(event.target.value)} />
      );
      break;
    case 'textarea':
      control = (
        <textarea id={uid} className="fc-textarea" rows={2} value={value == null ? '' : String(value)}
          maxLength={Number.isFinite(field.maxLength) ? field.maxLength : undefined}
          aria-required={field.required || undefined}
          aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedBy}
          onChange={event => onChange(event.target.value)} />
      );
      break;
    case 'string-list':
      control = <StringListControl field={field} value={value} labelId={labelId}
        describedBy={describedBy} onChange={onChange} />;
      break;
    case 'key-value':
      control = <KeyValueControl field={field} value={value} labelId={labelId}
        describedBy={describedBy} onChange={onChange} />;
      break;
    case 'object-list':
      control = <ObjectListControl field={field} value={value} errors={errors} defaults={defaults}
        idBase={uid} labelId={labelId} describedBy={describedBy} onChange={onChange} />;
      break;
    case 'object':
      control = (
        <FieldGrid fields={children} values={isPlainObject(value) ? value : {}} errors={errors}
          defaults={defaults} idBase={uid} pathOf={child => child.path}
          onFieldChange={(child, next) => onChange({ ...(isPlainObject(value) ? value : {}), [child.key]: next })} />
      );
      break;
    default:
      control = (
        <div className="fc-banner is-warn" role="status">
          <WarnIcon />
          <span>{field.unsupportedReason || '这个字段暂不支持，请在终端填写。'}</span>
        </div>
      );
  }

  const defaultButton = showDefault ? (
    <button type="button" className="fc-default" title={`默认值：${String(fallback)}`}
      onClick={() => onChange(fallback)}>使用默认值</button>
  ) : null;

  return (
    <div className={`fc-field fc-span-${span}${block ? ' is-block' : ''}`}>
      {block ? (
        countText ? (
          <div className="fc-block-title">{label}<span className="fc-count">{countText}</span></div>
        ) : label
      ) : (
        <div className="fc-field-row">{label}<div className="fc-control">{control}{defaultButton}</div></div>
      )}
      {block ? <div className="fc-control">{control}{defaultButton}</div> : null}
      {field.description ? <div className="fc-desc" id={descId}>{field.description}</div> : null}
      <div className="fc-error" id={errorId} role="alert">{error}</div>
    </div>
  );
}

function blockCount(field, value) {
  if (field.kind === 'string-list' || field.kind === 'object-list') {
    const total = Array.isArray(value) ? value.length : 0;
    return `${total}/${Number.isFinite(field.maxItems) ? field.maxItems : 20}`;
  }
  if (field.kind === 'object') {
    const children = Array.isArray(field.children) ? field.children : EMPTY_LIST;
    const required = children.filter(child => child.required).length;
    return required ? `${required}/${children.length} 必填` : `${children.length} 项`;
  }
  return '';
}

function FieldGrid({ fields, values, errors, defaults, idBase, pathOf, onFieldChange }) {
  if (!fields?.length) return null; // 空对象不该占一整行
  return (
    <div className="fc-grid">
      {packSpans(fields).map(({ field, span }) => (
        <Field key={field.path || field.key} field={field} span={span}
          value={values?.[field.key]} errors={errors} defaults={defaults} idBase={idBase}
          errorPath={pathOf ? pathOf(field) : field.path}
          onChange={next => onFieldChange(field, next)} />
      ))}
    </div>
  );
}

function SummaryCard({ label, content }) {
  const [open, setOpen] = useState(false);
  const hasContent = isPlainObject(content) && Object.keys(content).length > 0;
  const brief = hasContent
    ? Object.entries(content).slice(0, 3).map(([key, value]) => {
      const shown = Array.isArray(value) ? `${value.length} 项` : isPlainObject(value) ? '…' : String(value);
      return `${key}=${shown}`;
    }).join(' · ')
    : '';
  const json = useMemo(() => (open ? safeCall(() => JSON.stringify(content, null, 2), '') : ''), [open, content]);
  return (
    <section className="fc-summary" aria-live="polite">
      <strong>{label}</strong>
      {brief ? <span className="fc-summary-text">{brief}</span> : null}
      <span className="fc-summary-grow" />
      {hasContent ? (
        <button type="button" className="fc-btn fc-btn-ghost" aria-expanded={open}
          onClick={() => setOpen(current => !current)}>{open ? '收起 JSON' : '查看 JSON'}</button>
      ) : null}
      {open && json ? <pre className="fc-summary-json">{json}</pre> : null}
    </section>
  );
}

export function FormCard({ request, onRespond }) {
  const idBase = `fc${useId().replace(/[^\w-]/g, '')}`;
  const schema = request?.schema;
  const model = useMemo(() => safeCall(
    () => buildFormModel(schema ?? {}),
    { kind: 'degraded', fields: [], degradedReason: 'schema 无法解析，请在终端填写', stats: {} },
  ), [schema]);
  const fields = Array.isArray(model?.fields) ? model.fields : EMPTY_LIST;
  const degraded = Boolean(request?.degraded) || model?.kind === 'degraded';
  const defaults = useMemo(() => collectDefaults(schema), [schema]);

  const [state, setState] = useState(() => createFormState(fields));
  const [phase, setPhase] = useState('editing');
  const [errors, setErrors] = useState(EMPTY_MAP);
  const [warnings, setWarnings] = useState(EMPTY_LIST);
  const [banner, setBanner] = useState('');
  const [summary, setSummary] = useState(null);
  const stateRef = useRef(state);
  const cardRef = useRef(null);
  const token = useRef(0);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const next = createFormState(fields);
    stateRef.current = next;
    setState(next);
    setPhase('editing');
    setErrors(EMPTY_MAP);
    setWarnings(EMPTY_LIST);
    setBanner('');
    setSummary(null);
    token.current += 1;
    // 只按 request.id 重置：父级重建 schema 对象时不该抹掉用户已填内容。
    // 依赖列表刻意只放 request?.id（下面已用宽限注释说明），不引入 react-hooks 插件也能读。
  }, [request?.id]);

  const values = isPlainObject(state.values) ? state.values : {};
  const busy = phase === 'submitting';
  const missing = degraded ? 0 : safeCall(() => countMissing(fields, values), 0);
  const oversized = useMemo(() => (degraded ? false : safeCall(
    () => JSON.stringify(collectContent(fields, values)).length > CONTENT_LIMIT,
    false,
  )), [degraded, fields, values]);

  function write(path, value) {
    const next = setFieldValue(stateRef.current, path, value);
    stateRef.current = next;
    setState(next);
    setErrors(current => {
      if (!current.size) return current;
      const copy = new Map(current);
      for (const key of copy.keys()) {
        // 连同子树一起清：改父级后子级的旧报错（jobs[0].name、env.A）不该继续挂着
        if (key === path || key.startsWith(`${path}[`) || key.startsWith(`${path}.`)) copy.delete(key);
      }
      return copy.size === current.size ? current : copy;
    });
    if (banner) setBanner('');
  }

  function settle(label, content, action) {
    token.current += 1; // 终态之后，迟到的提交结果一律作废
    setSummary({ label, content });
    setPhase('submitted');
    onRespond?.(action);
  }

  async function accept() {
    if (phase !== 'editing' || degraded) return;
    const current = stateRef.current;
    const result = safeCall(() => validateForm(fields, current.values), { errors: [], warnings: [] });
    const found = toErrorMap(result);
    setWarnings(Array.isArray(result?.warnings) ? result.warnings : EMPTY_LIST);
    if (found.size) {
      setErrors(found);
      setBanner('提交失败：请检查标红的字段。');
      return;
    }
    const content = safeCall(() => collectContent(fields, current.values), {});
    if (safeCall(() => JSON.stringify(content).length, 0) > CONTENT_LIMIT) {
      setBanner('内容过大，请精简后再提交。');
      return;
    }
    setErrors(EMPTY_MAP);
    setBanner('');
    const run = token.current + 1;
    token.current = run;
    setPhase('submitting');
    try {
      const pending = onRespond?.({ action: 'accept', content });
      if (pending && typeof pending.then === 'function') await pending;
      if (token.current !== run) return; // 提交中被取消：迟到的完成不再改状态
      setSummary({ label: '已提交', content });
      setPhase('submitted');
    } catch (error) {
      if (token.current !== run) return;
      setPhase('editing');
      setBanner(`提交失败：${textOf(error) || '请重试'}`);
    }
  }

  useEffect(() => {
    if (!errors.size) return;
    const first = cardRef.current?.querySelector('[aria-invalid="true"]');
    if (!first) return;
    first.focus?.({ preventScroll: true });
    first.scrollIntoView?.({ block: 'nearest' });
  }, [errors]);

  function onKeyDown(event) {
    if (event.nativeEvent?.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (phase === 'submitting') settle('已取消', null, { action: 'cancel' });
      else if (phase === 'editing') settle('已跳过', null, { action: 'decline' });
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.defaultPrevented) return;
    const target = event.target;
    // 只有单行输入才让 Enter 直接提交：textarea、键值对、胶囊输入保留自己的回车语义
    if (!target || target.tagName !== 'INPUT') return;
    const type = target.getAttribute('type');
    if (type === 'radio' || type === 'checkbox') return;
    if (target.closest('[data-enter="local"]')) return;
    event.preventDefault();
    accept();
  }

  if (phase === 'submitted') {
    return <SummaryCard label={summary?.label ?? '已提交'} content={summary?.content ?? null} />;
  }

  const questionId = `${idBase}-question`;
  const question = request?.question ? String(request.question) : '需要你确认';
  const detail = request?.detail ? String(request.detail) : '';
  const stat = model?.stats && typeof model.stats === 'object'
    ? [Number.isFinite(model.stats.fields) ? `${model.stats.fields} 个字段` : '',
      Number.isFinite(model.stats.depth) ? `嵌套 ${model.stats.depth} 层` : ''].filter(Boolean).join(' · ')
    : '';
  const degradedReason = model?.degradedReason ? String(model.degradedReason) : 'schema 超出表单卡的上限';
  const hint = degraded ? '这张表不适合在这里填'
    : busy ? '正在提交…'
      : oversized ? '内容过大，请精简'
        : missing > 0 ? `还有 ${missing} 项必填` : '已填完 · Enter 提交';

  return (
    <section ref={cardRef} id={idBase} className={`fc-card${degraded ? ' is-degraded' : ''}`}
      role="group" aria-labelledby={questionId} aria-busy={busy ? 'true' : undefined}
      onKeyDown={onKeyDown}>
      <div className="fc-head">
        <span className="fc-badge">{degraded ? '需要你确认 · 已降级' : '需要你确认'}</span>
        <h2 className="fc-question" id={questionId}>{question}</h2>
        {detail ? <p className="fc-detail">{detail}</p> : null}
      </div>

      {degraded ? (
        <>
          <div className="fc-banner is-warn" role="status">
            <WarnIcon />
            <span>{degradedReason}；这个表格无法在这里安全填写{stat ? `（${stat}）` : ''}。</span>
          </div>
          <details className="fc-schema">
            <summary>查看 schema 原文</summary>
            <pre>{safeCall(() => {
              const raw = JSON.stringify(schema ?? {}, null, 2) ?? '';
              return raw.length > 40000 ? `${raw.slice(0, 40000)}\n…（已截断）` : raw;
            }, '无法序列化 schema')}</pre>
          </details>
        </>
      ) : (
        <fieldset className="fc-body" disabled={busy}>
          <legend className="fc-sr">待填字段</legend>
          <FieldGrid fields={fields} values={values} errors={errors} defaults={defaults} idBase={idBase}
            onFieldChange={(field, next) => write(field.path, next)} />
        </fieldset>
      )}

      {banner ? (
        <div className="fc-banner is-error" role="alert"><WarnIcon /><span>{banner}</span></div>
      ) : null}

      {warnings.length && !degraded ? (
        <div className="fc-note">
          {warnings.slice(0, 2).map((item, index) => <span key={index}>{item?.message}</span>)}
        </div>
      ) : null}

      <div className="fc-foot">
        <span className={`fc-hint${(missing > 0 && !busy && !degraded) || oversized ? ' is-warn' : ''}`}>
          {busy ? <span className="fc-spinner" aria-hidden="true" /> : null}
          <span className="fc-hint-text">{hint}</span>
        </span>
        {degraded ? (
          <>
            <button type="button" className="fc-btn"
              onClick={() => settle('已跳过', null, { action: 'decline' })}>跳过</button>
            <button type="button" className="fc-btn"
              onClick={() => settle('已取消', null, { action: 'cancel' })}>取消</button>
            <button type="button" className="fc-btn fc-btn-primary"
              onClick={() => settle('已转终端确认', null, { action: 'decline' })}>在终端确认</button>
          </>
        ) : (
          <>
            <button type="button" className="fc-btn" disabled={busy}
              onClick={() => settle('已跳过', null, { action: 'decline' })}>跳过</button>
            {busy ? (
              <button type="button" className="fc-btn"
                onClick={() => settle('已取消', null, { action: 'cancel' })}>取消</button>
            ) : null}
            <button type="button" className="fc-btn fc-btn-primary" disabled={busy || oversized}
              onClick={accept}>{busy ? '提交中…' : '提交'}</button>
          </>
        )}
      </div>
    </section>
  );
}

export default FormCard;
