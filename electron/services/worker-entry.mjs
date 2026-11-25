#!/usr/bin/env node
/**
 * Mova background worker entry (spawned by the Electron main process).
 *
 * Contract: Mova服务版接口约定.md §1 and §8.
 *
 * Responsibilities:
 *  - read the Redis URL + handler module from env/argv (never from Electron),
 *  - start BullMQ Workers through `createWorkerService` for the injected
 *    handlers (memory-extract / memory-index / backup / session-sync),
 *  - report readiness to the parent over the child-process IPC channel so the
 *    main process can restart the worker if it exits,
 *  - shut down cleanly on SIGTERM/SIGINT/`disconnect`, closing workers (and with
 *    them in-flight jobs finish before exit as far as BullMQ allows).
 *
 * Deliberately NOT here: Dot queues, Dot workers, job schedulers, Electron
 * imports, or any handler implementation. The handlers are injected via
 * `MOVA_WORKER_HANDLER_MODULE` (a module path) so this process stays decoupled
 * from main/renderer code.
 *
 * Usage (main process spawn target):
 *   MOVA_REDIS_URL=redis://127.0.0.1:56379 \
 *   MOVA_WORKER_HANDLER_MODULE=C:\...\electron\services\handlers.mjs \
 *   node electron/services/worker-entry.mjs
 * Or: node electron/services/worker-entry.mjs --handlers <path> --redis <url> --concurrency 2
 *
 * Handler module shape (either is accepted):
 *   export const handlers = { memoryExtract: async (job, ctx) => {}, ... };
 *   export default { memoryExtract: ..., memoryIndex: ..., backup: ..., sessionSync: ... };
 * Handlers are keyed by queue key (`memoryExtract`) or queue name
 * (`mova-memory-extract`).
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import queueModule from './queue.cjs';

const { createWorkerService, QueueServiceError, QUEUES, QUEUE_KEYS } = queueModule;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [flag, inline] = token.slice(2).split('=');
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) out[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      out[key] = argv[index + 1];
      index += 1;
    } else out[key] = true;
  }
  return out;
}

function loggerFrom(stream = process.stderr) {
  // Worker logs are line-delimited JSON on stderr; the parent decides where they
  // go. Never include job payloads (they can contain conversation text).
  const write = (level, message, fields) => {
    try {
      stream.write(`${JSON.stringify({ at: new Date().toISOString(), level, scope: 'mova-worker', message, ...(fields ?? {}) })}\n`);
    } catch {}
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

async function loadHandlers(modulePath) {
  if (!modulePath) return null;
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
  const loaded = await import(pathToFileURL(resolved).href);
  const candidate = loaded.handlers ?? loaded.default ?? loaded;
  if (!candidate || typeof candidate !== 'object') return null;
  const handlers = {};
  for (const key of QUEUE_KEYS) {
    const direct = candidate[key];
    const named = candidate[QUEUES[key]];
    const handler = typeof direct === 'function' ? direct : typeof named === 'function' ? named : null;
    if (handler) handlers[key] = handler;
  }
  return handlers;
}

function send(message) {
  if (typeof process.send === 'function' && process.connected) {
    try {
      process.send(message);
    } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logger = loggerFrom();
  const env = process.env;
  const redisUrl = args.redis || env.MOVA_REDIS_URL || null;
  const handlerPath = args.handlers || env.MOVA_WORKER_HANDLER_MODULE || null;
  const concurrency = args.concurrency ? Number(args.concurrency) : env.MOVA_WORKER_CONCURRENCY ? Number(env.MOVA_WORKER_CONCURRENCY) : 1;

  if (!redisUrl) {
    logger.error('worker.misconfigured', { reason: 'missing-redis-url', hint: 'set MOVA_REDIS_URL' });
    send({ type: 'worker:error', code: 'redis-missing' });
    process.exit(2);
  }
  if (!handlerPath) {
    logger.error('worker.misconfigured', { reason: 'missing-handler-module', hint: 'set MOVA_WORKER_HANDLER_MODULE to a module exporting handlers' });
    send({ type: 'worker:error', code: 'handlers-missing' });
    process.exit(2);
  }

  let handlers;
  try {
    handlers = await loadHandlers(handlerPath);
  } catch (error) {
    logger.error('worker.handlers-failed', { message: String(error?.message ?? error).slice(0, 300) });
    send({ type: 'worker:error', code: 'handlers-failed' });
    process.exit(2);
  }
  if (!handlers || !Object.keys(handlers).length) {
    logger.error('worker.handlers-empty', { module: handlerPath });
    send({ type: 'worker:error', code: 'handlers-empty' });
    process.exit(2);
  }

  // Diagnostic mode for the main process / ops: validate config + handlers and
  // exit without opening Redis connections or processing jobs.
  if (args.dryRun || env.MOVA_WORKER_DRY_RUN === '1') {
    const queues = QUEUE_KEYS.filter(key => typeof handlers[key] === 'function').map(key => QUEUES[key]);
    logger.info('worker.dry-run', { queues, handlers: Object.keys(handlers) });
    send({ type: 'worker:dry-run', queues });
    process.exit(0);
  }

  let service;
  try {
    service = createWorkerService({
      redisUrl,
      handlers,
      logger,
      concurrency: Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1,
    });
  } catch (error) {
    const code = error instanceof QueueServiceError ? error.code : 'worker-start-failed';
    logger.error('worker.start-failed', { code, message: String(error?.message ?? error).slice(0, 300) });
    send({ type: 'worker:error', code });
    process.exit(1);
  }

  send({ type: 'worker:ready', pid: process.pid, queues: service.queues, missingHandlers: service.missingHandlers });
  logger.info('worker.ready', { queues: service.queues, concurrency });

  let shuttingDown = false;
  const shutdown = async (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker.stopping', { reason });
    const timer = setTimeout(() => {
      logger.error('worker.stop-timeout', { reason });
      process.exit(exitCode || 1);
    }, 15_000);
    if (timer.unref) timer.unref();
    try {
      await service.close();
    } catch (error) {
      logger.warn('worker.close-failed', { message: String(error?.message ?? error).slice(0, 300) });
    }
    clearTimeout(timer);
    send({ type: 'worker:stopped', reason });
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('disconnect', () => void shutdown('parent-disconnect', 0));
  process.on('unhandledRejection', reason => {
    logger.error('worker.unhandled-rejection', { message: String(reason?.message ?? reason).slice(0, 300) });
  });
  process.on('uncaughtException', error => {
    logger.error('worker.uncaught-exception', { message: String(error?.message ?? error).slice(0, 300) });
    void shutdown('uncaught-exception', 1);
  });
}

void main();
