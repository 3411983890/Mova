/**
 * 负责：`electron/acp/mcp-mount.mjs` 的两个判据 —— 「要不要挂 MCP」与「是不是自家 MCP 工具」。
 * 不负责：真实的 MCP server 生命周期、反向审批放行逻辑。
 * 被谁调用：`node --test`。
 *
 * 为什么值得单独测：第一条判据错一次，Gemini 侧所有 Mova 工具会**静默消失**
 * （用户只会看到模型说「我没有浏览器工具」）；第二条错一次，每个工具动作会弹两张审批卡。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MOVA_MCP_SERVER_NAME, isMovaMcpTool, shouldMountMcp } from '../electron/acp/mcp-mount.mjs';

test('agy 1.5.8 实测：没声明 mcpCapabilities 也要挂 MCP', () => {
  // 真实 initialize 返回的形状（截取相关字段）：没有 mcpCapabilities。
  const real = {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { resume: {}, close: {} },
    auth: { logout: {} },
  };
  assert.equal(shouldMountMcp(real), true, '没声明 = 尝试挂（实测 agy 会连）');
  assert.equal(shouldMountMcp(null), true, '连 capabilities 都拿不到时也尝试挂');
  assert.equal(shouldMountMcp({}), true);
  assert.equal(shouldMountMcp({ mcpCapabilities: {} }), true, '声明了对象但没写 http');
  assert.equal(shouldMountMcp({ mcpCapabilities: { http: true } }), true);
  assert.equal(shouldMountMcp({ mcpCapabilities: { http: false } }), false, '只有明确 false 才跳过');
});

test('自家 MCP 工具识别：mcp_mova-tools_ 前缀（含下划线变体）', () => {
  assert.equal(MOVA_MCP_SERVER_NAME, 'mova-tools');
  // agy 实测写出来的形状。
  assert.equal(isMovaMcpTool('mcp_mova-tools_mova_browser_navigate'), true);
  assert.equal(isMovaMcpTool('mcp_mova_tools_mova_read_file'), true);
  assert.equal(isMovaMcpTool('mcp_mova-tools_mova_probe_ping'), true);
  // 别的 MCP server 的工具不该被短路（仍要走人工审批）。
  assert.equal(isMovaMcpTool('mcp_other-server_some_tool'), false);
  assert.equal(isMovaMcpTool('mova_browser_navigate'), false, '不带 mcp_ 前缀的不是 CLI 侧工具名');
  assert.equal(isMovaMcpTool(''), false);
  assert.equal(isMovaMcpTool(undefined), false);
  assert.equal(isMovaMcpTool(123), false);
});
