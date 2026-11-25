'use strict';
// 桌面技能 → 长期记忆的索引卡（与 browser/memory-mirror.cjs 同构）。
// 完整步骤仍然留在 procedures.json；记忆库只放一条短、可检索的卡片，
// 这样记忆面板/检索/跨会话召回里能看到“Mova 会做这件事”，也能跟着记忆一起备份。

function clean(value, limit = 80) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

const OP_LABEL = {
  click: '点击', invoke: '调用', type: '输入', setValue: '填写', key: '按键',
  press: '按键', scroll: '滚动', drag: '拖拽', focus: '聚焦', wait: '等待',
  toggle: '切换', select: '选择', launch: '打开', activate: '切到', close: '关闭',
};

function stepLabel(step) {
  const op = String((step && (step.op || step.action)) || '').toLowerCase();
  const label = OP_LABEL[op] || op || '动作';
  const target = step && step.target && typeof step.target === 'object'
    ? (step.target.path || step.target.stableKey || '')
    : (step && step.target) || '';
  const name = clean(String(target).split('/').pop(), 24);
  return name && name.length <= 24 && !/^#\d+$/.test(name) ? `${label}「${name}」` : label;
}

function summaryOf(procedure) {
  const steps = (procedure.steps || []).slice(0, 12).map(stepLabel);
  const ok = Number(procedure.stats && procedure.stats.ok) || 0;
  const fail = Number(procedure.stats && procedure.stats.fail) || 0;
  const app = clean(procedure.appKey, 80);
  return [
    `[桌面技能] ${app} · ${clean(procedure.title, 80)}`,
    Array.isArray(procedure.intent) && procedure.intent.length ? `适用：${procedure.intent.join('、')}` : '',
    `步骤：${steps.join(' → ')}`,
    `成功率：${ok}/${ok + fail}`,
  ].filter(Boolean).join('\n').slice(0, 2000);
}

function createDesktopMemoryMirror({ getMemory } = {}) {
  async function mirror(procedure) {
    const memory = typeof getMemory === 'function' ? getMemory() : getMemory;
    if (!memory || typeof memory.saveMemory !== 'function' || !procedure || !procedure.id) return null;
    try {
      return await memory.saveMemory({
        text: summaryOf(procedure),
        kind: 'note',
        key: `desktop.procedure.${procedure.id}`,
        source: 'automatic',
      });
    } catch {
      return null;
    }
  }
  return { mirror, summaryOf };
}

module.exports = { createDesktopMemoryMirror, summaryOf, stepLabel };
