'use strict';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function changesBetween(before, after) {
  const previousFields = new Map((before.fields || []).map(field => [field.key || field.label, field]));
  const currentFields = new Map((after.fields || []).map(field => [field.key || field.label, field]));
  const fields = [];
  for (const key of new Set([...previousFields.keys(), ...currentFields.keys()])) {
    const previous = previousFields.get(key);
    const current = currentFields.get(key);
    if (!equal(previous?.value, current?.value)) {
      fields.push({ key, label: current?.label || previous?.label, before: previous?.value ?? null, after: current?.value ?? null });
    }
  }
  return {
    fields,
    prices: equal(before.prices, after.prices) ? null : { before: before.prices, after: after.prices },
    statuses: equal(before.statuses, after.statuses) ? null : { before: before.statuses, after: after.statuses },
  };
}

function projectPlan(before, steps, fixture) {
  const fields = (before.fields || []).map(field => ({ ...field }));
  let recorded = false;
  for (const step of steps) {
    if (step.requiresHandoff) break;
    if (fixture && step.action === 'click' && step.elementId === 'save') recorded = true;
    if (!['select', 'fill', 'type', 'check'].includes(step.action)) continue;
    let field = fields.find(item => (item.key || item.label) === (step.fieldKey || step.label));
    if (!field) {
      field = { key: step.fieldKey || step.label, label: step.label, value: '' };
      fields.push(field);
    }
    if (step.action === 'select') field.value = step.displayValue;
    else if (step.action === 'check') field.value = step.value !== 'false';
    else if (step.action === 'type') field.value = String(field.value ?? '') + String(step.value ?? '').slice(0, 5000);
    else field.value = String(step.value ?? '').slice(0, 5000);
  }
  let prices = null;
  let statuses = null;
  if (fixture) {
    const plan = fields.find(field => field.key === 'id:plan');
    const quantity = fields.find(field => field.key === 'id:quantity');
    const rate = { '10M': 10, '20M': 20 }[plan?.value];
    const amount = Number(quantity?.value);
    if (rate && Number.isFinite(amount)) prices = [`总价 ￥${rate * amount}`];
    const otherStatuses = (before.statuses || []).filter(status => !/^总价|^等待操作$|^已记录测试$/.test(status));
    const status = recorded ? ['已记录测试'] : (before.statuses || []).filter(text => /^(等待操作|已记录测试)$/.test(text));
    statuses = [...(prices || []), ...status, ...otherStatuses];
  }
  const projected = {
    phase: 'projected', fields, prices, statuses,
    priceStatus: prices ? 'projected' : 'unknown-until-page-updates',
    requiresHandoff: steps.some(step => step.requiresHandoff),
  };
  const changes = changesBetween(before, projected);
  projected.changes = { fields: changes.fields, prices: prices ? changes.prices : null, statuses: statuses ? changes.statuses : null };
  return projected;
}

function diffObserved(before, after) {
  const changes = changesBetween(before.summary, after.summary);
  const beforeLines = new Set(String(before.snapshot?.text || '').split('\n'));
  const afterLines = new Set(String(after.snapshot?.text || '').split('\n'));
  const lines = changes.fields.map(field => `${field.label}：${field.before ?? '∅'} → ${field.after ?? '∅'}`);
  if (changes.prices) lines.push(`价格：${(changes.prices.before || []).join(' / ')} → ${(changes.prices.after || []).join(' / ')}`);
  if (changes.statuses) lines.push(`状态：${(changes.statuses.before || []).join(' / ')} → ${(changes.statuses.after || []).join(' / ')}`);
  for (const line of beforeLines) if (line && !afterLines.has(line)) lines.push('- ' + line);
  for (const line of afterLines) if (line && !beforeLines.has(line)) lines.push('+ ' + line);
  return { changes, snapshot: { mode: 'diff', changed: lines.length > 0, text: lines.join('\n').slice(0, 16_000) } };
}

module.exports = { projectPlan, diffObserved };
