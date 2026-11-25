// 临时探针：给微信发全局快捷键 Ctrl+Alt+W，看主窗口能否唤出（最终会删掉）
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const keybd_event = user32.func('void keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
const VK_CONTROL = 0x11;
const VK_MENU = 0x12; // Alt
const VK_W = 0x57;
const KEYUP = 0x0002;

function tap(vk, mods = []) {
  for (const m of mods) keybd_event(m, 0, 0, 0);
  keybd_event(vk, 0, 0, 0);
  keybd_event(vk, 0, KEYUP, 0);
  for (const m of [...mods].reverse()) keybd_event(m, 0, KEYUP, 0);
}

const combo = (process.argv[2] || 'ctrl+alt+w').toLowerCase();
const map = { ctrl: VK_CONTROL, alt: VK_MENU, w: VK_W };
const parts = combo.split('+');
const mods = parts.slice(0, -1).map((p) => map[p]).filter(Boolean);
const key = map[parts.at(-1)];

tap(key, mods);
console.log('sent', combo);
