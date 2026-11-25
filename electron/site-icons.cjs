const { net } = require('electron');
const { isIP } = require('node:net');

const MAX_BYTES = 96 * 1024;
const TIMEOUT_MS = 6_000;
const SUCCESS_TTL = 6 * 60 * 60 * 1000;
const FAILURE_TTL = 10 * 60 * 1000;
const MAX_ENTRIES = 240;
const cache = new Map();

/**
 * Only public, dot-qualified hostnames are worth a request; the search sources
 * already went through anysearch.cjs, so this is a second safety net.
 */
function validHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
  if (isIP(host) || /\.(localhost|local|internal|lan|home)$/.test(host)) return null;
  return host;
}

function imageMime(bytes) {
  if (bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && (bytes[2] === 0x01 || bytes[2] === 0x02)) return 'image/x-icon';
  return null;
}

async function download(url) {
  let response;
  try {
    response = await net.fetch(url, {
      redirect: 'follow',
      headers: { accept: 'image/avif,image/webp,image/png,image/x-icon,image/*;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const type = response.headers.get('content-type') ?? '';
  if (type && !type.startsWith('image/')) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        void response.body.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    return null;
  }
  const bytes = Buffer.concat(chunks);
  const mime = imageMime(bytes);
  return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
}

function remember(host, value) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(host, { value, at: Date.now() });
}

/** Resolves a site favicon to a `data:` URL, or null when the site has none we can use. */
async function siteIcon(host) {
  const name = validHost(host);
  if (!name) return null;
  const hit = cache.get(name);
  if (hit) {
    const ttl = hit.value ? SUCCESS_TTL : FAILURE_TTL;
    if (Date.now() - hit.at < ttl) return hit.value;
    cache.delete(name);
  }
  const candidates = [
    `https://${name}/favicon.ico`,
    `https://${name}/apple-touch-icon.png`,
    name.startsWith('www.') ? null : `https://www.${name}/favicon.ico`,
  ].filter(Boolean);
  let value = null;
  for (const url of candidates) {
    value = await download(url);
    if (value) break;
  }
  remember(name, value);
  return value;
}

module.exports = { siteIcon, validHost };
