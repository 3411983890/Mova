import { cp, mkdir } from 'node:fs/promises';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { openPencilCompatibility } from './open-pencil-vite.mjs';
const root = new URL('../', import.meta.url);
export async function prepareDesignAssets() {
  const output = new URL('vendor/open-pencil/', root);
  await mkdir(output, { recursive: true });
  await cp(new URL('node_modules/canvaskit-wasm/bin/canvaskit.wasm', root), new URL('canvaskit.wasm', output));
  await cp(new URL('node_modules/@open-pencil/core/assets/', root), output, { recursive: true });
  await cp(new URL('node_modules/@open-pencil/core/LICENSE', root), new URL('LICENSE-OpenPencil.txt', output));
  await cp(new URL('node_modules/canvaskit-wasm/LICENSE', root), new URL('LICENSE-CanvasKit.txt', output));
  await cp(new URL('design/vendor/open-pencil-ui/LICENSE-Inter.txt', root), new URL('LICENSE-Inter.txt', output));
  await build({ configFile: false, root: fileURLToPath(root), plugins: [openPencilCompatibility()],
    worker: { format: 'es', plugins: () => [openPencilCompatibility()] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { target: 'esnext', outDir: 'vendor/open-pencil-editor', emptyOutDir: true,
      lib: { entry: 'src/features/design/design-editor.js', formats: ['es'], fileName: () => 'index.js', cssFileName: 'design-editor' } } });
}
