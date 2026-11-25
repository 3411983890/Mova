import sharp from 'sharp';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const asset = new URL('assets/', root);
await mkdir(asset, { recursive: true });
for (const weight of ['regular', 'fill']) {
  const source = new URL(`node_modules/@phosphor-icons/web/src/${weight}/`, root);
  const dest = new URL(`icons/${weight}/`, asset);
  await mkdir(dest, { recursive: true });
  const name = weight === 'fill' ? 'Phosphor-Fill' : 'Phosphor';
  await copyFile(new URL(`${name}.woff2`, source), new URL(`${name}.woff2`, dest));
  const css = await readFile(new URL('style.css', source), 'utf8');
  await writeFile(new URL('style.css', dest), css.replace(/src:[\s\S]*?;/, `src: url('./${name}.woff2') format('woff2');`));
}
await copyFile(new URL('node_modules/@phosphor-icons/web/LICENSE', root), new URL('icons/LICENSE', asset));
const reference = 'C:/Users/34119/AppData/Local/Temp/codex-clipboard-70f8dd86-88a1-4aba-a708-0def79c73c86.png';
// Preserve the exact supplied artwork; coordinates are measured against the 1910px reference view.
const metadata = await sharp(reference).metadata();
const scale = metadata.width / 1910;
for (const [name, x, y, size] of [
  ['plugin-reference', 25, 401, 39],
  ['status-reference', 21, 1137, 47],
  ['welcome-reference', 1172, 462, 98],
]) {
  await sharp(reference).extract({ left: Math.round(x * scale), top: Math.round(y * scale), width: Math.round(size * scale), height: Math.round(size * scale) }).png().toFile(new URL(`${name}.png`, asset).pathname.replace(/^\/(\w:)/, '$1'));
}
