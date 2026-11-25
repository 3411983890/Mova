/**
 * 负责：把云项目的只读 GitHub 工具转成两种 API 模型的工具调用格式。
 * 不负责：联网下载、执行脚本或管理项目。
 * 被谁调用：cloud-worker.mjs。
 */
import { fail } from './cloud-store.mjs';

const schema = { type: 'object', properties: {}, additionalProperties: false };
const TOOL_OUTPUT_LIMIT = 12_000;

export function buildProjectApiTools(tools = [], anthropic = false) {
  const registry = new Map(tools.map(tool => ['project_' + tool.name, tool]));
  const definitions = [...registry].map(([name, tool]) => {
    const description = tool.description;
    return anthropic ? { name, description, input_schema: schema }
      : { type: 'function', function: { name, description, parameters: schema } };
  });
  function output(name, args) {
    const tool = registry.get(name);
    if (!tool) return { error: '工具未在当前云项目中启用' };
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return { error: '此只读工具无需参数' };
    return { source: tool.source, path: tool.path, content: tool.content.slice(0, TOOL_OUTPUT_LIMIT), truncated: tool.content.length > TOOL_OUTPUT_LIMIT };
  }
  function batch(items, getId) {
    if (!items.length) return false;
    if (items.length > 4 || items.some(item => typeof getId(item) !== 'string' || !getId(item))) {
      throw fail('invalid_tool_calls', 'API 模型返回的云工具调用超限或格式无效', 502);
    }
    return true;
  }
  return {
    definitions,
    continueWith(data, messages) {
      if (!definitions.length) return false;
      if (anthropic) {
        const blocks = Array.isArray(data?.content) ? data.content : [];
        const calls = blocks.filter(block => block?.type === 'tool_use');
        if (!batch(calls, call => call.id)) return false;
        messages.push({ role: 'assistant', content: blocks });
        messages.push({ role: 'user', content: calls.map(call => {
          const result = output(call.name, call.input);
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) };
        }) });
        return true;
      }
      const message = data?.choices?.[0]?.message;
      const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      if (!batch(calls, call => call?.id)) return false;
      messages.push({ ...message, role: 'assistant' });
      for (const call of calls) {
        let args;
        try { args = JSON.parse(call.function?.arguments); } catch { /* tool reports invalid arguments */ }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output(call.function?.name, args)) });
      }
      return true;
    },
  };
}
