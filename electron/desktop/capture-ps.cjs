'use strict';
// PowerShell 截屏（GDI CopyFromScreen）：不依赖 Electron / sharp，
// 用来绕过某些机器上 desktopCapturer + sharp 的 colourspace 问题。
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(__dirname, 'host', 'capture.ps1');

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/**
 * @param {{x?:number,y?:number,w?:number,h?:number,out?:string}} [region]
 * @returns {Promise<{path:string,width:number,height:number,x:number,y:number}>}
 */
async function grabScreen(region = {}) {
  if (!fs.existsSync(SCRIPT)) throw coded('capture-unavailable', '缺少 host/capture.ps1');
  const out = region.out || path.join(os.tmpdir(), `mova-capture-${Date.now()}.png`);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Out', out];
  if (Number.isFinite(region.x)) args.push('-X', String(Math.round(region.x)));
  if (Number.isFinite(region.y)) args.push('-Y', String(Math.round(region.y)));
  if (Number.isFinite(region.w)) args.push('-W', String(Math.round(region.w)));
  if (Number.isFinite(region.h)) args.push('-H', String(Math.round(region.h)));

  const { stdout } = await execFileAsync('powershell.exe', args, { maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  let parsed;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { throw coded('capture-failed', '截图输出不是 JSON'); }
  if (!parsed || parsed.ok !== true) throw coded(parsed && parsed.code ? parsed.code : 'capture-failed', parsed && parsed.message ? parsed.message : '截图失败');
  return { path: parsed.path || out, width: parsed.width, height: parsed.height, x: parsed.x, y: parsed.y };
}

module.exports = { grabScreen, SCRIPT };
