import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exec as execCb } from 'node:child_process';
import cpModule from 'node:child_process';
import { createRequire } from 'node:module';

// 沙箱下子进程管道被禁止，vite 的 safeRealpath 会调用 `net use`。
// 这里让该调用立即失败，vite 会回退到 realpathSync.native。
const require = createRequire(import.meta.url);
cpModule.exec = (_command, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  if (typeof done === 'function') done(Object.assign(new Error('exec disabled'), { code: 'EPERM' }), '', '');
  return { on() {}, kill() {} };
};
if (typeof cpModule.syncBuiltinESMExports === 'function') cpModule.syncBuiltinESMExports();

const ts = (await import('typescript')).default;
const { build } = await import('vite');

const design = new URL('../', import.meta.url);
const source = new URL('source/', design);
const manifest = JSON.parse(await readFile(new URL('package.json', design), 'utf8'));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  await access(new URL(`node_modules/${name}/package.json`, design));
}

// 用 TypeScript 编译器替代 esbuild 做 JSX/TS 转译（纯 JS，不派生子进程）。
function tsTransformPlugin() {
  return {
    name: 'mova-ts-transform',
    enforce: 'pre',
    transform(code, id) {
      const clean = id.split('?')[0];
      if (!/\.(?:jsx|tsx|ts|mjs)$/.test(clean)) return null;
      if (clean.includes('/node_modules/')) return null;
      const result = ts.transpileModule(code, {
        fileName: clean,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          jsxImportSource: 'react',
          allowJs: true,
          esModuleInterop: true,
          isolatedModules: true,
          sourceMap: false,
          verbatimModuleSyntax: false,
        },
      });
      return { code: result.outputText, map: null };
    },
  };
}

// 顶替 vite 的 define（esbuild 关闭后不再自动替换）。
function definePlugin(defines) {
  const keys = Object.keys(defines);
  return {
    name: 'mova-define',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('/node_modules/')) {
        if (!keys.some(key => code.includes(key))) return null;
      } else if (!keys.some(key => code.includes(key))) return null;
      let next = code;
      for (const key of keys) next = next.split(key).join(JSON.stringify(defines[key]));
      return { code: next, map: null };
    },
  };
}

const bundle = await build({
  configFile: false,
  root: fileURLToPath(source),
  esbuild: false,
  define: {},
  plugins: [definePlugin({ 'process.env.NODE_ENV': 'production' }), tsTransformPlugin()],
  build: {
    write: false,
    minify: false,
    cssMinify: false,
    target: 'es2022',
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
console.log('Standalone design/index.html rebuilt (no esbuild child process).');
