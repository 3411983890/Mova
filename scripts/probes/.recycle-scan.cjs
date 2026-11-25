// 解析回收站 $I 元数据，找出“原位置在 Desktop”的条目（只读，先不移动任何文件）
const fs = require('node:fs');
const path = require('node:path');

const root = 'C:\\$Recycle.Bin';
const out = [];

function parseI(buf) {
  const version = buf.readBigUInt64LE(0);
  const size = buf.readBigUInt64LE(8);
  let offset = 24;
  let originalPath = '';
  if (version === 2n) {
    const len = buf.readUInt32LE(24);
    offset = 28;
    const chars = Math.max(0, Math.floor(len / 2) - 1);
    originalPath = buf.subarray(offset, offset + chars * 2).toString('utf16le');
  } else {
    const chars = Math.max(0, Math.floor(260) - 1);
    originalPath = buf.subarray(offset, offset + chars * 2).toString('utf16le').replace(/\0.*$/, '');
  }
  return { version: Number(version), size: Number(size), originalPath };
}

for (const sid of fs.readdirSync(root, { withFileTypes: true })) {
  if (!sid.isDirectory()) continue;
  const dir = path.join(root, sid.name);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { continue; }
  for (const name of entries) {
    if (!name.startsWith('$I')) continue;
    const meta = path.join(dir, name);
    let parsed;
    try { parsed = parseI(fs.readFileSync(meta)); } catch { continue; }
    if (!parsed.originalPath) continue;
    out.push({ meta, dataFile: path.join(dir, '$R' + name.slice(2)), ...parsed });
  }
}

const desktop = out.filter((e) => /\\Desktop\\/.test(e.originalPath));
console.log('total entries:', out.length, 'desktop entries:', desktop.length);
for (const e of desktop.slice(0, 12)) console.log(' -', e.originalPath);
const missing = desktop.filter((e) => !fs.existsSync(e.originalPath));
console.log('desktop entries whose target is currently missing:', missing.length);
console.log('sample data file exists:', missing.slice(0, 3).map((e) => fs.existsSync(e.dataFile)));
fs.writeFileSync('design/e2e/recycle-desktop.json', JSON.stringify(missing.map((e) => ({ from: e.dataFile, to: e.originalPath })), null, 2), 'utf8');
console.log('plan written to design/e2e/recycle-desktop.json');
