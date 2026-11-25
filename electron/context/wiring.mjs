/**
 * 上下文台账的接线层（把纯逻辑内核接进一次真实请求）。
 *
 * 负责：按环境变量决定「关 / 只上报 / 上报+二次压缩」，并把结果收敛成永远不抛的形态。
 * 不负责：估算与压缩算法本身（在 budget/ledger/digest 里）。
 * 被谁调用：electron/chat-agent.mjs 的 runChatAgent，在 buildContextHistory 之后、prepareMessages 之前。
 *
 * 为什么默认关闭：本仓 `src/features/chat/context-budget.mjs` 已经有一套字符预算 + 摘录压缩，
 * 直接叠加会双重压缩且改变既有行为。所以这里做成显式开关：
 *   MOVA_CONTEXT_LEDGER=off     完全不介入（默认，行为与改造前一致）
 *   MOVA_CONTEXT_LEDGER=report  只上报真实口径，不改历史（替换渲染端那段死代码的计算，见方案 §5 P0-6）
 *   MOVA_CONTEXT_LEDGER=ledger  上报 + 当仍超过硬阈值时做一次台账压缩
 *
 * 角色约定：摘要以 `user` 消息注入，与本仓既有的「Earlier conversation excerpts」一致；
 * 不在这里判断 provider——按方案 §4.2，消息角色映射由 pi-ai 适配层负责。
 */
import { createBudget } from './budget.mjs';
import { createLedger } from './ledger.mjs';

/** 允许的模式；任何未知值一律按 off 处理，避免环境变量写错就改变行为。 */
const MODES = new Set(['off', 'report', 'ledger']);
/** 注入摘要消息的前缀：既有的摘录注入也带方括号标记，便于用户与模型识别。 */
const SUMMARY_PREFIX = '[上下文摘要]';

export function contextLedgerMode(env = process.env) {
  const raw = String(env?.MOVA_CONTEXT_LEDGER ?? '').trim().toLowerCase();
  return MODES.has(raw) ? raw : 'off';
}

/** ledger 需要 `{role, text}`；历史里可能带 images 等字段，这里只取正文并保证是字符串。 */
function toLedgerMessages(messages) {
  return messages.map((message, index) => ({
    id: `m${index + 1}`,
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    text: typeof message?.text === 'string' ? message.text : '',
  }));
}

/**
 * 把台账接进一次请求。
 * `summarize`（可选）是调用方已造好的摘要器（例如 `createLlmSummarizer` 的产物）；不传就由
 * ledger 自己回退确定性摘要，输出与改造前逐字节一致。
 * @returns {object} 原 `portable`，或在 ledger 模式下压缩后的新对象；**任何异常都退回原值**。
 */
export async function applyContextLedger({ portable, model, emit, env = process.env, now = Date.now, summarize = null } = {}) {
  const mode = contextLedgerMode(env);
  if (mode === 'off') return portable;
  try {
    const messages = Array.isArray(portable?.messages) ? portable.messages : [];
    if (messages.length === 0) return portable;

    const ledger = createLedger({ layers: { L1: '', L2: '', L3: '' }, messages: toLedgerMessages(messages), tools: [] });
    const before = ledger.stats();

    let nextMessages = messages;
    let compaction = null;

    if (mode === 'ledger') {
      const contextWindow = Number(model?.contextWindow) || 0;
      const reserveOutput = Number(model?.maxTokens) || 0;
      if (contextWindow > 0) {
        const budget = createBudget({ contextWindow, reserveOutput });
        // 硬阈值才动历史：既有的字符预算已经把常规情况压好了，这里只处理「还是太大」的极端情况。
        if (budget.level(before.total.tokens) === 'overflow') {
          // 有摘要器就用它（LLM 精修）；它自己负责「失败/超时回退 deterministicDigest」。
          // 本函数是异步的，所以 LLM 摘要真的能拿到正文——这正是它比同步版本多的那一步。
          const result = await ledger.compact({ now, summarize });
          if (result?.compacted) {
            nextMessages = spliceSummary(messages, result);
            compaction = {
              covered: result.coveredMessages.length,
              source: result.source,
              before: result.record?.tokens?.before ?? before.total.tokens,
              after: result.record?.tokens?.after ?? null,
            };
          }
        }
      }
    }

    if (typeof emit === 'function') {
      const after = compaction ? estimateAfter(nextMessages) : before.total.tokens;
      emit({
        type: 'context',
        report: {
          mode,
          // 明确标注这是本地估算：方案 §8.4 要求 estimated 与 actual 永不混列。
          estimated: true,
          messages: { sent: nextMessages.length, total: messages.length },
          tokens: { before: before.total.tokens, after },
          layers: before.layers.map(layer => ({ id: layer.id, name: layer.name, tokens: layer.tokens })),
          compaction,
        },
      });
    }
    return nextMessages === messages ? portable : { ...portable, messages: nextMessages };
  } catch {
    // 观测/压缩都不该影响一次正常对话：出错就当没开。
    return portable;
  }
}

/** 把被压缩的区间换成一條摘要消息，插回原位置，保持其余消息顺序不变。 */
function spliceSummary(messages, result) {
  const covered = new Set(result.coveredMessages ?? []);
  const kept = [];
  let inserted = false;
  messages.forEach((message, index) => {
    const id = `m${index + 1}`;
    if (!covered.has(id)) {
      kept.push(message);
      return;
    }
    if (inserted) return;
    kept.push({ role: 'user', text: `${SUMMARY_PREFIX} ${String(result.summaryBlock ?? '').trim()}` });
    inserted = true;
  });
  if (!inserted) kept.unshift({ role: 'user', text: `${SUMMARY_PREFIX} ${String(result.summaryBlock ?? '').trim()}` });
  return kept;
}

/** 压缩后的粗估：只用于上报，不参与任何阈值判断。 */
function estimateAfter(messages) {
  let chars = 0;
  for (const message of messages) chars += String(message?.text ?? '').length;
  return Math.ceil(chars / 3);
}
