import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// SDK 0.16's compiled modules retain source .ts worker URLs. Resolve them
// to the .js workers shipped alongside them, without editing node_modules.
//
// The canvas also clears its surface with the page colour at full alpha, which
// hides the panel's dot matrix underneath it. Mova draws that matrix in CSS, so
// the clear honours the page colour's own alpha; a document that stores an
// opaque page colour keeps its opaque background.
const CLEAR_WITH_PAGE_COLOR = /Color4f\((\w+)\.pageColor\.r,\s*\1\.pageColor\.g,\s*\1\.pageColor\.b,\s*1\)/g;

export function openPencilCompatibility() {
  return {
    name: 'mova-open-pencil-compat',
    enforce: 'pre',
    transform(code, id) {
      const path = id.replaceAll('\\', '/');
      if (!path.includes('/@open-pencil/core/dist/')) return null;
      let next = code.replace(/new URL\("([^"]+)\.ts",\s*import\.meta\.url\)/g, (match, workerPath) =>
        existsSync(resolve(dirname(id), `${workerPath}.js`)) ? `new URL("${workerPath}.js", import.meta.url)` : match);
      if (path.includes('/canvas/renderer/')) {
        next = next.replace(CLEAR_WITH_PAGE_COLOR, 'Color4f($1.pageColor.r, $1.pageColor.g, $1.pageColor.b, $1.pageColor.a)');
      }
      return next === code ? null : next;
    },
  };
}
