'use strict';

function selectHistorySource(turns, messageId, mode) {
  const anchor = turns.findIndex(turn => turn.some(message => message.messageId === messageId));
  if (anchor < 0) return null;
  if (mode === 'message') return turns[anchor].filter(message => message.messageId === messageId).slice(0, 1);
  if (mode === 'around') return turns.slice(Math.max(0, anchor - 2), anchor + 3).flat();
  return turns.flat();
}

module.exports = { selectHistorySource };
