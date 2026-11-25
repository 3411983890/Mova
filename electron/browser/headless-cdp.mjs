/**
 * 负责：启动临时 Chromium 实例，通过进程管道发送 CDP 调用并回收子进程。
 * 不负责：网页访问策略、工具选择或结果呈现。
 * 被谁调用：headless.mjs。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import cdpModule from './cdp.cjs';

const { CdpError, DEFAULT_TIMEOUT } = cdpModule;
const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;

function createPipeClient(child, signal) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  const pending = new Map();
  let nextId = 1;
  let tail = '';
  let stopped;

  function stop(error) {
    stopped ??= error;
    for (const request of pending.values()) request.reject(stopped);
    pending.clear();
  }

  function onData(chunk) {
    tail += chunk;
    if (tail.length > MAX_MESSAGE_CHARS) {
      stop(new CdpError('message-too-large', 'CDP message exceeds the Linux browser limit'));
      return;
    }
    const frames = tail.split('\0');
    tail = frames.pop();
    for (const frame of frames) {
      const message = JSON.parse(frame);
      const request = pending.get(message.id);
      if (!request) continue;
      if (message.error) request.reject(new CdpError('cdp-error', message.error.message));
      else request.resolve(message.result ?? {});
    }
  }

  fromBrowser.setEncoding('utf8');
  fromBrowser.on('data', chunk => {
    if (stopped) return;
    try { onData(chunk); } catch { stop(new CdpError('invalid-message', 'Invalid CDP pipe frame')); }
  });
  fromBrowser.once('end', () => stop(new CdpError('browser-exited', '浏览器已退出')));
  for (const stream of [child, toBrowser, fromBrowser]) stream.on('error', stop);
  const onAbort = () => stop(signal.reason ?? new CdpError('cancelled', '浏览器诊断已取消'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.once('close', () => signal?.removeEventListener('abort', onAbort));

  async function send(method, params = {}, ms = DEFAULT_TIMEOUT, sessionId) {
    if (stopped) throw stopped;
    const id = nextId++;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new CdpError('timeout', `CDP timeout: ${method}`)), ms);
        toBrowser.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  return { send };
}

function signalProcessGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForClose(closed, ms) {
  const timer = new AbortController();
  try { return await Promise.race([closed.then(() => true), delay(ms, false, { signal: timer.signal })]); }
  finally { timer.abort(); }
}

export async function startHeadlessCdp({ binary, proxy, signal }) {
  if (process.platform !== 'linux' || process.getuid() === 0) {
    throw new Error('请在 Linux 普通用户下运行无头浏览器');
  }
  signal?.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), 'mova-browser-'));
  const child = spawn(binary, [
    `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--window-size=960,640',
    `--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true });
  const client = createPipeClient(child, signal);
  const closed = new Promise(resolve => child.once('close', resolve));

  async function close() {
    try {
      await client.send('Browser.close', {}, 750).catch(() => {});
      if (await waitForClose(closed, 750)) return;
      signalProcessGroup(child.pid, 'SIGTERM');
      if (await waitForClose(closed, 1000)) return;
      signalProcessGroup(child.pid, 'SIGKILL');
      await waitForClose(closed, 1000);
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 2 });
    }
  }

  return { ...client, close };
}
