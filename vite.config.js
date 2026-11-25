import { defineConfig } from 'vite';
import { prepareDesignAssets } from './scripts/prepare-design-assets.mjs';
import { openPencilCompatibility } from './scripts/open-pencil-vite.mjs';
await prepareDesignAssets();

// The root index.html still links `./project-dialog.css` and `./project-popover.js`
// (classic + defer, no module graph). Their sources moved under src/features/projects/,
// so the dev server aliases the old flat URLs at them. `npm run build` does the same
// copy in scripts/build.mjs; this plugin only applies to `vite` (serve).
function legacyRootAssets() {
  const relocated = {
    '/project-dialog.css': '/src/features/projects/project-dialog.css',
    '/project-popover.js': '/src/features/projects/project-popover.js',
  };
  return {
    name: 'mova-legacy-root-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (relocated[path]) req.url = relocated[path];
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [openPencilCompatibility(), legacyRootAssets()],
  worker: { format: 'es', plugins: () => [openPencilCompatibility()] },
  resolve: { preserveSymlinks: true },
  optimizeDeps: { entries: ['index.html'] },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
