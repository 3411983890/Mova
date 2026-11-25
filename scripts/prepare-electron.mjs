import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows Electron child processes use an AppContainer token. Some archive and
// package installers leave electron/dist readable by the user but not by that
// token, causing an immediate 0x80000003 crash before main.cjs runs.
if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dist = join(root, 'node_modules', 'electron', 'dist');
  const current = spawnSync('icacls', [dist], { encoding: 'utf8', windowsHide: true });
  if (current.error || current.status !== 0) {
    console.error(`Cannot inspect Electron directory permissions: ${current.error?.message || current.stderr}`);
    process.exit(1);
  }
  if (!/S-1-15-2-1:|ALL APPLICATION PACKAGES:/i.test(current.stdout)) {
    const result = spawnSync('icacls', [dist, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/C'], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || /Failed processing [1-9]|处理 [1-9] 个文件时失败/i.test(result.stdout)) {
      console.error(`Electron AppContainer read permission failed: ${result.error?.message || result.stderr || result.stdout}`);
      process.exit(1);
    }
    console.log('Electron AppContainer read permission prepared.');
  }
}
