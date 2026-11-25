/**
 * 本机 Fxy（FlClash）配置扫描与导入器。
 *
 * 负责：定位 `%APPDATA%\com.Speed17\fxy\profiles\*.yaml` 并用 Clash YAML 解析器
 * 提取其中全部合法节点（包括 Vless 与 Mieru）。
 * 不负责：写死用户凭据到日志或 UI 返回值；所有测试均可注入虚拟目录与 fs。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { VpnError, sanitizeNodeView } from './contract.mjs';
import { dedupeNodes, normalizeProxyRecord, parseClashYaml } from './parser.mjs';

/** 解析 Fxy profiles 目录路径（优先显式注入，其次 APPDATA，再其次 env）。 */
export function resolveFxyProfilesDir({ appDataDir, env = process.env } = {}) {
  const base = typeof appDataDir === 'string' && appDataDir.trim()
    ? appDataDir.trim()
    : (typeof env.APPDATA === 'string' && env.APPDATA.trim() ? env.APPDATA.trim() : '');
  if (!base) return '';
  return join(base, 'com.Speed17', 'fxy', 'profiles');
}

/** 从单份 Fxy YAML 文件读取并提取节点与策略组摘要。 */
export async function readFxyProfileFile(filePath, {
  sourceId,
  sourceLabel,
  readFileImpl = readFile,
} = {}) {
  const content = await readFileImpl(filePath, 'utf8');
  const { proxies, groups } = parseClashYaml(content);
  const label = sourceLabel || basename(filePath, extname(filePath));
  const id = sourceId || `fxy:${basename(filePath)}`;
  const nodes = dedupeNodes(
    proxies
      .map(raw => normalizeProxyRecord(raw, { sourceId: id, sourceLabel: `Fxy · ${label}` }))
      .filter(Boolean),
  );
  const protocols = [...new Set(nodes.map(node => node.type))];
  return {
    id,
    name: label,
    fileName: basename(filePath),
    nodeCount: nodes.length,
    protocols,
    groupNames: groups.map(g => String(g?.name || '')).filter(Boolean).slice(0, 16),
    nodes,
  };
}

/**
 * 扫描本机 Fxy 配置目录，返回脱敏摘要列表（绝不返回明文密钥/UUID）。
 * 如果目录不存在或没有 YAML 文件，返回 `{ found: false, profiles: [] }`。
 */
export async function scanFxyProfiles({
  appDataDir,
  env = process.env,
  readdirImpl = readdir,
  readFileImpl = readFile,
  statImpl = stat,
} = {}) {
  const profilesDir = resolveFxyProfilesDir({ appDataDir, env });
  if (!profilesDir) return { found: false, profilesDir: '', profiles: [] };

  let entries;
  try {
    const info = await statImpl(profilesDir);
    if (!info?.isDirectory?.()) return { found: false, profilesDir, profiles: [] };
    entries = await readdirImpl(profilesDir, { withFileTypes: true });
  } catch {
    return { found: false, profilesDir, profiles: [] };
  }

  const yamlFiles = (Array.isArray(entries) ? entries : [])
    .filter(entry => {
      const name = typeof entry === 'string' ? entry : entry?.name;
      const isFile = typeof entry === 'string' ? true : entry?.isFile?.();
      return isFile && /\.(ya?ml)$/i.test(String(name || ''));
    })
    .map(entry => (typeof entry === 'string' ? entry : entry.name));

  const profiles = [];
  for (const fileName of yamlFiles) {
    const fullPath = join(profilesDir, fileName);
    try {
      const parsed = await readFxyProfileFile(fullPath, { readFileImpl });
      if (parsed.nodeCount === 0) continue;
      let mtimeMs = 0;
      try { mtimeMs = Number((await statImpl(fullPath))?.mtimeMs || 0); } catch { /* ignore */ }
      profiles.push({
        id: parsed.id,
        name: parsed.name,
        fileName: parsed.fileName,
        nodeCount: parsed.nodeCount,
        protocols: parsed.protocols,
        updatedAt: mtimeMs,
        previewNodes: parsed.nodes.slice(0, 6).map(node => sanitizeNodeView(node)),
      });
    } catch {
      // 单份损坏的配置不应阻断其余 Fxy 配置文件扫描
    }
  }
  profiles.sort((a, b) => b.updatedAt - a.updatedAt);
  return { found: profiles.length > 0, profilesDir, profiles };
}

/** 导入指定（或全部）Fxy 配置文件，返回完整待加密落盘节点与订阅源元信息。 */
export async function loadFxyImport({
  profileId,
  appDataDir,
  env = process.env,
  readdirImpl = readdir,
  readFileImpl = readFile,
  statImpl = stat,
} = {}) {
  const scanned = await scanFxyProfiles({ appDataDir, env, readdirImpl, readFileImpl, statImpl });
  if (!scanned.found || !scanned.profiles.length) {
    throw new VpnError('fxy_not_found');
  }
  const targets = profileId
    ? scanned.profiles.filter(item => item.id === profileId || item.fileName === profileId)
    : scanned.profiles;
  if (!targets.length) throw new VpnError('not_found');

  const results = [];
  for (const target of targets) {
    const fullPath = join(scanned.profilesDir, target.fileName);
    const parsed = await readFxyProfileFile(fullPath, {
      sourceId: target.id,
      sourceLabel: `Fxy · ${target.name}`,
      readFileImpl,
    });
    results.push({
      subscription: {
        id: parsed.id,
        kind: 'fxy',
        name: `Fxy · ${parsed.name}`,
        url: '',
        updatedAt: Date.now(),
        nodeCount: parsed.nodes.length,
        usage: null,
        lastError: '',
      },
      nodes: parsed.nodes,
    });
  }
  return results;
}
