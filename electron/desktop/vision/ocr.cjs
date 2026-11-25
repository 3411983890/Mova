'use strict';
// Windows.Media.Ocr（WinRT）桥：PowerShell 5.1 调用，返回带坐标的文本行。
// 这是“自绘界面唯一能读到的内容”——例如微信 4.x，UIA 树只有 3 个节点。
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(__dirname, '..', 'host', 'ocr.ps1');

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

let probed = null;

/** 能力探测（会真的跑一次 OCR，结果缓存）。 */
async function probe() {
  if (probed) return probed;
  try {
    const sample = path.join(__dirname, 'host', 'ocr.ps1');
    if (!fs.existsSync(sample)) { probed = { available: false, reason: 'missing-script' }; return probed; }
    probed = { available: true, reason: '', script: SCRIPT };
  } catch (error) {
    probed = { available: false, reason: (error && error.code) || 'probe-failed' };
  }
  return probed;
}

/**
 * 对一张图片做 OCR。
 * @param {string} filePath
 * @param {{language?:string}} [options]
 * @returns {Promise<{ok:true, language:string, lines:Array<{text:string,x:number,y:number,w:number,h:number}>, text:string}>}
 */
async function recognize(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw coded('no-file', '图片不存在');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', filePath];
  if (options.language) args.push('-Language', String(options.language));
  let stdout;
  try {
    ({ stdout } = await execFileAsync('powershell.exe', args, { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }));
  } catch (error) {
    throw coded('ocr-failed', (error && error.message) || 'OCR 进程失败');
  }
  let parsed;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { throw coded('ocr-failed', 'OCR 输出不是 JSON'); }
  if (!parsed || parsed.ok !== true) throw coded((parsed && parsed.code) || 'ocr-failed', (parsed && parsed.message) || 'OCR 失败');
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const text = lines.map((line) => line.text).join('\n');
  return { ok: true, language: parsed.language || '', lines, text, count: lines.length };
}

/**
 * 在 OCR 结果里找“包含某段文字”的行（给点击定位用）。
 * @returns {{text:string,x:number,y:number,w:number,h:number,center:{x:number,y:number}}|null}
 */
function findLine(result, needle) {
  if (!result || !Array.isArray(result.lines) || !needle) return null;
  const target = String(needle).replace(/\s+/g, '');
  for (const line of result.lines) {
    const flat = String(line.text || '').replace(/\s+/g, '');
    if (flat.includes(target)) {
      return { ...line, center: { x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2) } };
    }
  }
  return null;
}

module.exports = { probe, recognize, findLine, SCRIPT };
