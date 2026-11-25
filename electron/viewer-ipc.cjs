'use strict';
// IPC for the right-side viewer.
//
// Two independent surfaces live here:
//   1. files:*    read-only directory listing / file reading, always scoped to a
//                 granted project root (the renderer only ever names rootId+path).
//   2. browser:inspect:*  start/stop the in-page selection or element picker;
//                 the page reports back through the browser controller.
//
// main.cjs stays a wiring file: it creates the singletons and calls this once.

const { createFilesView } = require('./files-view.cjs');

function installViewerIpc({ ipcMain, permissions, shell, browser, senderWindow }) {
  if (!ipcMain || !permissions || !browser || typeof senderWindow !== 'function') {
    throw new TypeError('installViewerIpc needs ipcMain, permissions, browser and senderWindow');
  }
  const files = createFilesView({ permissions, shell });

  // Same envelope as every other renderer-facing handler: { ok, value } or
  // { ok:false, error, message }. Errors never leak absolute paths.
  const handle = (channel, run) => ipcMain.handle(channel, async (event, input) => {
    try {
      senderWindow(event);
      return { ok: true, value: await run(input || {}) };
    } catch (error) {
      return { ok: false, error: error?.code || 'failed', message: error?.message || '操作失败' };
    }
  });

  handle('files:view:list', input => files.list(input));
  handle('files:view:stat', input => files.stat(input));
  handle('files:view:read', input => files.read(input));
  handle('files:open-dir', input => files.openDir(input));
  // 归属判定：模型给的绝对路径 → 它落在哪个已登记根里（渲染层据此在右侧面板打开）。
  handle('files:view:locate', input => files.locate(input));
  // 外部打开：用系统默认程序打开文件（等同在文件管理器里双击），Ctrl/⌘+点击走这里。
  handle('files:view:open-external', input => files.openFile(input));

  handle('browser:inspect:start', input => browser.inspectStart(input));
  handle('browser:inspect:stop', () => browser.inspectStop());
}

module.exports = { installViewerIpc };
