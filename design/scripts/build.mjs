import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// All inputs and outputs stay inside design/. Never build or write to the parent app.
const design = new URL('../', import.meta.url);
const source = new URL('source/', design);
const manifest = JSON.parse(await readFile(new URL('package.json', design), 'utf8'));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  await access(new URL(`node_modules/${name}/package.json`, design));
}
const bundle = await build({
  configFile: false,
  root: fileURLToPath(source),
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    lib: { entry: 'src/app/main.tsx', name: 'MovaDesign', formats: ['iife'], fileName: 'app' },
  },
});

for (const entry of ['styles.css', 'project-dialog.css', 'project-popover.js', 'keyline-icons.css', 'assets', 'vendor/emotion-ball', 'vendor/leibox/LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
  await cp(new URL(entry, source), new URL(entry, design), { recursive: true });
}
const output = bundle[0].output;
const app = output.find(item => item.type === 'chunk' && item.isEntry);
if (!app) throw new Error('Missing frontend entry bundle');
await writeFile(new URL('app.js', design), app.code);
let html = await readFile(new URL('index.html', source), 'utf8');
for (const asset of output.filter(item => item.type === 'asset')) {
  const target = new URL(asset.fileName, design);
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, asset.source);
  if (asset.fileName.endsWith('.css')) html = html.replace('</head>', `  <link rel="stylesheet" href="./${asset.fileName}">\n</head>`);
}
await writeFile(new URL('index.html', design), html.replace('<script type="module" src="./src/app/main.tsx">', '<script src="./app.js" defer>'));
console.log('Standalone design/index.html rebuilt. Main application was not modified.');
