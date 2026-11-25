/**
 * Runtime dependency closure for the portable desktop package.
 *
 * The Electron main process loads a handful of packages at runtime (`pg`,
 * `sharp`, `koffi`, `@aws-sdk/client-s3`, `ioredis`, `bullmq`,
 * `@huggingface/transformers`, `@earendil-works/pi-*`, `yaml`, `undici`).
 * Everything the renderer needs is already bundled into `dist/app.js` by Vite,
 * so copying all of `node_modules` (1.4 GB, mostly dev tooling) would be waste.
 *
 * This module walks the declared dependency graph from an explicit root list and
 * returns the top-level package directories to copy. Nested `node_modules`
 * directories live inside those directories and are copied with them, so
 * version conflicts stay resolved exactly as they are in this checkout.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const RUNTIME_ROOTS = [
  'pg',
  'sharp',
  'koffi',
  'ioredis',
  'bullmq',
  'yaml',
  'undici',
  '@aws-sdk/client-s3',
  '@huggingface/transformers',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-schema',
];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function packageDir(nodeModules, name) {
  return join(nodeModules, ...name.split('/'));
}

function resolvePackage(nodeModules, name, fromDir) {
  const candidates = [];
  if (fromDir) {
    let dir = fromDir;
    for (;;) {
      candidates.push(join(dir, 'node_modules', ...name.split('/')));
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  candidates.push(packageDir(nodeModules, name));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * @param {string} nodeModules absolute path of the checkout's node_modules
 * @param {string[]} roots top-level package names the app requires at runtime
 * @returns {{ copied: string[], missing: string[], totalBytes: number }}
 */
export function resolveRuntimeClosure(nodeModules, roots = RUNTIME_ROOTS) {
  const copied = new Set();
  const missing = new Set();
  const queue = [];

  for (const name of roots) {
    const dir = resolvePackage(nodeModules, name, nodeModules);
    if (!dir) missing.add(name);
    else queue.push({ name, dir });
  }

  while (queue.length) {
    const { name, dir } = queue.pop();
    if (copied.has(name)) continue;
    copied.add(name);
    if (!dir.startsWith(nodeModules)) continue; // nested copy path
    const manifest = readJson(join(dir, 'package.json'));
    if (!manifest) continue;
    const deps = {
      ...(manifest.dependencies || {}),
      ...(manifest.optionalDependencies || {}),
      ...(manifest.peerDependencies || {}),
    };
    for (const dep of Object.keys(deps)) {
      if (copied.has(dep)) continue;
      const depDir = resolvePackage(nodeModules, dep, dir);
      if (depDir) queue.push({ name: dep, dir: depDir });
    }
  }

  // Only the first occurrence of a name decides which directory is copied; the
  // top-level install wins because it is seeded first.
  return { copied: [...copied].sort(), missing: [...missing].sort() };
}
