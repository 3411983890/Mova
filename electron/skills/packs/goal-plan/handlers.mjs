/**
 * 负责：把 `electron/goal-state.mjs` 的状态机、`electron/ask.cjs` 的提问通道与
 *   `electron/approvals.cjs` 的审批通道包成 6 个技能 handler——参数校验、状态变更、
 *   通过 `ctx.emit` 发 `{type:'goal'}` / `{type:'plan'}` 事件、把回答交回模型。
 * 不负责：目标/计划的状态语义（goal-state.mjs 的 createGoalState）、弹条渲染与超时
 *   （ask.cjs / approvals.cjs）、前端状态卡渲染（app.js 的 applyAimEvent）。
 * 被谁调用：electron/skills/index.mjs 经 registry 调 invoke；tests/skills-pack-handlers.test.mjs。
 *
 * 关键修复：状态从 `deps.aim` 继承（旧 buildMovaHandlers 每轮都新建空对象，导致目标卡
 * 在下一轮丢失）。`deps.aim` 缺失时按「没有历史目标」处理，工具照常可用。
 *
 * 可选依赖键（缺哪个就少哪个工具，绝不抛）：
 *   aim        —— 上一轮结束时的 { goal, plan } 快照（app.js 的 goalSnapshot 在没有目标时为 null）
 *   asks       —— createAskBroker() 的实例，签名 ask(sender, input, signal) => string
 *   approvals  —— createApprovalBroker() 的实例，签名 ask(sender, request, signal) => 'deny'|'once'|'session'
 *   sender     —— Electron WebContents；ask / request_approval 必须它才能上屏
 *   emit       —— 没有 ctx.emit 时的兜底事件通道
 */

import { createGoalState } from '../../../goal-state.mjs';
import { errorResult, messageOf, textResult } from '../../../mcp/normalize.mjs';

/** 与 manifest 的 schema、goal-state.mjs 的截断上限保持一致。 */
const MAX_TITLE = 120;
const MAX_DETAIL = 400;
const MAX_SUMMARY = 300;
const MAX_NOTE = 200;
const MAX_STEPS = 12;
const MAX_STEP_LABEL = 120;
const MAX_STEP_META = 120;
const MAX_QUESTION = 400;
const MAX_OPTION = 60;
const MAX_OPTIONS = 4;
const MAX_ACTION = 300;
const MAX_APPROVAL_DETAIL = 2_000;
const STEP_STATUSES = ['pending', 'active', 'done'];
const GOAL_STATUSES = ['active', 'paused', 'done', 'blocked'];

function invalid(message) {
  return errorResult('invalid_arguments', message);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function emitOf(deps, ctx) {
  if (typeof ctx?.emit === 'function') return ctx.emit;
  if (typeof deps?.emit === 'function') return deps.emit;
  return null;
}

function push(deps, ctx, event) {
  const emit = emitOf(deps, ctx);
  if (!emit) return;
  try {
    emit(event);
  } catch { /* 状态事件发不出去不该让工具失败：模型仍需要拿到结果 */ }
}

/** 目标/计划的步骤列表校验：整表替换语义，所以只挑必要字段，多余字段丢掉。 */
function checkSteps(raw) {
  if (!Array.isArray(raw)) return { ok: false, message: 'steps 必须是数组' };
  if (raw.length < 1) return { ok: false, message: 'steps 至少 1 项' };
  if (raw.length > MAX_STEPS) return { ok: false, message: `steps 最多 ${MAX_STEPS} 项（当前 ${raw.length}）` };
  const steps = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `steps[${index}] 必须是对象` };
    }
    if (!nonEmpty(item.label)) return { ok: false, message: `steps[${index}].label 必填且不能为空` };
    if (item.label.length > MAX_STEP_LABEL) {
      return { ok: false, message: `steps[${index}].label 超过 ${MAX_STEP_LABEL} 字符上限` };
    }
    if (item.status !== undefined && !STEP_STATUSES.includes(item.status)) {
      return { ok: false, message: `steps[${index}].status 只能是 ${STEP_STATUSES.join(' / ')}` };
    }
    if (item.meta !== undefined) {
      if (typeof item.meta !== 'string') return { ok: false, message: `steps[${index}].meta 必须是字符串` };
      if (item.meta.length > MAX_STEP_META) {
        return { ok: false, message: `steps[${index}].meta 超过 ${MAX_STEP_META} 字符上限` };
      }
    }
    steps.push({
      label: item.label,
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(item.meta === undefined ? {} : { meta: item.meta }),
    });
  }
  return { ok: true, steps };
}

/** 两种选项形状归一：字符串数组（MCP）与 {label,value,description} 对象数组（旧 pi-ai）。 */
function checkOptions(args) {
  const options = [];
  if (args.options !== undefined) {
    if (!Array.isArray(args.options)) return { ok: false, message: 'options 必须是字符串数组' };
    if (args.options.length > MAX_OPTIONS) return { ok: false, message: `options 最多 ${MAX_OPTIONS} 项` };
    for (let index = 0; index < args.options.length; index += 1) {
      const label = args.options[index];
      if (!nonEmpty(label)) return { ok: false, message: `options[${index}] 不能为空` };
      if (typeof label !== 'string' || label.length > MAX_OPTION) {
        return { ok: false, message: `options[${index}] 超过 ${MAX_OPTION} 字符上限` };
      }
      options.push({ label, value: label });
    }
  }
  if (args.choices !== undefined) {
    if (!Array.isArray(args.choices)) return { ok: false, message: 'choices 必须是对象数组' };
    if (args.choices.length > MAX_OPTIONS) return { ok: false, message: `choices 最多 ${MAX_OPTIONS} 项` };
    for (let index = 0; index < args.choices.length; index += 1) {
      const item = args.choices[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, message: `choices[${index}] 必须是对象` };
      }
      if (!nonEmpty(item.label)) return { ok: false, message: `choices[${index}].label 必填` };
      if (item.label.length > MAX_OPTION) {
        return { ok: false, message: `choices[${index}].label 超过 ${MAX_OPTION} 字符上限` };
      }
      if (item.value !== undefined && typeof item.value !== 'string') {
        return { ok: false, message: `choices[${index}].value 必须是字符串` };
      }
      if (item.description !== undefined && typeof item.description !== 'string') {
        return { ok: false, message: `choices[${index}].description 必须是字符串` };
      }
      options.push({
        label: item.label,
        value: nonEmpty(item.value) ? item.value : item.label,
        ...(nonEmpty(item.description) ? { description: item.description.slice(0, MAX_OPTION) } : {}),
      });
    }
  }
  if (options.length > MAX_OPTIONS) return { ok: false, message: `选项合计最多 ${MAX_OPTIONS} 个` };
  return { ok: true, options };
}

/**
 * @param {{ aim?: object|null, asks?: object, approvals?: object, sender?: object, emit?: Function }} [deps]
 * @returns {Record<string, (args: object, ctx: object) => Promise<object>>}
 */
export function createHandlers(deps = {}) {
  // 状态只在这里建一次：createHandlers 的生命周期 = 一个 turn 的 SkillRuntime。
  const state = createGoalState(deps?.aim ?? null);

  const handlers = {
    async set_goal(rawArgs, ctx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      if (!nonEmpty(args.title)) return invalid('title 必填且不能为空');
      if (args.title.length > MAX_TITLE) return invalid(`title 超过 ${MAX_TITLE} 字符上限（当前 ${args.title.length}）`);
      if (args.detail !== undefined) {
        if (typeof args.detail !== 'string') return invalid('detail 必须是字符串');
        if (args.detail.length > MAX_DETAIL) return invalid(`detail 超过 ${MAX_DETAIL} 字符上限（当前 ${args.detail.length}）`);
      }
      try {
        const result = state.setGoal({ title: args.title, detail: args.detail ?? '' });
        if (!result.ok) return errorResult('invalid_arguments', result.error);
        push(deps, ctx, { type: 'goal', goal: result.goal });
        return textResult(`已设置目标：${result.goal.title}。调用 accept_goal 才算接受；在那之前不会自动推进。`);
      } catch (error) {
        return errorResult('tool_failed', messageOf(error));
      }
    },

    async set_plan(rawArgs, ctx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const checked = checkSteps(args.steps);
      if (!checked.ok) return invalid(checked.message);
      try {
        const result = state.setPlan({ steps: checked.steps });
        if (!result.ok) return errorResult('invalid_arguments', result.error);
        const steps = result.steps;
        push(deps, ctx, { type: 'plan', plan: steps.length ? { steps } : null });
        const done = steps.filter(step => step.status === 'done').length;
        return textResult(`已更新计划：${done}/${steps.length} 步完成。`);
      } catch (error) {
        return errorResult('tool_failed', messageOf(error));
      }
    },

    async accept_goal(rawArgs, ctx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      if (args.note !== undefined) {
        if (typeof args.note !== 'string') return invalid('note 必须是字符串');
        if (args.note.length > MAX_NOTE) return invalid(`note 超过 ${MAX_NOTE} 字符上限（当前 ${args.note.length}）`);
      }
      try {
        const result = state.accept({ note: args.note });
        if (!result.ok) return errorResult('invalid_arguments', result.error);
        push(deps, ctx, { type: 'goal', goal: result.goal });
        return textResult('已接受目标。本轮结束后，只要目标仍是 active 且已被接受，应用会自动开始下一轮。');
      } catch (error) {
        return errorResult('tool_failed', messageOf(error));
      }
    },

    async update_goal(rawArgs, ctx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      if (!GOAL_STATUSES.includes(args.status)) {
        return invalid(`status 只能是 ${GOAL_STATUSES.join(' / ')}（idle 不可写入）`);
      }
      if (args.summary !== undefined) {
        if (typeof args.summary !== 'string') return invalid('summary 必须是字符串');
        if (args.summary.length > MAX_SUMMARY) {
          return invalid(`summary 超过 ${MAX_SUMMARY} 字符上限（当前 ${args.summary.length}）`);
        }
      }
      try {
        const result = state.updateStatus({ status: args.status, summary: args.summary });
        if (!result.ok) return errorResult('invalid_arguments', result.error);
        push(deps, ctx, { type: 'goal', goal: result.goal });
        const status = result.goal.status;
        const tail = status === 'done'
          ? '自动推进已停止，用户看到目标已完成。'
          : status === 'blocked'
            ? '自动推进已停止，用户看到你报告的阻塞原因。'
            : status === 'paused'
              ? '自动推进已停止，等用户恢复目标。'
              : '自动推进已重新待命。';
        return textResult(`目标状态：${status}。${tail}`);
      } catch (error) {
        return errorResult('tool_failed', messageOf(error));
      }
    },
  };

  const sender = deps?.sender;
  const asks = deps?.asks;
  const approvals = deps?.approvals;

  // 提问必须有「谁看得到」和「谁答得回」：缺一个就不暴露这个工具（绝不返回一个假回答）。
  if (asks && typeof asks.ask === 'function' && sender) {
    handlers.ask_user = async function askUser(rawArgs, ctx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      if (!nonEmpty(args.question)) return invalid('question 必填且不能为空');
      if (args.question.length > MAX_QUESTION) {
        return invalid(`question 超过 ${MAX_QUESTION} 字符上限（当前 ${args.question.length}）`);
      }
      if (args.detail !== undefined) {
        if (typeof args.detail !== 'string') return invalid('detail 必须是字符串');
        if (args.detail.length > MAX_DETAIL) return invalid(`detail 超过 ${MAX_DETAIL} 字符上限（当前 ${args.detail.length}）`);
      }
      const checked = checkOptions(args);
      if (!checked.ok) return invalid(checked.message);
      try {
        const answer = await asks.ask(sender, {
          question: args.question,
          ...(nonEmpty(args.detail) ? { detail: args.detail } : {}),
          options: checked.options,
          multi: false,
          allowCustom: true,
        }, ctx?.signal);
        const text = typeof answer === 'string' ? answer.trim() : '';
        return textResult(text || '用户跳过了这个问题。');
      } catch (error) {
        return errorResult('tool_failed', `提问失败：${messageOf(error)}`);
      }
    };
  }

  // 审批请求只在真的有人工审批通道时暴露；回答不授予能力位（见 tool description）。
  if (approvals && typeof approvals.ask === 'function' && sender) {
    handlers.request_approval = async function requestApproval(rawArgs, ctx) {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      if (!nonEmpty(args.action)) return invalid('action 必填且不能为空');
      if (args.action.length > MAX_ACTION) {
        return invalid(`action 超过 ${MAX_ACTION} 字符上限（当前 ${args.action.length}）`);
      }
      if (!nonEmpty(args.detail)) return invalid('detail 必填且不能为空');
      if (args.detail.length > MAX_APPROVAL_DETAIL) {
        return invalid(`detail 超过 ${MAX_APPROVAL_DETAIL} 字符上限（当前 ${args.detail.length}）`);
      }
      try {
        const decision = await approvals.ask(sender, {
          capability: 'exec',
          allowSession: false,
          message: args.action,
          detail: args.detail,
        }, ctx?.signal);
        const denied = decision === 'deny' || decision === false || decision === undefined;
        return textResult(denied
          ? '用户拒绝了这次动作。'
          : `用户已批准（${String(decision)}）。这只是人工确认，文件与系统能力仍需各自通过权限检查。`);
      } catch (error) {
        return errorResult('tool_failed', `请求审批失败：${messageOf(error)}`);
      }
    };
  }

  return handlers;
}
