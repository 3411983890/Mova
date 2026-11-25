// Records SHA-256 of the main project's frontend files at design-snapshot time.
// Used only for later comparison; nothing outside design/ is written.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const design = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const single = ['app.js', 'styles.css', 'keyline-icons.css', 'project-dialog.css', 'project-popover.js', 'index.html', 'composer.js', 'composer-usage.jsx', 'composer-dark.css', 'icons.js', 'forum.jsx', 'bot-builder.jsx', 'bot-conversation.jsx', 'project-data.js', 'sidebar-chats.js', 'sidebar-resize.js', 'thinking-block.jsx', 'tsconfig.json', 'vite.config.js', 'package.json', 'Mova设计规范.md', 'Mova开发方案.md', 'THIRD_PARTY_NOTICES.md'];
const trees = ['src', 'assets', 'vendor'];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const files = [];
for (const name of single) files.push(join(root, name));
for (const name of trees) files.push(...await walk(join(root, name)));

const records = [];
for (const file of files.sort()) {
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  records.push({ path: relative(root, file).replaceAll('\\', '/'), sha256: hash });
}
await writeFile(join(design, 'main-project-hashes.json'), JSON.stringify(records, null, 2) + '\n');
console.log(`Recorded ${records.length} file hashes at ${new Date().toISOString()}.`);
