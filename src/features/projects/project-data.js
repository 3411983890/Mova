// Serializable project metadata. Folder contents and browser File objects are never stored here.
import { parseCloudOrigin } from '../../services/cloud-connection.mjs';
export function normalizeSourceFolders(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(folder => {
    if (!folder || typeof folder.name !== 'string' || !folder.name.trim()) return [];
    const name = folder.name.trim();
    const path = typeof folder.path === 'string' && folder.path ? folder.path : null;
    const key = path ? path.replaceAll('\\', '/').replace(/\/$/, '').toLocaleLowerCase() : `browser:${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: typeof folder.id === 'string' ? folder.id : key, name, path, kind: path ? 'desktop' : 'browser' }];
  });
}

export function normalizeInstructions(value) {
  return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
}

export function readProjectDraft(form) {
  let folders;
  try { folders = JSON.parse(form.dataset.sourceFolders || '[]'); } catch { folders = []; }
  return {
    sourceFolders: normalizeSourceFolders(folders),
    memory: form.dataset.memory === 'project' ? 'project' : 'default',
    instructions: normalizeInstructions(form.querySelector?.('#project-instructions')?.value),
    ...(form.dataset.cloudOrigin ? { cloudOrigin: form.dataset.cloudOrigin, cloudLabel: form.dataset.cloudLabel } : {}),
  };
}

export function createProjectRecord(name, draft = {}) {
  const cloudOrigin = draft.cloudOrigin ? parseCloudOrigin(draft.cloudOrigin) : null;
  const sourceFolders = cloudOrigin ? [] : normalizeSourceFolders(draft.sourceFolders);
  const resolvedName = String(name || '').trim() || sourceFolders[0]?.name || '';
  if (!resolvedName) throw new Error('请输入项目名称或选择源文件夹');
  if (resolvedName.length > 60) throw new Error('项目名称不能超过 60 个字符，请手动设置名称');
  return {
    name: resolvedName, chats: [], sourceFolders,
    memory: draft.memory === 'project' ? 'project' : 'default',
    instructions: normalizeInstructions(draft.instructions), device: cloudOrigin ? 'cloud' : 'local',
    ...(cloudOrigin ? { cloudOrigin, cloudLabel: String(draft.cloudLabel || '').trim().slice(0, 60) || new globalThis.URL(cloudOrigin).host } : {}),
  };
}
