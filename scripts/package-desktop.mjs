/**
 * Portable Windows desktop package: Electron runtime + `dist/` + `electron/` +
 * the runtime dependency closure, laid out so the folder can be zipped and run
 * by double-clicking `Mova.exe` on any Windows x64 machine.
 *
 * Why not electron-builder: this checkout has no packaged-app toolchain (see
 * README: "尚无安装包") and downloading NSIS/winCodeSign is not required for a
 * portable folder. Everything here is a copy of files that already exist in the
 * checkout, so the result stays reproducible offline.
 *
 * Usage: node scripts/package-desktop.mjs [--zip] [--skip-build]
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeClosure } from './package-runtime-deps.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
const args = new Set(process.argv.slice(2));
const outRoot = join(root, 'release');
const appName = 'Mova-win32-x64';
const outDir = join(outRoot, appName);
const appDir = join(outDir, 'resources', 'app');
const electronDist = join(root, 'node_modules', 'electron', 'dist');
const nodeModules = join(root, 'node_modules');

// Packages the renderer never loads at runtime; they belong to browser builds.
const skipPackages = new Set(['onnxruntime-web']);
// Cross-platform native payloads for a Windows x64 package.
const prunePaths = [
  join('onnxruntime-node', 'bin', 'napi-v6', 'darwin'),
  join('onnxruntime-node', 'bin', 'napi-v6', 'linux'),
  join('onnxruntime-node', 'bin', 'napi-v6', 'win32', 'arm64'),
  // A dev-run model cache inside the package; the app downloads models into
  // userData/models instead (see electron/services/embedding.cjs).
  join('@huggingface', 'transformers', '.cache'),
];
const keepLocales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);

const log = message => console.log(`[package] ${message}`);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function copyElectronRuntime() {
  await cp(electronDist, outDir, {
    recursive: true,
    filter: source => {
      const name = source.slice(electronDist.length + 1);
      if (name.startsWith('locales')) {
        const locale = name.slice('locales'.length + 1);
        return locale === '' || keepLocales.has(locale);
      }
      if (name === 'resources' || name.startsWith('resources\\') || name.startsWith('resources/')) {
        // electron/dist/resources only holds the default app (default_app.asar).
        return false;
      }
      return true;
    },
  });
  const exe = join(outDir, 'electron.exe');
  if (!(await exists(exe))) throw new Error(`electron runtime missing at ${exe}`);
  await cp(exe, join(outDir, 'Mova.exe'));
  await rm(exe, { force: true });
}

async function copyAppFiles() {
  const appPackage = {
    name: 'mova',
    productName: 'Mova',
    version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
    description: 'Mova desktop',
    main: 'electron/main.cjs',
  };
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`);

  await cp(join(root, 'dist'), join(appDir, 'dist'), { recursive: true });
  await cp(join(root, 'electron'), join(appDir, 'electron'), {
    recursive: true,
    filter: source => !/[\\/][^\\/]+\.test\.cjs$/.test(source),
  });
  // `edge-extension/` is the *source* of the Edge side-panel extension; the
  // desktop app only imports `edge-extension/pointer.js` from it, and the
  // extension itself ships from `dist-edge/` via `npm run build:edge`. The
  // import closure below copies exactly that one file.
  await mkdir(join(appDir, 'assets'), { recursive: true });
  for (const icon of ['app-icon.png', 'app-icon.ico']) {
    await cp(join(root, 'assets', icon), join(appDir, 'assets', icon));
  }
  await mkdir(join(appDir, 'scripts'), { recursive: true });
  // The main process re-runs these two with ELECTRON_RUN_AS_NODE for the local
  // Docker service stack (electron/memory-runtime.cjs, scripts/services.mjs).
  for (const script of ['services.mjs', 'db-migrate.mjs']) {
    await cp(join(root, 'scripts', script), join(appDir, 'scripts', script));
  }
  await cp(join(root, 'docker-compose.yml'), join(appDir, 'docker-compose.yml'));
  await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(appDir, 'THIRD_PARTY_NOTICES.md'));
}

// The main process is not a self-contained tree: ESM/CJS modules under
// `electron/` import across the repo boundary (e.g. `chat-agent.mjs` imports
// `../src/features/chat/context-budget.mjs`, `browser/controller.cjs` imports
// `../../edge-extension/pointer.js`). Listing those by hand is how a package
// ships a missing module and dies only when the feature is first used, so walk
// the imports instead: copy every escaped target, then keep walking whatever
// got copied, until the closure stops growing.
const CODE_FILE = /\.(cjs|mjs|js)$/i;
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"\n]+)['"]/g;
const EXTENSIONS = ['', '.mjs', '.cjs', '.js', '.json', '.ts', '.tsx'];

// Prose in comments and docs looks like code to a regex (`from "memory is
// unavailable"`, `import('` inside a prompt string). Strip comments and drop
// specifiers that cannot be module ids (whitespace, pinning text) so only real
// imports survive.
function stripComments(code) {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];
    if (char === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i++;
      out += ' ';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      out += char;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { out += code[i] + (code[i + 1] || ''); i += 2; continue; }
        if (code[i] === quote) break;
        out += code[i];
        i++;
      }
      out += quote;
      continue;
    }
    out += char;
  }
  return out;
}

function relativeSpecifiers(code) {
  const out = new Set();
  for (const match of stripComments(code).matchAll(SPECIFIER)) {
    const spec = match[1];
    if (!spec || /\s/.test(spec)) continue;
    if (spec.startsWith('./') || spec.startsWith('../')) out.add(spec);
  }
  return out;
}

async function resolveCodePath(base) {
  const candidates = [...EXTENSIONS.map(ext => `${base}${ext}`),
    ...EXTENSIONS.slice(1).map(ext => join(base, `index${ext}`))];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

async function collectCodeFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) await collectCodeFiles(child, out);
    else if (CODE_FILE.test(entry.name)) out.push(child);
  }
  return out;
}

async function copyEscapingImports() {
  const queue = await collectCodeFiles(appDir);
  const scanned = new Set();
  const copied = [];
  while (queue.length) {
    const file = queue.shift();
    if (scanned.has(file)) continue;
    scanned.add(file);
    const code = await readFile(file, 'utf8');
    for (const spec of relativeSpecifiers(code)) {
      // Resolved against the *packaged* file: an import that stays inside
      // resources/app is already covered, anything else has to be mirrored in
      // from the checkout (the package keeps the repo's directory layout).
      const target = resolve(join(dirname(file), spec));
      const relative = target.slice(appDir.length + 1);
      if (relative.startsWith('..') || copied.includes(relative)) continue;
      if (await resolveCodePath(target)) continue; // already packaged
      const source = await resolveCodePath(join(root, relative));
      if (!source) continue; // verifyModuleGraph reports it with a clear path
      await cp(source, join(appDir, relative), { recursive: true });
      copied.push(relative);
      for (const added of await collectCodeFiles(dirname(join(appDir, relative)))) queue.push(added);
    }
  }
  return copied;
}

// Fail the package instead of shipping a module graph that resolves only on the
// build machine: every relative import must exist inside the package, and every
// bare import must resolve against the packaged node_modules.
const RUNTIME_PROVIDED = new Set(['electron']);
const builtins = new Set(builtinModules);

function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function verifyModuleGraph() {
  const problems = [];
  for (const file of await collectCodeFiles(appDir)) {
    const code = await readFile(file, 'utf8');
    const where = file.slice(appDir.length + 1);
    for (const match of stripComments(code).matchAll(SPECIFIER)) {
      const spec = match[1];
      if (!spec || /\s/.test(spec)) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolve(join(dirname(file), spec));
        if (target.startsWith(appDir + sep)) {
          if (!(await resolveCodePath(target))) problems.push(`${where}: missing ${spec}`);
        } else {
          problems.push(`${where}: ${spec} escapes the package`);
        }
        continue;
      }
      if (spec.startsWith('node:') || builtins.has(spec) || RUNTIME_PROVIDED.has(packageNameOf(spec))) continue;
      const name = packageNameOf(spec);
      if (!(await exists(join(appDir, 'node_modules', ...name.split('/'), 'package.json')))) {
        problems.push(`${where}: package ${name} is not packaged`);
      }
    }
  }
  if (problems.length) throw new Error(`module graph is not self-contained:\n  ${problems.join('\n  ')}`);
}

async function copyRuntimeDependencies() {
  const { copied, missing } = resolveRuntimeClosure(nodeModules);
  if (missing.length) throw new Error(`missing runtime dependencies: ${missing.join(', ')}`);
  const target = join(appDir, 'node_modules');
  await mkdir(target, { recursive: true });
  let skipped = [];
  for (const name of copied) {
    if (skipPackages.has(name)) {
      skipped.push(name);
      continue;
    }
    await cp(join(nodeModules, ...name.split('/')), join(target, ...name.split('/')), {
      recursive: true,
      // Nested installs keep their own tree; only the top-level platform-agnostic
      // payloads below are trimmed.
      filter: source => {
        const relative = source.slice(join(nodeModules, ...name.split('/')).length + 1);
        return !relative.startsWith('test') && !relative.startsWith('.github');
      },
    });
  }
  for (const relative of prunePaths) await rm(join(target, relative), { recursive: true, force: true });
  return { copied, skipped };
}

async function writeLauncherNotes(electronVersion) {
  const notes = `Mova 便携版（Windows x64）

启动
  双击 Mova.exe。

  若本目录是从压缩包解压出来的，双击后完全没反应（连窗口都不闪），
  请先双击一次 repair-and-start.cmd：它会补齐目录权限再启动（首次几十秒），
  之后照常双击 Mova.exe 即可。原因见下面「排查」。

数据目录
  %APPDATA%\\Mova（设置、会话、模型凭据、记忆库）
  删除该目录等于恢复出厂状态。

本地记忆服务（可选）
  记忆库、索引与备份依赖 docker-compose.yml 里的本地服务栈
  （PostgreSQL + pgvector、Redis、MinIO）。需要 Docker Desktop：
    1. 启动 Docker Desktop
    2. 启动本软件，在设置里开启本地服务（它会自己拉起服务栈）
  也可以手动建栈：在本目录执行
    docker compose -p mova-local -f docker-compose.yml up -d
  未启动服务时，其余功能照常可用。

说明
  - 这是免安装目录版：整个文件夹可整体移动、复制或压缩分发。
  - 内置 Electron ${electronVersion} 运行时，目标机器无需安装 Node.js。
  - 任务栏与窗口图标取自 assets/app-icon.png；Mova.exe 文件图标仍是 Electron 默认图标。

排查
  1) 双击后没有任何窗口，且 %APPDATA%\\Mova\\logs 下没有生成新的日志：
     - 若从命令行启动，先确认没有 ELECTRON_RUN_AS_NODE=1（Electron 会退化成纯
       Node 解释器，100ms 内以退出码 0 结束、不建窗口）。执行
       Remove-Item Env:ELECTRON_RUN_AS_NODE 后重试，或直接双击 Mova.exe。
     - 压缩包解压出来的目录可能缺少 AppContainer 读取权限（Electron 子进程用
       AppContainer 令牌，缺授权会在 main.cjs 之前崩溃）。双击
       「repair-and-start.cmd」一次即可。
  2) 界面能打开但记忆 / 索引不可用：本地服务栈没起来，见上面「本地记忆服务」。
`;
  // BOM so Windows 记事本 / PowerShell 5.1 detect UTF-8 instead of ANSI (garbled CJK).
  await writeFile(join(outDir, 'README.txt'), `\uFEFF${notes}`, 'utf8');

  // Extracting a zip drops the AppContainer read grant this package relies on
  // (zip stores no ACLs). Electron's renderer runs under an AppContainer token,
  // so a fresh extraction can die with 0x80000003 before main.cjs runs. This
  // launcher re-applies the grant (idempotent, skipped when already present —
  // the recursive icacls pass over 16k files takes ~40s) and then starts the app.
  //
  // Keep this file ASCII-only and free of `chcp`/multi-line `( )` blocks: a
  // mid-batch codepage switch plus multi-byte text makes cmd.exe mis-parse the
  // rest of the script (observed: nothing ran, exit 0). The Chinese explanation
  // lives in README.txt instead.
  const launcher = [
    '@echo off',
    'rem Electron child processes read the app directory through an AppContainer',
    'rem token; a zip extraction drops that ACL and the app then dies before',
    'rem main.cjs starts. Grant it once (no-op when already present).',
    'icacls "%~dp0." 2>nul | findstr /C:"ALL APPLICATION PACKAGES" >nul',
    'if errorlevel 1 icacls "%~dp0." /grant *S-1-15-2-1:(OI)(CI)(RX) /T /C >nul 2>&1',
    'start "" "%~dp0Mova.exe"',
    '',
  ].join('\r\n');
  await writeFile(join(outDir, 'repair-and-start.cmd'), launcher, 'utf8');
}

function grantAppContainerRead(dir) {
  if (process.platform !== 'win32') return false;
  const current = spawnSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
  if (current.error || current.status !== 0) throw new Error(`icacls failed: ${current.error?.message || current.stderr}`);
  if (/S-1-15-2-1:|ALL APPLICATION PACKAGES:/i.test(current.stdout)) return false;
  // Electron's own child processes run with an AppContainer token; without this
  // grant the packaged app dies with 0x80000003 before main.cjs runs.
  const result = spawnSync('icacls', [dir, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/C'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`icacls grant failed: ${result.error?.message || result.stderr || result.stdout}`);
  if (/Failed processing [1-9]|处理 [1-9] 个文件时失败/i.test(result.stdout)) {
    console.warn('[package] warning: some files could not be granted AppContainer read access');
  }
  return true;
}

function zipPackage(version) {
  const zipPath = join(outRoot, `Mova-${version}-win32-x64-portable.zip`);
  const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', outRoot, appName], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  if (tar.error || tar.status !== 0) throw new Error(`zip failed: ${tar.error?.message || tar.stderr}`);
  return zipPath;
}

async function main() {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (!args.has('--skip-build')) {
    log('building dist/ (vite)');
    const build = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('build failed');
  }
  if (!(await exists(join(root, 'dist', 'index.html')))) throw new Error('dist/index.html missing — run npm run build first');

  log(`cleaning ${outDir}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log('copying Electron runtime');
  await copyElectronRuntime();
  log('copying app files');
  await copyAppFiles();
  log('copying runtime dependencies');
  const { copied, skipped } = await copyRuntimeDependencies();
  log(`dependencies: ${copied.length} packages (skipped: ${skipped.join(', ') || 'none'})`);

  const escaped = await copyEscapingImports();
  log(`cross-boundary modules: ${escaped.join(', ') || 'none'}`);
  await verifyModuleGraph();
  log('module graph verified (all relative imports and bare packages resolve)');

  await writeLauncherNotes(JSON.parse(await readFile(join(nodeModules, 'electron', 'package.json'), 'utf8')).version);
  if (grantAppContainerRead(outDir)) log('granted AppContainer read access');

  const size = await dirSize(outDir);
  log(`done: ${outDir} (${formatSize(size)})`);
  if (args.has('--zip')) {
    const zipPath = zipPackage(version);
    log(`zip: ${zipPath} (${formatSize((await stat(zipPath)).size)})`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main().catch(error => {
    console.error(`[package] failed: ${error.message}`);
    process.exit(1);
  });
}
