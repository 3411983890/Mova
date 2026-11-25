'use strict';
// Optional bridge from site skills into the long-term memory store. The full
// steps stay in procedures.json; memory only gets a short, searchable index card.

function clean(value, limit = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function summaryOf(procedure) {
  const steps = (procedure.steps || []).slice(0, 12).map(step => {
    if (step.op === 'navigate') return '打开页面';
    if (step.op === 'click') return '点击';
    if (step.op === 'fill' || step.op === 'type') return '填写';
    if (step.op === 'select') return '选择';
    if (step.op === 'wait') return '等待';
    return step.op || '动作';
  });
  return [
    `[站点技能] ${clean(procedure.origin, 80)}${clean(procedure.pathPattern, 80)} · ${clean(procedure.title, 80)}`,
    procedure.intent?.length ? `适用：${procedure.intent.join('、')}` : '',
    `步骤：${steps.join(' → ')}`,
    procedure.verify ? `验证：${clean(procedure.verify.value || procedure.verify.selector || '', 100)}` : '',
    `成功率：${procedure.stats?.ok || 0}/${(procedure.stats?.ok || 0) + (procedure.stats?.fail || 0)}`,
  ].filter(Boolean).join('\n').slice(0, 2000);
}

function createMemoryMirror({ getMemory } = {}) {
  async function mirror(procedure) {
    const memory = typeof getMemory === 'function' ? getMemory() : getMemory;
    if (!memory || typeof memory.saveMemory !== 'function' || !procedure?.id) return null;
    try {
      return await memory.saveMemory({
        text: summaryOf(procedure),
        kind: 'note',
        key: `browser.procedure.${procedure.id}`,
        source: 'automatic',
      });
    } catch {
      return null;
    }
  }
  return { mirror, summaryOf };
}

module.exports = { createMemoryMirror, summaryOf };
