// Which project folders a single model request may touch.
//
// Normal presets keep the old scope: CodeMova sees the current project's
// folders, ChatMova sees none. The `full` preset is the user's explicit
// "完全访问权限": every folder the user has registered (and granted read /
// write / exec to) is in scope, across projects. Commands are already
// unrestricted once exec is granted; this helper only widens the file tools.

/**
 * @param {{
 *   permissionPreset?: string,
 *   permissionRoots?: Array<{ id?: string, capabilities?: Record<string, boolean> }>,
 *   mode?: string,
 *   project?: { sourceFolders?: Array<{ id?: string }> } | null,
 * }} input
 * @returns {string[]}
 */
export function rootIdsForRequest({ permissionPreset, permissionRoots = [], mode, project = null } = {}) {
  const roots = Array.isArray(permissionRoots) ? permissionRoots : [];
  const ids = roots.map(root => root?.id).filter(id => typeof id === 'string' && id);
  if (permissionPreset === 'full') return [...new Set(ids)];
  if (mode !== 'CodeMova') return [];
  const folders = Array.isArray(project?.sourceFolders) ? project.sourceFolders : [];
  return [...new Set(folders
    .map(folder => folder?.id)
    .filter(id => typeof id === 'string' && id && ids.includes(id)))];
}
