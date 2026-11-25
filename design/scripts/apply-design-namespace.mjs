// Applies the design-copy storage namespace so previews never read or write the main app's data.
import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../source/app.js', import.meta.url);
const source = await readFile(target, 'utf8');
const next = source.replaceAll("'mova.", "'mova-design.");
if (next === source) {
  const matches = source.match(/mova-design\./g)?.length ?? 0;
  console.log(`Namespace already applied (${matches} keys).`);
} else {
  await writeFile(target, next);
  console.log('Applied mova-design.* storage namespace.');
}
