/**
 * 负责：把技能运行时投影成 pi-ai（进程内 agent 循环）要的 tools[]——
 *   只有 `exposure.piAi === true` 的工具，`{ name, label, description, parameters, execute }`。
 * 不负责：工具实现、参数校验（各 pack 的 handlers 走 electron/skills/input-schema.mjs）、事件（index.mjs 发）、
 *   MCP 通道（adapters/mcp.mjs）；结果预算的取值规则也在 manifest-schema.mjs 的 resultBudgetOf 里。
 * 被谁调用：electron/chat-agent.mjs（runChatAgent 的 tools 组装）、
 *   tests/skills-adapters.test.mjs 走 fake runtime。
 *
 * 结果预算：`execute` 出口再按 `resultBudgetOf(def)` 归一一次。index.mjs 的 invoke 已经按同一份预算截过，
 * 所以这里是幂等的；写在这里是为了「两条链路的出口各自守同一份预算」——
 * 少写这一行，将来谁把截断从 invoke 挪走，pi-ai 这条链路就会静默变成不设上限。
 *
 * 瘦适配层：不缓存、不改写 schema、不猜默认值——错了就是 manifest 写错，改 manifest。
 */

import { normalizeResult } from '../../mcp/normalize.mjs';
import { resultBudgetOf } from '../manifest-schema.mjs';

/**
 * @param {{ listEntries: () => Array<{ def: object }>, invoke: Function }} runtime
 * @param {{ onTiming?: (sample: { name: string, callId: string, transport: string,
 *   durationMs: number, ok: boolean }) => void }} [options]
 * @returns {Array<{ name: string, label: string, description: string, parameters: object,
 *   execute: (callId: string, input: object, signal?: AbortSignal) => Promise<object> }>}
 */
export function toPiAiTools(runtime, { onTiming } = {}) {
  const entries = typeof runtime?.listEntries === 'function' ? runtime.listEntries() : [];
  const report = typeof onTiming === 'function' ? onTiming : null;
  return entries
    .filter(entry => entry?.def?.exposure?.piAi === true)
    .map(entry => {
      const def = entry.def;
      return {
        name: def.name,
        label: def.label,
        description: def.description,
        parameters: def.inputSchema,
        async execute(callId, input, toolSignal) {
          const startedAt = Date.now();
          let ok = false;
          try {
            const raw = await runtime.invoke(def.name, input ?? {}, {
              callId,
              transport: 'pi-ai',
              signal: toolSignal,
            });
            const result = normalizeResult(raw, { maxTextChars: resultBudgetOf(def) });
            ok = result?.isError !== true;
            return result;
          } finally {
            if (report) {
              // 计时回调是诊断用的旁路：它抛错不能把工具调用变成失败。
              try {
                report({ name: def.name, callId, transport: 'pi-ai', durationMs: Date.now() - startedAt, ok });
              } catch { /* 诊断旁路失败忽略 */ }
            }
          }
        },
      };
    });
}
