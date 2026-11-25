'use strict';

const { isIP } = require('node:net');

// 与 electron/anysearch.cjs 原有的 sourceUrl 完全一致（原样搬移）。
// 所有对外 URL（搜索结果、正文读取、SearXNG 地址）都必须先过这里：
// 只允许 http/https、不允许凭据、不允许 IP / 单段主机 / 内网后缀。
// 改动这里等于改动安全边界，需同时确认 electron/anysearch.cjs 的旧路径行为不变。
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const link = URL.parse(value);
  if (!link || !['http:', 'https:'].includes(link.protocol) || link.username || link.password) return null;
  const host = link.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || isIP(host) || /\.(localhost|local|internal|lan|home)$/.test(host)) return null;
  return link;
}

module.exports = { sourceUrl };
