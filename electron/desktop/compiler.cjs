'use strict';
// 编译器：把 L0 轨迹（只有元数据）变成 L2 技能草稿。
//
// 全部是确定性规则：去噪声、合并连续键入、按观测到的沉降补 wait、把输入值换成
// {{param}} 占位符（轨迹里本来就没有值，只有 hash + 长度）。
// 只有“起名字/猜意图”这一步可以注入一次便宜模型调用（nameIt），缺省用模板拼，
// 所以没有模型也能产出可用草稿。

const { MAX_STEPS } = require('./procedures.cjs');

const ACTION_OPS = new Set(['invoke', 'click', 'type', 'key', 'press', 'scroll', 'setValue', 'focus', 'toggle', 'select', 'drag']);
const VALUE_OPS = new Set(['type', 'setValue']);
const JITTER_MS = 300;
const SETTLE_MS = 1500;

function clean(value, limit = 60) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function targetOf(entry) {
  // session.act 写的是 {op, locator:{stableKey|path|name|role|rect}}；tools.recentTrace 写的是扁平行。
  // 两种形状都认，嵌套的 locator 优先补进来（扁平字段仍然覆盖它）。
  const source = entry.locator && typeof entry.locator === 'object'
    ? { ...entry.locator, ...entry }
    : entry;
  if (source.stableKey) return { stableKey: String(source.stableKey).slice(0, 120) };
  if (source.path) return { path: String(source.path).slice(0, 200) };
  const name = clean(source.name, 60);
  const role = clean(source.role, 30);
  if (name) return { path: [role, name].filter(Boolean).join('/') };
  if (Array.isArray(source.rect) && source.rect.length >= 4) {
    const [x, y, width, height] = source.rect;
    return { point: [Math.round(x + width / 2), Math.round(y + height / 2)] };
  }
  return null;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return (a.stableKey || a.path || '') === (b.stableKey || b.path || '')
    && Boolean(a.stableKey || a.path);
}

/**
 * 纯函数版：轨迹 → steps 草稿。测试与工具都直接用它。
 * @param {Array<object>} trace
 * @param {{minSteps?:number, maxSteps?:number}} [options]
 */
function stepsFromTrace(trace, { minSteps = 3, maxSteps = MAX_STEPS } = {}) {
  const events = (Array.isArray(trace) ? trace : [])
    .filter(entry => entry && typeof entry === 'object' && entry.ok !== false)
    .filter(entry => ACTION_OPS.has(String(entry.op || '').toLowerCase()))
    .map(entry => ({ ...entry, op: String(entry.op).toLowerCase() }))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  const params = [];
  const steps = [];
  let lastTs = null;

  for (const entry of events) {
    const at = Number(entry.ts) || 0;
    const target = targetOf(entry);
    if (!target && !['key', 'press'].includes(entry.op)) continue;
    const step = { op: entry.op };
    if (target) step.target = target;

    const previous = steps[steps.length - 1];
    // 同一个输入框上的连续键入合并成一步（轨迹不记值，所以没有内容要合并）。
    if (VALUE_OPS.has(step.op) && previous && VALUE_OPS.has(previous.op) && sameTarget(previous.target, target)) {
      previous.merged = (previous.merged || 1) + 1;
      lastTs = at;
      continue;
    }

    // 点击同一目标的抖动/双击误触只留一次。
    if (step.op === 'click' && previous?.op === 'click' && sameTarget(previous.target, target)
      && lastTs !== null && at - lastTs < JITTER_MS * 4) {
      lastTs = at;
      continue;
    }

    if (step.op === 'key' || step.op === 'press') {
      const keys = clean(entry.keys || entry.value || '', 80);
      if (!keys) continue;
      step.keys = keys;
      delete step.target;
    }

    if (VALUE_OPS.has(step.op)) {
      const index = params.length + 1;
      const name = `p${index}`;
      params.push({
        name,
        description: clean([entry.role, entry.name].filter(Boolean).join(' ') || '输入内容', 60),
        ...(entry.valueLength ? { example: '' } : {}),
      });
      step.value = `{{${name}}}`;
    }

    // 与上一步之间有明显沉降 → 补一个稳定等待，重放时不必猜时间。
    if (lastTs !== null && at - lastTs >= SETTLE_MS && step.op !== 'wait') {
      steps.push({ op: 'wait', for: 'stable', ms: Math.min(5000, at - lastTs), optional: true });
    }

    step.ts = at;
    steps.push(step);
    lastTs = at;
    if (steps.length >= maxSteps) break;
  }

  const cleaned = steps
    .slice(0, maxSteps)
    .map(step => {
      const { ts, merged, ...rest } = step;
      return { ...rest, ...(merged ? { note: `合并 ${merged} 次输入` } : {}) };
    });

  return {
    ok: cleaned.length >= Math.max(1, minSteps),
    steps: cleaned,
    params,
    stepCount: cleaned.length,
    minSteps,
  };
}

/** 缺省命名：应用名 + 前几个控件名，够用户在设置页里认出来。 */
function templateTitle({ appKey, steps }) {
  const app = String(appKey || '').split('|')[0].split(/[\\/]/).pop() || '桌面';
  const labels = steps
    .filter(step => step.target?.path && step.target.path.includes('/'))
    .map(step => clean(step.target.path.split('/').pop(), 20))
    .filter(Boolean)
    .slice(0, 3);
  return clean([app, labels.join(' → ') || `${steps.length} 步流程`].filter(Boolean).join(' · '), 80);
}

function intentOf({ steps, params }) {
  const words = new Set();
  for (const step of steps) {
    const name = step.target?.path ? step.target.path.split('/').pop() : '';
    if (name) words.add(clean(name, 20));
  }
  for (const param of params) {
    if (param.description) words.add(clean(param.description, 20));
  }
  return [...words].filter(Boolean).slice(0, 8);
}

/**
 * @param {Array<object>} trace
 * @param {{appKey?:string, title?:string, nameIt?:(ctx:object)=>any, minSteps?:number,
 *          maxSteps?:number, now?:()=>string}} options
 * @returns {Promise<{ok:boolean, code?:string, steps:Array, params:Array, title?:string, intent?:string[]}>}
 */
async function compile(trace, { appKey = '', title = '', nameIt, minSteps = 3, maxSteps = MAX_STEPS, now = () => new Date().toISOString() } = {}) {
  const draft = stepsFromTrace(trace, { minSteps, maxSteps });
  if (!draft.ok) {
    return { ok: false, code: 'too-short', steps: draft.steps, params: draft.params, stepCount: draft.stepCount, minSteps };
  }
  let named = null;
  if (typeof nameIt === 'function') {
    try {
      named = await nameIt({ appKey, steps: draft.steps, params: draft.params, stepCount: draft.stepCount });
    } catch {
      named = null;   // 命名失败不影响草稿：模板标题永远兜底
    }
  }
  const proposal = typeof named === 'string' ? { title: named } : (named && typeof named === 'object' ? named : {});
  return {
    ok: true,
    appKey,
    title: clean(title || proposal.title || templateTitle({ appKey, steps: draft.steps }), 80),
    intent: Array.isArray(proposal.intent) && proposal.intent.length
      ? proposal.intent.map(item => clean(item, 40)).filter(Boolean).slice(0, 12)
      : intentOf(draft),
    params: draft.params,
    steps: draft.steps,
    stepCount: draft.stepCount,
    verify: proposal.verify && typeof proposal.verify === 'object' ? proposal.verify : null,
    source: { compiler: typeof nameIt === 'function' ? 'rules+naming' : 'rules', compiledAt: now() },
  };
}

module.exports = { compile, stepsFromTrace, templateTitle, intentOf, ACTION_OPS, JITTER_MS, SETTLE_MS };
