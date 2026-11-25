'use strict';
// Chat image attachments.
//
// Storage model:
// - temporary images (temporary chat): memory only, never written to disk and
//   never uploaded to object storage.
// - persistent images: written to the local chat-images directory exactly as
//   before, then mirrored to S3/MinIO under `chat-images/<id>`.
// - reads: local file first, object storage second, memory-only temp map first
//   of all.
//
// The S3 mirror is best-effort: an upload failure or a slow/unreachable MinIO
// must never break sending an image or reading it back locally. Failures are
// tracked in status() and logged (sanitized) instead of thrown.
//
// An optional quota service (electron/services/quota.cjs) can be injected:
// persistent writes call quota.checkWrite({ bytes }) first, and a QuotaError
// (quota-exceeded / quota-unavailable) propagates unchanged so the caller can
// show a real error. Temporary images never touch the quota or object storage.
//
// This module is importable without Electron: the userData directory and the
// default object storage are resolved lazily, and createChatImages() accepts
// injected dependencies for tests.
const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { ModelError } = require('./local-model.cjs');
const { createObjectStorage } = require('./object-storage.cjs');

const MAX_BYTES = 4 * 1024 * 1024;
const KEY_PREFIX = 'chat-images/';
const TEMP_LIMIT = 64;
const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const extension = Object.fromEntries(Object.entries(types).map(([key, value]) => [value, key]));
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(id);
const keyFor = id => `${KEY_PREFIX}${id}`;
const mimeFor = id => types[String(id).split('.').at(-1)];

function matchesImage(data, ext) {
  if (ext === 'png') return data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (ext === 'jpg') return data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (ext === 'gif') return /^(GIF87a|GIF89a)$/.test(data.toString('ascii', 0, 6));
  return data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * Validate and decode a data URL attachment. Pure helper so the rules can be
 * tested without Electron or the filesystem.
 * Throws ModelError('image_size' | 'image_type') exactly like before.
 */
function decodeAttachment(attachment) {
  const source = attachment?.dataUrl;
  if (typeof source !== 'string' || source.length > Math.ceil(MAX_BYTES / 3) * 4 + 48) throw new ModelError('image_size');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match) throw new ModelError('image_type');
  const [, mimeType, base64] = match;
  const data = Buffer.from(base64, 'base64');
  if (data.length > MAX_BYTES) throw new ModelError('image_size');
  if (!matchesImage(data, extension[mimeType])) throw new ModelError('image_type');
  return { data, mimeType, id: `${createHash('sha256').update(data).digest('hex')}.${extension[mimeType]}`, base64 };
}

/** Rebuild a quota refusal for services that return { ok:false, error } instead of throwing. */
function quotaError(decision, bytes) {
  const detail = decision && typeof decision.error === 'object' && decision.error ? decision.error : {};
  const error = new Error(typeof detail.message === 'string' ? detail.message : String(detail.code || 'quota-exceeded'));
  error.name = 'QuotaError';
  error.code = typeof detail.code === 'string' ? detail.code : 'quota-exceeded';
  error.quotaBytes = detail.quotaBytes ?? decision?.quotaBytes ?? null;
  error.usedBytes = detail.usedBytes ?? decision?.usedBytes ?? null;
  error.requestedBytes = bytes;
  return error;
}

function createChatImages(options = {}) {
  const io = {
    mkdir: options.fs?.mkdir || mkdir,
    readFile: options.fs?.readFile || readFile,
    writeFile: options.fs?.writeFile || writeFile,
  };
  const storage = options.objectStorage === undefined ? null : options.objectStorage;
  const quota = options.quota || null;
  const logger = options.logger || null;
  const now = options.now || Date.now;
  const failureThreshold = Number.isSafeInteger(options.uploadFailureThreshold) && options.uploadFailureThreshold > 0
    ? options.uploadFailureThreshold : 3;
  const cooldownMs = Number.isSafeInteger(options.uploadCooldownMs) && options.uploadCooldownMs >= 0
    ? options.uploadCooldownMs : 60_000;
  const temporaryImages = new Map();
  const inflight = new Set();
  const counters = { uploads: 0, failures: 0, skipped: 0, pending: 0, consecutiveFailures: 0, openUntil: 0 };
  let lastUpload = null;
  let lastError = null;

  const log = (level, message) => {
    const fn = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : null;
    if (fn) fn(`[chat-images] ${message}`);
  };

  function directory() {
    const value = typeof options.directory === 'function' ? options.directory() : options.directory;
    if (typeof value !== 'string' || !value) throw new Error('chat-images directory is not configured');
    return value;
  }

  const breakerOpen = () => counters.openUntil > now();

  async function upload(id, bytes, mimeType) {
    if (!storage || typeof storage.putObject !== 'function') { counters.skipped++; return; }
    if (breakerOpen()) { counters.skipped++; return; }
    counters.pending++;
    try {
      const result = await storage.putObject(keyFor(id), bytes, mimeType);
      if (result?.ok) {
        counters.uploads++;
        counters.consecutiveFailures = 0;
        lastUpload = { id, key: result.key || keyFor(id), bytes: result.bytes ?? bytes.length, at: new Date(now()).toISOString() };
        return;
      }
      failure(result?.error || { code: 'upload-failed', message: 'object storage upload failed' }, id);
    } catch {
      failure({ code: 'upload-failed', message: 'object storage upload failed' }, id);
    } finally {
      counters.pending--;
    }
  }

  function failure(error, id) {
    counters.failures++;
    counters.consecutiveFailures++;
    lastError = {
      code: typeof error?.code === 'string' ? error.code : 'upload-failed',
      message: typeof error?.message === 'string' ? error.message.slice(0, 200) : 'object storage upload failed',
      id,
      at: new Date(now()).toISOString(),
    };
    log('warn', `upload ${lastError.code} for ${id} (local copy kept)`);
    if (counters.consecutiveFailures >= failureThreshold && !breakerOpen()) {
      counters.openUntil = now() + cooldownMs;
      counters.consecutiveFailures = 0;
      log('warn', `uploads paused for ${cooldownMs}ms after repeated failures; local storage only`);
    }
  }

  function track(promise) {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise)).catch(() => {});
    return promise;
  }

  async function saveImage(attachment, { temporary = false } = {}) {
    const { data, mimeType, id, base64 } = decodeAttachment(attachment);
    if (temporary) {
      // Memory only: never written to disk, never uploaded, never quota-checked.
      if (!temporaryImages.has(id) && temporaryImages.size >= TEMP_LIMIT) throw new ModelError('image_size');
      temporaryImages.set(id, { bytes: data, mimeType });
    } else {
      if (quota && typeof quota.checkWrite === 'function') {
        // Runs before the local write: a refused write leaves no file behind.
        // QuotaError (quota-exceeded / quota-unavailable / quota-invalid)
        // propagates unchanged so the IPC layer can report the real reason.
        const decision = await quota.checkWrite({ bytes: data.length });
        if (decision && decision.ok === false) {
          throw quotaError(decision, data.length);
        }
      }
      const target = directory();
      await io.mkdir(target, { recursive: true });
      await io.writeFile(join(target, id), data, { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      // Fire-and-forget mirror: a hung or unreachable MinIO can never delay the
      // local image path, and a failed upload never rolls the local file back.
      // whenSettled() exposes completion for tests/shutdown.
      track(upload(id, data, mimeType));
    }
    return { id, name: String(attachment.name || '图片').slice(0, 140), mimeType, base64 };
  }

  async function readRemote(id) {
    if (!storage || typeof storage.getObject !== 'function') return null;
    let result;
    try {
      result = await storage.getObject(keyFor(id));
    } catch {
      return null;
    }
    if (!result?.ok) {
      if (result?.error?.code && result.error.code !== 'not-found' && result.error.code !== 'disabled') {
        log('warn', `read ${result.error.code} for ${id}; no local copy`);
      }
      return null;
    }
    const bytes = Buffer.isBuffer(result.bytes) ? result.bytes
      : result.bytes instanceof Uint8Array ? Buffer.from(result.bytes) : null;
    if (!bytes || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    // Best-effort local cache so the next read is a plain file read.
    try {
      const target = directory();
      await io.mkdir(target, { recursive: true });
      await io.writeFile(join(target, id), bytes, { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    } catch { /* caching is optional; the bytes are still returned */ }
    return { bytes, mimeType: mimeFor(id) };
  }

  async function readImage(id) {
    if (!validId(id)) throw new ModelError('image_type');
    if (temporaryImages.has(id)) return temporaryImages.get(id);
    const target = directory();
    let fileError = null;
    try {
      const bytes = await io.readFile(join(target, id));
      if (bytes.length > MAX_BYTES) throw new ModelError('image_size');
      return { bytes, mimeType: mimeFor(id) };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      fileError = error;
    }
    const remote = await readRemote(id);
    if (remote) return remote;
    // Preserve the previous behaviour for missing images: callers treat the
    // rejection as "not found" (serveChatImage -> 404).
    throw fileError;
  }

  async function serveChatImage(id) {
    try {
      const { bytes, mimeType } = await readImage(id);
      return new Response(bytes, { headers: { 'Content-Type': mimeType, 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return new Response(null, { status: 404 });
    }
  }

  /** Wait for every queued S3 mirror. Used by tests and graceful shutdown. */
  async function whenSettled() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  function status() {
    return {
      enabled: Boolean(storage && typeof storage.putObject === 'function'),
      quota: Boolean(quota && typeof quota.checkWrite === 'function'),
      uploads: counters.uploads,
      failures: counters.failures,
      skipped: counters.skipped,
      pending: counters.pending,
      degraded: breakerOpen(),
      cooldownUntil: counters.openUntil ? new Date(counters.openUntil).toISOString() : null,
      lastUpload,
      lastError,
    };
  }

  function reset() {
    temporaryImages.clear();
    counters.consecutiveFailures = 0;
    counters.openUntil = 0;
  }

  return { saveImage, readImage, serveChatImage, status, whenSettled, reset, keyFor, directory };
}

// --- default instance (Electron main process) ------------------------------
let defaultInstance = null;

function defaultDirectory() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return join(app.getPath('userData'), 'chat-images');
  } catch { /* not running inside Electron (unit tests, scripts) */ }
  const base = process.env.MOVA_USER_DATA || join(process.cwd(), '.mova-runtime');
  return join(base, 'chat-images');
}

function getDefault() {
  if (!defaultInstance) {
    defaultInstance = createChatImages({
      directory: defaultDirectory,
      objectStorage: createObjectStorage({ logger: console }),
      logger: console,
    });
  }
  return defaultInstance;
}

/**
 * Replace the process-wide default instance. Main/runtime calls this once after
 * startup to inject the real quota service (and optionally object storage or a
 * different directory); without this call the lazy default stays as before.
 * Returns the new instance so callers can inspect status().
 *
 * configureDefaultChatImages({ quota, objectStorage?, directory?, logger? })
 */
function configureDefaultChatImages(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options are required');
  const logger = options.logger === undefined ? console : options.logger;
  defaultInstance = createChatImages({
    directory: options.directory === undefined ? defaultDirectory : options.directory,
    logger,
    objectStorage: options.objectStorage === undefined
      ? createObjectStorage({ logger })
      : options.objectStorage,
    quota: options.quota === undefined ? null : options.quota,
    ...(options.uploadFailureThreshold === undefined ? {} : { uploadFailureThreshold: options.uploadFailureThreshold }),
    ...(options.uploadCooldownMs === undefined ? {} : { uploadCooldownMs: options.uploadCooldownMs }),
  });
  return defaultInstance;
}

const saveImage = (attachment, options) => getDefault().saveImage(attachment, options);
const readImage = id => getDefault().readImage(id);
const serveChatImage = id => getDefault().serveChatImage(id);

/**
 * 落盘图片的绝对路径。
 *
 * 为什么要这个出口：ACP（Gemini 订阅）支路没有 image block 通道，CLI 只能自己读文件，
 * 所以必须把「图片在哪」作为文本告诉它。路径必须和 saveImage 真正写入的目录同源，
 * 否则模型拿到一个不存在的路径只会说「读不到」——这正是以前图片被静默丢弃的另一半原因。
 *
 * 不负责：临时会话的图片（只在内存里，永远没有路径；调用方按 temporary 自行判断）。
 */
const imageFilePath = id => {
  if (!validId(id)) throw new ModelError('image_type');
  return join(getDefault().directory(), id);
};

module.exports = {
  createChatImages,
  configureDefaultChatImages,
  saveImage,
  readImage,
  serveChatImage,
  imageFilePath,
  validId,
  decodeAttachment,
  keyFor,
  mimeFor,
  MAX_BYTES,
  KEY_PREFIX,
};
