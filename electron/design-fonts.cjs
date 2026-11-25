'use strict';
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

// The families this host can actually serve, as [name accepted from the renderer, font file key].
// Renderer input chooses a known family/face, never a filesystem path, so this table is both the
// loader's allow-list and the canvas's authoritative font catalogue: anything outside it cannot be
// rendered, which is what lets the renderer reject an unknown family instead of silently painting
// nothing.
const DESIGN_FONT_ALIASES = [
  ['Microsoft YaHei', 'yahei'], ['Microsoft YaHei UI', 'yahei'], ['微软雅黑', 'yahei'],
  ['SimHei', 'simhei'], ['黑体', 'simhei'],
  ['SimSun', 'simsun'], ['宋体', 'simsun'],
];

function createDesignFontLoader({ fontDirectory = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'Fonts'), read = readFile } = {}) {
  const files = new Map();
  const families = new Map(DESIGN_FONT_ALIASES.map(([name, key]) => [name.trim().toLowerCase(), key]));
  return async function load(family = 'Microsoft YaHei', style = 'Regular') {
    if (typeof family !== 'string' || family.length > 128 || typeof style !== 'string' || style.length > 64) throw new Error('字体请求无效');
    const known = families.get(family.trim().toLowerCase());
    if (!known) return null;
    const face = style.toLowerCase().replace(/[\s_-]/g, '');
    const file = known === 'yahei' ? (/bold|black|heavy/.test(face) ? 'msyhbd.ttc' : /light|thin/.test(face) ? 'msyhl.ttc' : 'msyh.ttc') : known === 'simhei' ? 'simhei.ttf' : 'simsun.ttc';
    if (!files.has(file)) files.set(file, read(join(fontDirectory, file)).then(bytes => new Uint8Array(bytes)).catch(error => {
      files.delete(file);
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取本机中文字体');
    }));
    return files.get(file);
  };
}

module.exports = { createDesignFontLoader, DESIGN_FONT_ALIASES };
