'use strict';

function conversationFromSessionKey(key) {
  if (typeof key !== 'string') return null;
  try {
    const [conversationId] = JSON.parse(key.slice(key.indexOf(':') + 1));
    return typeof conversationId === 'string' ? conversationId : null;
  } catch { return null; }
}

// Notifications never focus a window until the user clicks them.
function installInteractionNotifications({ ipcMain, Notification, authorize }) {
  const pending = new Map();
  const watching = new Set();
  function dismiss(senderId, id) {
    const key = `${senderId}:${id}`;
    const notification = pending.get(key);
    pending.delete(key);
    notification?.close();
  }
  ipcMain.handle('interaction:notify', (event, input) => {
    const win = authorize(event);
    if (!input || typeof input.id !== 'string' || input.id.length > 200 ||
      typeof input.conversationId !== 'string' || input.conversationId.length > 800) return false;
    if (!Notification.isSupported()) return false;
    const key = `${event.sender.id}:${input.id}`;
    if (pending.has(key)) return true;
    if (!watching.has(event.sender.id)) {
      const senderId = event.sender.id;
      watching.add(senderId);
      event.sender.once('destroyed', () => {
        watching.delete(senderId);
        for (const id of [...pending.keys()]) if (id.startsWith(`${senderId}:`)) {
          pending.get(id)?.close(); pending.delete(id);
        }
      });
    }
    const notification = new Notification({ title: 'Mova 需要你回复', body: input.kind === 'ask' ? '有一个聊天正在等你回答，点击前往。' : '有一个聊天正在等你审批，点击前往。' });
    pending.set(key, notification);
    notification.on('click', () => {
      if (pending.get(key) !== notification || win.isDestroyed() || event.sender.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      event.sender.send('interaction:open', input.conversationId);
      dismiss(event.sender.id, input.id);
    });
    notification.on('failed', () => { if (pending.get(key) === notification) pending.delete(key); });
    notification.show();
    return true;
  });
  ipcMain.handle('interaction:dismiss', (event, id) => {
    authorize(event);
    if (typeof id === 'string') dismiss(event.sender.id, id);
    return true;
  });
}

module.exports = { installInteractionNotifications, conversationFromSessionKey };
