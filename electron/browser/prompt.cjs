'use strict';
// 浏览器提示词里的「能力句」：只从本轮真实工具枚举生成。
// 不负责拼完整提示（各面的固定前半段仍在 chat-agent.mjs），也不读磁盘 / 网络，纯函数。
// 被 electron/chat-agent.mjs 的 systemPrompt 与 tests/browser-prompt-contract.test.mjs 调用。
// 为什么这么拆：提示手写 for= 值会和扩展真实能力脱节（Edge 没有 download / time），
// 枚举一变提示自动跟随，才不会让模型反复尝试一个不存在的等待条件。

function waitConditions(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const enumerated = list.find(tool => tool?.name === 'browser_wait')
    ?.parameters?.properties?.for?.enum;
  if (!Array.isArray(enumerated)) return [];
  return [...new Set(enumerated.filter(value => typeof value === 'string' && value.trim()))];
}

function capabilitySentence(tools) {
  const conditions = waitConditions(tools);
  if (!conditions.length) return '';
  return `wait conditions available here: ${conditions.join(', ')}.`;
}

// Edge 扩展确实没有 download 等待条件（Downloads require manual control），
// 与其假装支持，不如把「做不到」和替代路径写清楚。
function edgeUnavailableNote() {
  return 'Edge cannot wait for downloads: this extension has no download wait condition, so never wait for a file to arrive. Use browser_read on the download page, or ask the user to download the file manually.';
}

module.exports = { capabilitySentence, edgeUnavailableNote };
