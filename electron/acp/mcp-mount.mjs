/**
 * 负责：判断「要不要把 Mova 的工具挂到这个 CLI 上」，以及识别「这次反向审批是不是自家 MCP 工具」。
 * 不负责：真正的 HTTP MCP server 生命周期（electron/mcp/server.mjs）、会话装配（chat-agent.mjs）、
 *   反向审批的实际放行逻辑（electron/acp/gate.mjs）。
 * 被谁调用：electron/chat-agent.mjs（mcpServers 钩子）、electron/acp/gate.mjs（request_permission 短路）、
 *   tests/acp-mount.test.mjs。
 *
 * 为什么单独一个纯函数模块：这条判据错一次就是「整条工具链静默消失」，必须有单测盯着。
 *
 * 实测事实（scripts/probes/probe-agy-mcp.mjs，agy 1.5.8）：
 *   `initialize` 的 `agentCapabilities` 里**根本没有 `mcpCapabilities` 字段**，
 *   但 `agy` 收到 `session/new` 的 `mcpServers` 后会完整走
 *   server/discover → initialize → notifications/initialized → tools/list → tools/call → session/request_permission。
 * 所以判据必须是「明确说不支持才跳过」，不能要求它先声明支持。
 */

/** 自家 MCP server 的名字（`session/new` 的 `mcpServers[].name`）。 */
export const MOVA_MCP_SERVER_NAME = 'mova-tools';

/** `agy` 把工具名写成 `mcp_<server>_<tool>`：`mcp_mova-tools_mova_browser_navigate`。 */
const MOVA_MCP_TOOL = /^mcp_mova[-_]tools[_-]/i;

/**
 * 要不要挂 Mova 的 HTTP MCP？
 * - 对面显式 `mcpCapabilities.http === false` → 不挂（尊重对方的拒绝）。
 * - 没声明（`agy` 就是这种）或声明 true → 挂。挂不上 session/new 会报错，比「静默没有工具」好排查。
 * @param {object|null|undefined} agentCapabilities
 * @returns {boolean}
 */
export function shouldMountMcp(agentCapabilities) {
  const http = agentCapabilities?.mcpCapabilities?.http;
  return http !== false;
}

/**
 * 这次 `session/request_permission` 是不是针对 Mova 自己的 MCP 工具。
 * 是的话反向闸门不再问人：权限已经由技能层 approval-bridge 判过，重复问就是两张卡。
 * @param {string} name
 * @returns {boolean}
 */
export function isMovaMcpTool(name) {
  return typeof name === 'string' && MOVA_MCP_TOOL.test(name);
}
