/**
 * 负责：验证云项目配置、读取 Linux 配置的 API 档案，并从 GitHub 导入固定提交的工具。
 * 不负责：保存密钥、执行下载的代码或注册 MCP 传输。
 * 被谁调用：cloud-api、cloud-worker 和云项目测试。
 */
import { createHash } from 'node:crypto';
import { fail, text } from './cloud-store.mjs';
import { CLOUD_TASK_PROVIDERS } from '../../src/services/cloud-connection.mjs';
const SLUG = /^[a-z][a-z0-9_-]{0,47}$/;
const PROFILE = /^[a-z][a-z0-9_]{0,31}$/;
const ASSET_LIMIT = 32 * 1024;
const cleanPath = value => typeof value === 'string' && value.length <= 260 &&
  value.split('/').every(part => part !== '.' && part !== '..' && /^[a-zA-Z0-9_.-]+$/.test(part));

function invalid(message) { throw fail('project_input', message); }

export function projectId(value) {
  if (typeof value !== 'string' || !SLUG.test(value)) invalid('项目标识须以小写字母开头，仅含小写字母、数字、短横线或下划线');
  return value;
}

export function readApiProfile(env, id = 'default') {
  if (typeof id !== 'string' || !PROFILE.test(id)) return null;
  const prefix = id === 'default' ? 'MOVA_API_' : 'MOVA_API_PROFILE_' + id.toUpperCase() + '_';
  const url = env[prefix + 'BASE_URL'];
  const key = env[prefix + 'KEY'];
  const protocol = env[prefix + 'PROTOCOL'];
  const model = env[prefix + 'MODEL'] || '';
  if (!url || !key || (protocol && !['openai', 'anthropic'].includes(protocol))) return null;
  let base;
  try { base = new URL(url); } catch { return null; }
  if (base.username || base.password || base.search || base.hash) return null;
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) return null;
  return { base, key, model, protocol: protocol || 'openai' };
}

export function apiProfiles(env) {
  const ids = ['default'];
  for (const name of Object.keys(env)) {
    const match = /^MOVA_API_PROFILE_([A-Z][A-Z0-9_]{0,31})_BASE_URL$/.exec(name);
    if (match && match[1] !== 'DEFAULT') ids.push(match[1].toLowerCase());
  }
  return ids.flatMap(id => {
    const profile = readApiProfile(env, id);
    return profile ? [{ id, model: profile.model || null, protocol: profile.protocol }] : [];
  });
}

export function projectPatch(input, env) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) invalid('请读取项目后提交当前 revision，创建项目时填 0');
  const patch = {};
  if (input.name !== undefined) patch.name = text(input.name, '项目名称', 80);
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string') invalid('instructions 须为文本');
    patch.instructions = text(input.instructions, '项目指令', 4000, true);
  }
  if (input.provider !== undefined) {
    if (!CLOUD_TASK_PROVIDERS.includes(input.provider)) invalid('云端模型通道无效');
    patch.provider = input.provider;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string') invalid('model 须为文本');
    patch.model = text(input.model, '模型', 200, true);
  }
  if (input.apiProfile !== undefined) {
    if (typeof input.apiProfile !== 'string' || !PROFILE.test(input.apiProfile) || !readApiProfile(env, input.apiProfile)) invalid('API 档案未在 Linux 主机配置');
    patch.apiProfile = input.apiProfile;
  }
  if (!Object.keys(patch).length) invalid('请至少指定一个要修改的字段');
  return { revision: input.revision, patch };
}

export function githubToolSource(input) {
  const repo = typeof input.repository === 'string' ? input.repository.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/.test(repo)) invalid('请填写公开 GitHub 仓库 owner/repo');
  const commit = typeof input.commit === 'string' ? input.commit.toLowerCase() : '';
  if (!/^[a-f0-9]{40}$/.test(commit)) invalid('请填写完整的 40 位 GitHub 提交 SHA');
  if (input.filePath !== undefined) {
    if (input.manifestPath !== undefined || !cleanPath(input.filePath) || typeof input.toolName !== 'string' || !SLUG.test(input.toolName)) {
      invalid('直接导入需提供仓库内的文件路径和工具名称');
    }
    return { repository: repo, commit, filePath: input.filePath };
  }
  const path = input.manifestPath ?? 'mova-tool.json';
  if (!cleanPath(path) || !path.endsWith('.json')) invalid('工具清单须是仓库内的 JSON 文件');
  return { repository: repo, commit, manifestPath: path };
}

async function readGithubFile(source, path, limit, fetchImpl, signal) {
  const url = 'https://raw.githubusercontent.com/' + source.repository + '/' + source.commit + '/' + path;
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error', headers: { accept: 'text/plain, application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    });
  } catch { throw fail('tool_download', '无法连接 GitHub 源文件服务，请检查 Linux 网络', 502); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw fail('tool_download', 'GitHub 文件不可访问（HTTP ' + response.status + '）', 502);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw fail('tool_size', 'GitHub 文件超出允许大小', 413);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error.code === 'tool_size') throw error;
    throw fail('tool_download', 'GitHub 文件下载中断，请检查 Linux 网络', 502);
  }
  const content = Buffer.concat(chunks).toString('utf8');
  if (/[\u0000\uFFFD]/.test(content)) invalid('GitHub 工具文件须为 UTF-8 文本');
  return content;
}

export async function importGithubTool(input, { fetchImpl = fetch, signal } = {}) {
  const source = githubToolSource(input);
  let manifest;
  if (source.filePath) {
    manifest = { schemaVersion: 1, kind: 'github_file', name: input.toolName, file: source.filePath,
      description: input.description ?? '读取 ' + source.repository + ' 中固定提交的 ' + source.filePath };
  } else {
    const raw = await readGithubFile(source, source.manifestPath, 8192, fetchImpl, signal);
    try { manifest = JSON.parse(raw); } catch { invalid('GitHub 工具清单不是有效的 JSON'); }
  }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'github_file' || typeof manifest.name !== 'string' || !SLUG.test(manifest.name)
    || !cleanPath(manifest.file)) invalid('清单须声明 schemaVersion: 1、kind: github_file、工具名称和仓库文本文件路径');
  const description = text(manifest.description, '工具说明', 300);
  const content = await readGithubFile(source, manifest.file, ASSET_LIMIT, fetchImpl, signal);
  return { name: manifest.name, description, kind: manifest.kind, source, path: manifest.file, content,
    sha256: createHash('sha256').update(content).digest('hex') };
}

