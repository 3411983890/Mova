import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { prepareDesignAssets } from './prepare-design-assets.mjs';
import { openPencilCompatibility } from './open-pencil-vite.mjs';
await prepareDesignAssets();

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const bundle = await build({
  configFile: false,
  plugins: [openPencilCompatibility()],
  worker: { format: 'es', plugins: () => [openPencilCompatibility()] },
  root: fileURLToPath(root),
  resolve: { preserveSymlinks: true },
  // Library mode otherwise leaves dependency references to Node's process in the offline bundle.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    lib: { entry: 'src/app/main.tsx', name: 'MovaPrototype', formats: ['iife'], fileName: 'app' },
  },
});

await mkdir(dist, { recursive: true });
// [source, destination] — the two project-dialog assets are still referenced by
// the root index.html as `./project-dialog.css` / `./project-popover.js`, so they
// keep those flat names in dist even though the sources live under src/features/.
const staticEntries = [
  ['styles.css', 'styles.css'],
  ['keyline-icons.css', 'keyline-icons.css'],
  ['src/features/projects/project-dialog.css', 'project-dialog.css'],
  ['src/features/projects/project-popover.js', 'project-popover.js'],
  ['assets', 'assets'],
  // 启动动画：`index.html` 的 #boot-splash 覆盖层用 iframe 引它。
  // 必须走 dist 才能被 `mova://app/...` 的 CSP 覆盖到（内联脚本一律被拦，见 scripts/split-splash.mjs）。
  ['electron/splash', 'splash'],
  ['vendor/emotion-ball', 'vendor/emotion-ball'],
  ['vendor/open-pencil', 'vendor/open-pencil'],
  ['vendor/open-pencil-editor', 'vendor/open-pencil-editor'],
  ['vendor/leibox/LICENSE.md', 'vendor/leibox/LICENSE.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
];
for (const [entry, target] of staticEntries) {
  await cp(new URL(entry, root), new URL(target, dist), { recursive: true });
}
const app = bundle[0].output.find(item => item.type === 'chunk' && item.isEntry);
await writeFile(new URL('app.js', dist), app.code);
let html = await readFile(new URL('index.html', root), 'utf8');
for (const asset of bundle[0].output.filter(item => item.type === 'asset')) {
  await writeFile(new URL(asset.fileName, dist), asset.source);
  if (asset.fileName.endsWith('.css')) html = html.replace('</head>', `  <link rel="stylesheet" href="./${asset.fileName}">\n</head>`);
}
await writeFile(new URL('index.html', dist), html.replace('<script type="module" src="./src/app/main.tsx">', '<script src="./app.js" defer>'));
console.log('Static HTML prototype prepared in dist/');
