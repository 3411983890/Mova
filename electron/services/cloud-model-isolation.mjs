/**
 * 负责：以独立文件系统视图和无直连的 Linux 网络命名空间启动订阅 CLI。
 * 不负责：模型协议、线路选择或跨端凭据同步。
 * 被谁调用：cloud-subscriptions.mjs。
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, glob, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startCloudModelProxy } from './cloud-model-proxy.mjs';
import { buildProxyEnv } from '../vpn/router.mjs';
import { fail } from './cloud-store.mjs';

const bridgeScript = fileURLToPath(new URL('./cloud-model-bridge.mjs', import.meta.url));

async function executableOf(provider, env) {
  const configured = provider === 'codex' ? env.MOVA_CODEX_BIN : env.MOVA_AGY_BIN;
  if (configured) { await access(configured, constants.X_OK); return realpath(configured); }
  if (provider === 'codex') {
    const roots = [join(homedir(), '.local/lib/node_modules/@openai/codex'), '/usr/local/lib/node_modules/@openai/codex', '/usr/lib/node_modules/@openai/codex'];
    for (const root of roots) {
      for await (const path of glob('node_modules/@openai/*/vendor/*/bin/codex', { cwd: root })) {
        const bin = join(root, path);
        await access(bin, constants.X_OK);
        return realpath(bin);
      }
    }
  }
  for (const root of [join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin']) {
    try { const bin = join(root, provider === 'gemini' ? 'agy' : 'codex'); await access(bin, constants.X_OK); return realpath(bin); } catch { /* try next install location */ }
  }
  throw fail('model_cli_missing', '请安装订阅 CLI，或配置其原生二进制路径', 503);
}

export async function openModelIsolation({ dir, provider, proxy, env, interactive }) {
  if (process.platform !== 'linux') throw fail('linux_required', '订阅模型须在 Linux 执行', 503);
  let bin;
  try { bin = await executableOf(provider, env); } catch { throw fail('model_cli_missing', '请安装订阅 CLI，或配置其原生二进制路径', 503); }
  const profile = join(dir, 'accounts', provider);
  await mkdir(provider === 'codex' ? join(profile, '.codex') : profile, { recursive: true, mode: 0o700 });
  const sandbox = await mkdtemp(join(tmpdir(), 'mova-model-'));
  const socket = join(sandbox, 'proxy');
  let stopProxy;
  try { stopProxy = await startCloudModelProxy(socket, proxy, provider); }
  catch (error) { await rm(sandbox, { recursive: true, force: true }); throw error; }
  const proxyEnv = buildProxyEnv('http://127.0.0.1:18080', {});
  const environment = { ...proxyEnv, HOME: '/account', CODEX_HOME: '/account/.codex', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', LANG: 'C.UTF-8', TERM: env.TERM || 'xterm', SSH_CONNECTION: env.SSH_CONNECTION || '127.0.0.1 1 127.0.0.1 22', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  const options = [
    '--unshare-net', '--unshare-pid', '--unshare-ipc', '--die-with-parent', '--clearenv',
    ...(interactive ? [] : ['--new-session']),
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs', '--bind', profile, '/account',
    '--ro-bind', bin, '/mova-cli', '--ro-bind', process.execPath, '/mova-node', '--ro-bind', bridgeScript, '/mova-model-bridge.mjs',
    '--bind', socket, '/mova-proxy', '--dir', '/work', '--chdir', '/work',
    ...Object.entries(environment).flatMap(([key, value]) => ['--setenv', key, value]),
    '--', '/mova-node', '/mova-model-bridge.mjs', '/mova-cli',
  ];
  return {
    spawn: (_command, args, settings) => spawn(env.MOVA_BWRAP_BIN || 'bwrap', [...options, ...args], {
      stdio: settings?.stdio ?? ['pipe', 'pipe', 'pipe'],
    }),
    async close() { await stopProxy(); await rm(sandbox, { recursive: true, force: true }); },
  };
}
