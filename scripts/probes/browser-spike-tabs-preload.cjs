const { contextBridge, ipcRenderer } = require('electron');
console.log('tab preload loaded');

contextBridge.exposeInMainWorld('tabs', {
  onNew(callback) {
    console.log('tab preload onNew registered');
    ipcRenderer.on('browser:tab:new', (_event, payload) => {
      console.log('tab preload new', JSON.stringify(payload));
      callback(payload || {});
    });
  },
  onSelect(callback) { ipcRenderer.on('browser:tab:select', (_event, payload) => callback(payload || {})); },
  onClose(callback) { ipcRenderer.on('browser:tab:close', (_event, payload) => callback(payload || {})); },
  ready(tabId, guestId, spaceId) { ipcRenderer.send('browser:tab:ready', { tabId, guestId, spaceId }); },
  active(tabId, spaceId) { ipcRenderer.send('browser:tab:active', { tabId, spaceId }); },
  closed(tabId) { ipcRenderer.send('browser:tab:closed', { tabId }); },
});
