// Reproduce the CodeMova new-chat state (project strip above the composer).
const modeButton = [...document.querySelectorAll('[data-mode]')].find(b => b.dataset.mode === 'CodeMova');
modeButton?.click();
document.querySelector('#new-chat')?.click();
await new Promise(r => setTimeout(r, 400));
const strip = document.querySelector('#composer-context');
return {
  mode: document.querySelector('#mode-label')?.textContent,
  stripVisible: !!strip && !strip.hidden,
  stripRadius: strip ? getComputedStyle(strip).borderRadius : null,
};
