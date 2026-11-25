const { createHash } = require('node:crypto');
const { basename, isAbsolute, resolve } = require('node:path');

// Only metadata from the trusted native picker is returned. No directory reads
// and no renderer-supplied paths belong in this IPC handler. Picked folders are
// registered as permission roots with every capability off: registering a
// folder is not the same as granting the model access to it.
function installProjectsIpc(authorize, { ipcMain, dialog, registerRoots } = {}) {
  ipcMain.handle('projects:pick-folders', async event => {
    const win = authorize(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择项目文件夹',
      buttonLabel: '选择文件夹',
      properties: ['openDirectory', 'multiSelections'],
    });
    // A picker can remain open while its renderer navigates or is destroyed.
    // Recheck the existing app/frame boundary before disclosing native paths.
    authorize(event);
    if (result.canceled) return [];

    const seen = new Set();
    const folders = result.filePaths.map(folder => {
      if (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0')) {
        throw new Error('Native folder picker returned an invalid absolute path');
      }
      const path = resolve(folder);
      const identity = process.platform === 'win32' ? path.toLowerCase() : path;
      if (seen.has(identity)) return null;
      seen.add(identity);
      return {
        id: `project-${createHash('sha256').update(identity).digest('hex')}`,
        name: basename(path) || path,
        path,
      };
    }).filter(Boolean);
    if (folders.length && typeof registerRoots === 'function') await registerRoots(folders, win);
    return folders;
  });
}

module.exports = { installProjectsIpc };
