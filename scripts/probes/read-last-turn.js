// 读回最后一轮：用户那条附件 chip + 助手回复（用于确认附件内容真的进了上下文）。
const turns = [...document.querySelectorAll('.user-turn')];
const last = turns[turns.length - 1];
const replies = [...document.querySelectorAll('.assistant-reply')];
const lastReply = replies[replies.length - 1];
return {
  turns: turns.length,
  userFiles: last ? [...last.querySelectorAll('.user-file-name')].map(node => node.textContent) : [],
  userText: last ? (last.querySelector('.user-message')?.innerText || '').trim().slice(0, 60) : '',
  reply: (lastReply?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
};
