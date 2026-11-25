#!/usr/bin/env node
/**
 * 负责：解析 Linux CLI 命令，启动服务、请求管理接口或运行浏览器诊断。
 * 被谁调用：终端里的 node scripts/mova.mjs。
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openHeadlessInspection } from '../electron/browser/headless.mjs';
import { buildSkillRuntime } from '../electron/skills/index.mjs';
import { createHandlers } from '../electron/skills/packs/browser-automation/handlers.mjs';
import { manifest } from '../electron/skills/packs/browser-automation/manifest.mjs';
import { serveHealth } from './mova-health.mjs';
import { runCloudCommand } from './mova-control.mjs';

const usage = [
  'mova browser inspect <https-url> [--screenshot <png-path>]',
  'mova serve [--port <port>]',
  'mova chat [prompt] [--provider research|api|codex|gemini] [--conversation <id>] [--model <id>] [--research]',
  'mova task submit <prompt> [--provider <type>] [--model <id>] [--bot <id>] [--conversation <id>] [--id <key>] [--research]',
  'mova task list | watch <id> [--after <cursor>] | cancel <id> | retry <id>',
  'mova project list | profiles | show <id> | save <id> <json> | import-tool <id> <json>',
  'mova task submit <prompt> --project <id>',
  'mova bot list | import <file>',
  'mova pair code [--role owner|client] | devices list | devices revoke <id>',
  'mova vpn status | vpn apply <file> | model status <codex|gemini> | model login <codex|gemini>',
  'mova doctor | backup <file> | restore <file>',
].join('\n');

async function call(runtime, name, args, signal) {
  const result = await runtime.invoke(name, args, { signal });
  const text = result.content.find(part => part.type === 'text')?.text;
  if (result.isError) throw new Error(JSON.parse(text).message);
  return { payload: JSON.parse(text), image: result.content.find(part => part.type === 'image') };
}

async function inspect(url, output, signal) {
  const browser = await openHeadlessInspection({ url, binary: process.env.MOVA_BROWSER_BIN || undefined, signal });
  try {
    const runtime = buildSkillRuntime({
      packs: [{ manifest, createHandlers }],
      deps: {
        browser: browser.tools,
        permissions: { checkRootless: ({ capability }) => ({ ok: capability === 'browser' }) },
        // A user typed this exact URL into the CLI. The browser host also pins the origin.
        approvals: { ask: request => request.method === 'skill/browser_navigate' },
      },
    });
    const page = await call(runtime, 'browser_navigate', { url, observe: 'none' }, signal);
    const snapshot = await call(runtime, 'browser_snapshot', { mode: 'full', maxChars: 3000, frames: 'none' }, signal);
    const article = await call(runtime, 'browser_read', { maxChars: 3500, includeLinks: false }, signal);
    if (output) {
      const { image } = await call(runtime, 'browser_screenshot', { mode: 'viewport' }, signal);
      if (!image?.data) throw new Error('浏览器没有返回截图');
      await writeFile(output, Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    return { ...page.payload, snapshot: snapshot.payload.text, text: article.payload.text, ...(output ? { screenshot: output } : {}) };
  } finally {
    await browser.close();
  }
}

const controller = new AbortController();
const cancel = () => controller.abort(new Error('已退出当前 CLI 命令'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { screenshot: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' }, research: { type: 'boolean' },
      ...Object.fromEntries(['provider', 'model', 'bot', 'conversation', 'project', 'id', 'after', 'role'].map(name => [name, { type: 'string' }])) },
  });
  const [area, action, url] = positionals;
  if (values.help) console.log(usage);
  else if (area === 'serve' && positionals.length === 1 && values.screenshot === undefined) {
    await serveHealth(values.port, controller.signal);
  }
  else if (area === 'browser') {
    if (positionals.length !== 3 || action !== 'inspect' || !url || values.port !== undefined) throw new Error(usage);
    const result = await inspect(url, values.screenshot ? resolve(values.screenshot) : undefined, controller.signal);
    console.log(JSON.stringify(result, null, 2));
  } else if (area) await runCloudCommand(positionals, values, controller.signal);
  else console.log(usage);
} catch (error) {
  console.error(error.message);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
