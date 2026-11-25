import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const design = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL('./source/', import.meta.url)),
  base: './',
  cacheDir: fileURLToPath(new URL('./node_modules/.vite/', import.meta.url)),
  server: {
    host: '127.0.0.1', port: 4174, strictPort: true,
    fs: { strict: true, allow: [design] },
  },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true },
  build: { outDir: design, emptyOutDir: false },
});
