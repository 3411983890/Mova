'use strict';
// S3/MinIO adapter for Mova attachments.
//
// Design rules:
// - Pure Node module: no Electron import, so it can be unit tested and reused by
//   a future standalone worker.
// - The S3 client is created lazily on first use. Requiring this module never
//   touches the network and never throws because MinIO is down.
// - Every operation returns a structured result instead of throwing:
//     { ok: true, ... } | { ok: false, error: { code, message, retryable, ... } }
//   Callers (chat-images.cjs, backup/quota services) fall back to local storage.
// - Credentials never appear in results, logs, or error details.
const DEFAULTS = Object.freeze({
  endpoint: 'http://127.0.0.1:59090',
  bucket: 'mova-artifacts',
  region: 'us-east-1',
  // Development-only defaults, identical to docker-compose.yml. Real
  // deployments must override them through the environment.
  accessKey: 'mova',
  secretKey: 'mova_local_password',
  forcePathStyle: true,
  timeoutMs: 10_000,
  maxObjectBytes: 16 * 1024 * 1024,
});

const KEY_PATTERN = /^[a-z0-9][a-z0-9./_-]{0,1023}$/i;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(false|0|no|off)$/i.test(String(value));
}

function int(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Never echo a secret, a signed URL, or request credentials. */
function sanitize(value, config = {}) {
  let text = String(value ?? '');
  for (const secret of [config.secretKey, config.accessKey]) {
    if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@');
  text = text.replace(/(x-amz-signature|x-amz-credential|authorization|awsaccesskeyid|secretaccesskey|x-amz-security-token)\s*[:=]\s*[^\s&,"']*/gi, '$1=[redacted]');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Map an AWS SDK / network error onto a stable, credential-free shape.
 * Codes used by callers: not-found, bucket-missing, access-denied, unavailable,
 * timeout, storage-error.
 */
function mapStorageError(error, config = {}) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  const status = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status) || null;
  const rawCode = String(error?.Code ?? error?.code ?? '');
  let code = 'storage-error';
  let retryable = status !== null ? status >= 500 : false;
  if (['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(name) || ['NoSuchKey', 'NotFound'].includes(rawCode) || status === 404) {
    code = 'not-found';
    retryable = false;
  } else if (name === 'NoSuchBucket' || rawCode === 'NoSuchBucket') {
    code = 'bucket-missing';
    retryable = false;
  } else if (['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidBucketName'].includes(name)
    || ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch'].includes(rawCode) || status === 403) {
    code = 'access-denied';
    retryable = false;
  } else if (['TimeoutError', 'AbortError', 'RequestTimeout', 'RequestTimeoutException'].includes(name)
    || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ESOCKETTIMEDOUT'].includes(rawCode)) {
    code = 'timeout';
    retryable = true;
  } else if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'NetworkingError', 'ECONNABORTED'].includes(name)
    || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED'].includes(rawCode)) {
    code = 'unavailable';
    retryable = true;
  } else if (status === 400) {
    code = 'storage-error';
    retryable = false;
  }
  return {
    code,
    message: `object storage ${code}${status ? ` (http ${status})` : ''}`,
    name,
    retryable,
    status,
    detail: sanitize(error?.message, config),
  };
}

function errorResult(code, message, extra = {}) {
  return { ok: false, error: { code, message, retryable: false, status: null, name: 'ObjectStorage', ...extra } };
}

function validKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || !KEY_PATTERN.test(key)) return false;
  if (key.startsWith('/') || key.includes('\\') || key.endsWith('/')) return false;
  return key.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function toBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

async function bodyToBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return null;
}

function normalizeConfig(env = process.env, overrides = {}) {
  const read = (key, fallback) => overrides[key] !== undefined ? overrides[key] : env[key] !== undefined ? env[key] : fallback;
  const endpoint = String(read('endpoint', env.MOVA_S3_ENDPOINT || DEFAULTS.endpoint));
  const bucket = String(read('bucket', env.MOVA_S3_BUCKET || DEFAULTS.bucket));
  const region = String(read('region', env.MOVA_S3_REGION || DEFAULTS.region));
  const accessKey = String(read('accessKey', env.MOVA_S3_ACCESS_KEY || DEFAULTS.accessKey));
  const secretKey = String(read('secretKey', env.MOVA_S3_SECRET_KEY || DEFAULTS.secretKey));
  const enabled = bool(read('enabled', env.MOVA_S3_ENABLED), true);
  const forcePathStyle = bool(overrides.forcePathStyle ?? env.MOVA_S3_FORCE_PATH_STYLE, DEFAULTS.forcePathStyle);
  const timeoutMs = int(read('timeoutMs', env.MOVA_S3_TIMEOUT_MS), DEFAULTS.timeoutMs);
  const maxObjectBytes = int(overrides.maxObjectBytes, DEFAULTS.maxObjectBytes);
  return { endpoint, bucket, region, accessKey, secretKey, enabled, forcePathStyle, timeoutMs, maxObjectBytes };
}

function configProblem(config) {
  if (!config.enabled) return { code: 'disabled', message: 'object storage is disabled' };
  let url = null;
  try { url = new URL(config.endpoint); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    return { code: 'invalid-config', message: 'object storage endpoint is invalid' };
  }
  if (!BUCKET_PATTERN.test(config.bucket) || config.bucket.includes('..')) {
    return { code: 'invalid-config', message: 'object storage bucket name is invalid' };
  }
  if (!config.accessKey || !config.secretKey) {
    return { code: 'not-configured', message: 'object storage credentials are not configured' };
  }
  return null;
}

function defaultClientFactory(config) {
  // Lazily required so the module stays importable in tests/environments that
  // do not install the SDK, and so no client is built before it is needed.
  let S3Client;
  try {
    ({ S3Client } = require('@aws-sdk/client-s3'));
  } catch {
    throw Object.assign(new Error('sdk-missing'), { code: 'sdk-missing' });
  }
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    maxAttempts: 2,
  });
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   client?: object,                 // pre-built client (tests)
 *   createClient?: (config) => object,
 *   sdk?: object,                    // injected @aws-sdk/client-s3 exports (tests)
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 *   config?: object,                 // overrides: endpoint/bucket/region/accessKey/secretKey/enabled/timeoutMs
 * }} options
 */
function createObjectStorage(options = {}) {
  const env = options.env || process.env;
  const config = normalizeConfig(env, options.config || {});
  const logger = options.logger || null;
  const createClient = options.createClient
    || (options.client ? () => options.client : config => defaultClientFactory(config));

  let client = null;
  let clientFailure = null;
  let sdkCache = options.sdk || null;
  let lastError = null;
  let lastSuccessAt = null;

  const log = (level, message) => {
    const fn = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : null;
    if (fn) fn(`[object-storage] ${message}`);
  };

  function sdk() {
    if (sdkCache) return sdkCache;
    try {
      sdkCache = require('@aws-sdk/client-s3');
      return sdkCache;
    } catch {
      clientFailure = { code: 'sdk-missing', message: 'object storage SDK is not installed' };
      throw Object.assign(new Error('sdk-missing'), { code: 'sdk-missing' });
    }
  }

  function getClient() {
    if (clientFailure && ['sdk-missing', 'invalid-client', 'client-unavailable'].includes(clientFailure.code)) {
      throw Object.assign(new Error(clientFailure.code), { code: clientFailure.code });
    }
    if (client) return client;
    try {
      client = createClient(config);
      if (!client || typeof client.send !== 'function') {
        client = null;
        clientFailure = { code: 'invalid-client', message: 'object storage client is not usable' };
        throw Object.assign(new Error('invalid-client'), { code: 'invalid-client' });
      }
      return client;
    } catch (error) {
      if (error?.code === 'sdk-missing' || error?.code === 'invalid-client') {
        if (error.code === 'sdk-missing') clientFailure = { code: 'sdk-missing', message: 'object storage SDK is not installed' };
        throw error;
      }
      // A factory that cannot build a client is a configuration problem, not a
      // reason to crash the app; the caller falls back to local files.
      clientFailure = { code: 'client-unavailable', message: 'object storage client could not be created' };
      throw Object.assign(new Error('client-unavailable'), { code: 'client-unavailable' });
    }
  }

  function guard() {
    const problem = configProblem(config);
    if (problem) return errorResult(problem.code, problem.message);
    if (clientFailure?.code === 'sdk-missing') return errorResult(clientFailure.code, clientFailure.message);
    return null;
  }

  function note(result) {
    if (result.ok) { lastSuccessAt = new Date().toISOString(); lastError = null; }
    else {
      lastError = { code: result.error.code, message: result.error.message, at: new Date().toISOString() };
      if (result.error.code !== 'disabled') log('warn', `${result.error.code}: ${result.error.message}`);
    }
    return result;
  }

  async function send(CommandName, input) {
    const blocked = guard();
    if (blocked) return note(blocked);
    let timer = null;
    try {
      const target = getClient();
      const command = new (sdk()[CommandName])(input);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('object storage request timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' }));
        }, config.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const request = target.send(command, { abortSignal: AbortSignal.timeout(config.timeoutMs) });
      request.catch(() => {});
      const response = await Promise.race([request, timeout]);
      return note({ ok: true, response });
    } catch (error) {
      if (error?.code === 'sdk-missing') return note(errorResult('sdk-missing', 'object storage SDK is not installed'));
      if (error?.code === 'client-unavailable') return note(errorResult('client-unavailable', 'object storage client could not be created'));
      if (error?.code === 'invalid-client') return note(errorResult('invalid-client', 'object storage client is not usable'));
      return note({ ok: false, error: mapStorageError(error, config) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Upload `bytes` under `key`. Never throws. */
  async function putObject(key, bytes, contentType) {
    if (!validKey(key)) return note(errorResult('invalid-input', 'object storage key is invalid'));
    const body = toBuffer(bytes);
    if (!body) return note(errorResult('invalid-input', 'object storage body must be a Buffer or Uint8Array'));
    if (body.length > config.maxObjectBytes) return note(errorResult('object-too-large', 'object storage body is too large'));
    const type = typeof contentType === 'string' && contentType.trim() ? contentType.trim().slice(0, 120) : 'application/octet-stream';
    const result = await send('PutObjectCommand', {
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: type,
      ContentLength: body.length,
    });
    if (!result.ok) return result;
    const response = result.response;
    return note({
      ok: true,
      key,
      bucket: config.bucket,
      bytes: body.length,
      contentType: type,
      etag: response?.ETag ?? null,
      status: response?.$metadata?.httpStatusCode ?? null,
    });
  }

  /** Download `key`. Never throws; a missing object maps to error.code='not-found'. */
  async function getObject(key) {
    if (!validKey(key)) return note(errorResult('invalid-input', 'object storage key is invalid'));
    const result = await send('GetObjectCommand', { Bucket: config.bucket, Key: key });
    if (!result.ok) return result;
    const response = result.response || {};
    const bytes = await bodyToBuffer(response.Body).catch(() => null);
    if (!bytes) return note(errorResult('storage-error', 'object storage body could not be read'));
    if (bytes.length > config.maxObjectBytes) return note(errorResult('object-too-large', 'object storage body is too large'));
    return note({
      ok: true,
      key,
      bucket: config.bucket,
      bytes,
      contentType: typeof response.ContentType === 'string' ? response.ContentType : null,
      contentLength: bytes.length,
      etag: response.ETag ?? null,
    });
  }

  /** Delete `key`. A missing object is reported as ok with alreadyMissing. */
  async function deleteObject(key) {
    if (!validKey(key)) return note(errorResult('invalid-input', 'object storage key is invalid'));
    const result = await send('DeleteObjectCommand', { Bucket: config.bucket, Key: key });
    if (!result.ok && result.error.code === 'not-found') return note({ ok: true, key, bucket: config.bucket, alreadyMissing: true });
    if (!result.ok) return result;
    return note({ ok: true, key, bucket: config.bucket, status: result.response?.$metadata?.httpStatusCode ?? null });
  }

  /** Probe the bucket; used by health panels. Never throws. */
  async function headBucket() {
    const result = await send('HeadBucketCommand', { Bucket: config.bucket });
    if (!result.ok) return result;
    return note({ ok: true, bucket: config.bucket, status: result.response?.$metadata?.httpStatusCode ?? null });
  }

  async function health() {
    if (!config.enabled) return { status: 'disabled', bucket: config.bucket };
    const result = await headBucket();
    return result.ok ? { status: 'ok', bucket: config.bucket } : { status: 'down', bucket: config.bucket, error: result.error };
  }

  /** Sanitized view for logs/health: never contains credentials. */
  function describe() {
    return {
      enabled: config.enabled,
      configured: !configProblem(config),
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      timeoutMs: config.timeoutMs,
      maxObjectBytes: config.maxObjectBytes,
      credentials: { accessKey: Boolean(config.accessKey), secretKey: Boolean(config.secretKey) },
      lastError,
      lastSuccessAt,
    };
  }

  function status() {
    const problem = configProblem(config);
    return {
      ...describe(),
      ready: !problem && !clientFailure && Boolean(client),
      error: problem || clientFailure || lastError || null,
    };
  }

  return { putObject, getObject, deleteObject, headBucket, health, config: describe, status };
}

module.exports = {
  createObjectStorage,
  mapStorageError,
  sanitize,
  validKey,
  normalizeConfig,
  configProblem,
  DEFAULTS,
};
