import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const _sdk = require('@aws-sdk/client-s3');
const {
  createObjectStorage,
  mapStorageError,
  validKey,
  normalizeConfig,
  DEFAULTS,
} = require('../electron/object-storage.cjs');
const {
  createChatImages,
  configureDefaultChatImages,
  saveImage,
  readImage,
  serveChatImage,
  decodeAttachment,
  validId,
  keyFor,
  MAX_BYTES,
} = require('../electron/chat-images.cjs');
const { ModelError } = require('../electron/local-model.cjs');
const { createQuotaService, QuotaError } = require('../electron/services/quota.cjs');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const MIB = 1024 * 1024;
const dataUrl = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const errorCode = (fn, expected) => assert.rejects(fn, error => error.code === expected);
const ENV = {
  MOVA_S3_ENDPOINT: 'http://127.0.0.1:59090',
  MOVA_S3_BUCKET: 'mova-artifacts',
  MOVA_S3_REGION: 'us-east-1',
  MOVA_S3_ACCESS_KEY: 'test-access-key',
  MOVA_S3_SECRET_KEY: 'test-secret-key',
};

/** Fake S3 client: records commands, returns/throws whatever the test asks. */
function fakeClient(handler = {}) {
  const sent = [];
  return {
    sent,
    async send(command, options) {
      sent.push({ name: command.constructor.name, input: command.input, options });
      if (typeof handler.send === 'function') return handler.send(command, options);
      if (handler.error) throw handler.error;
      return handler.response ?? {};
    },
  };
}

function storageWith(handler = {}, extra = {}) {
  const client = fakeClient(handler);
  const storage = createObjectStorage({ env: ENV, client, logger: extra.logger, ...extra });
  return { storage, client };
}

function tmpdir(t) {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mova-attachments-')).then(async directory => {
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
  });
}

// ---------------------------------------------------------------------------
// object-storage.cjs
// ---------------------------------------------------------------------------

test('config comes from env with contract defaults and never exposes credentials', () => {
  const defaults = createObjectStorage({ env: {} });
  assert.equal(defaults.config().endpoint, 'http://127.0.0.1:59090');
  assert.equal(defaults.config().bucket, 'mova-artifacts');
  assert.equal(defaults.config().region, 'us-east-1');
  assert.equal(defaults.config().forcePathStyle, true);
  assert.equal(defaults.config().credentials.accessKey, true);
  assert.equal(defaults.config().credentials.secretKey, true);
  assert.ok(!JSON.stringify(defaults.config()).includes(DEFAULTS.secretKey));
  assert.ok(!JSON.stringify(defaults.status()).includes(DEFAULTS.secretKey));

  const custom = normalizeConfig({ ...ENV, MOVA_S3_BUCKET: 'other-bucket', MOVA_S3_TIMEOUT_MS: '1500' });
  assert.equal(custom.bucket, 'other-bucket');
  assert.equal(custom.timeoutMs, 1500);
  assert.equal(custom.accessKey, 'test-access-key');
});

test('putObject builds a PutObjectCommand with the right bucket, key, body and content type', async () => {
  const { storage, client } = storageWith({ response: { ETag: '"abc"', $metadata: { httpStatusCode: 200 } } });
  const result = await storage.putObject('chat-images/pixel.png', PNG, 'image/png');
  assert.equal(result.ok, true);
  assert.equal(result.bucket, 'mova-artifacts');
  assert.equal(result.key, 'chat-images/pixel.png');
  assert.equal(result.bytes, PNG.length);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.etag, '"abc"');
  assert.equal(result.status, 200);

  assert.equal(client.sent.length, 1);
  const [{ name, input, options }] = client.sent;
  assert.equal(name, 'PutObjectCommand');
  assert.equal(input.Bucket, 'mova-artifacts');
  assert.equal(input.Key, 'chat-images/pixel.png');
  assert.equal(Buffer.compare(input.Body, PNG), 0);
  assert.equal(input.ContentType, 'image/png');
  assert.equal(input.ContentLength, PNG.length);
  assert.ok(options.abortSignal instanceof AbortSignal);
});

test('getObject returns bytes and content type; maps a missing key to not-found', async () => {
  const body = { transformToByteArray: async () => new Uint8Array(PNG) };
  const { storage, client } = storageWith({ response: { Body: body, ContentType: 'image/png', ETag: '"e"' } });
  const found = await storage.getObject('chat-images/pixel.png');
  assert.equal(found.ok, true);
  assert.equal(Buffer.compare(found.bytes, PNG), 0);
  assert.equal(found.contentType, 'image/png');
  assert.equal(client.sent[0].name, 'GetObjectCommand');

  const missing = storageWith({ error: Object.assign(new Error('no key'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }) });
  const notFound = await missing.storage.getObject('chat-images/gone.png');
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error.code, 'not-found');
  assert.equal(notFound.error.retryable, false);
});

test('deleteObject and headBucket construct the expected commands', async () => {
  const { storage, client } = storageWith({ response: { $metadata: { httpStatusCode: 204 } } });
  assert.equal((await storage.deleteObject('chat-images/pixel.png')).ok, true);
  assert.equal((await storage.headBucket()).ok, true);
  assert.deepEqual(client.sent.map(entry => entry.name), ['DeleteObjectCommand', 'HeadBucketCommand']);
  assert.equal(client.sent[0].input.Key, 'chat-images/pixel.png');
  assert.equal(client.sent[1].input.Bucket, 'mova-artifacts');

  const missing = storageWith({ error: Object.assign(new Error('gone'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }) });
  const deleted = await missing.storage.deleteObject('chat-images/gone.png');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.alreadyMissing, true);
});

test('error mapping covers not-found, bucket, access, network, timeout and generic failures', async () => {
  const cases = [
    [{ name: 'NoSuchBucket', message: 'bucket missing' }, 'bucket-missing', false],
    [{ name: 'AccessDenied', message: 'denied', $metadata: { httpStatusCode: 403 } }, 'access-denied', false],
    [{ name: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:59090' }, 'unavailable', true],
    [{ name: 'NetworkingError', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND minio' }, 'unavailable', true],
    [{ name: 'TimeoutError', message: 'socket timeout' }, 'timeout', true],
    [{ name: 'InternalError', message: 'boom', $metadata: { httpStatusCode: 500 } }, 'storage-error', true],
    [{ name: 'InvalidArgument', message: 'bad', $metadata: { httpStatusCode: 400 } }, 'storage-error', false],
  ];
  for (const [error, code, retryable] of cases) {
    const { storage } = storageWith({ error });
    const result = await storage.headBucket();
    assert.equal(result.ok, false, `${error.name} must fail`);
    assert.equal(result.error.code, code, `${error.name} -> ${code}`);
    assert.equal(result.error.retryable, retryable, `${error.name} retryable`);
  }
  assert.equal(mapStorageError(new Error('plain')).code, 'storage-error');
});

test('errors and logs never contain credentials or signed URL secrets', async () => {
  const lines = [];
  const logger = { warn: line => lines.push(String(line)), info: line => lines.push(String(line)) };
  const leaky = Object.assign(
    new Error('Authorization: AWS4-HMAC-SHA256 Credential=test-access-key/20260101 X-Amz-Signature=deadbeef secret=test-secret-key'),
    { name: 'SignatureDoesNotMatch', $metadata: { httpStatusCode: 403 } },
  );
  const { storage } = storageWith({ error: leaky }, { logger });
  const result = await storage.putObject('chat-images/pixel.png', PNG, 'image/png');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'access-denied');
  const printed = JSON.stringify({ result, lines, status: storage.status() });
  assert.ok(!printed.includes('test-secret-key'));
  assert.ok(!printed.includes('test-access-key'));
  assert.ok(!printed.includes('deadbeef'));
  assert.ok(!printed.includes('AWS4-HMAC'));
  assert.equal(lines.length, 1);
});

test('the S3 client is built lazily, once, and only when object storage is enabled', async () => {
  let built = 0;
  const client = fakeClient({ response: { $metadata: { httpStatusCode: 200 } } });
  const storage = createObjectStorage({ env: ENV, createClient: () => { built += 1; return client; } });
  assert.equal(built, 0);
  await storage.putObject('chat-images/a.png', PNG, 'image/png');
  await storage.putObject('chat-images/b.png', PNG, 'image/png');
  assert.equal(built, 1);
  assert.equal(storage.status().ready, true);

  let disabledBuilt = 0;
  const disabled = createObjectStorage({
    env: { ...ENV, MOVA_S3_ENABLED: 'false' },
    createClient: () => { disabledBuilt += 1; return client; },
  });
  const result = await disabled.headBucket();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'disabled');
  assert.equal(disabledBuilt, 0);
  assert.equal((await disabled.health()).status, 'disabled');
});

test('a missing SDK or unusable client yields a structured error instead of throwing', async () => {
  const missing = createObjectStorage({
    env: ENV,
    createClient: () => { throw Object.assign(new Error('sdk-missing'), { code: 'sdk-missing' }); },
  });
  const result = await missing.getObject('chat-images/pixel.png');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'sdk-missing');

  const unusable = createObjectStorage({ env: ENV, createClient: () => ({}) });
  const second = await unusable.putObject('chat-images/pixel.png', PNG, 'image/png');
  assert.equal(second.error.code, 'invalid-client');
  assert.equal((await unusable.headBucket()).error.code, 'invalid-client');
});

test('input validation and size limits are structured errors', async () => {
  const { storage, client } = storageWith({ response: {} });
  for (const key of ['', '/absolute.png', 'a/../b.png', 'has\\backslash.png', 'space key.png', 'x'.repeat(1030)]) {
    assert.equal((await storage.putObject(key, PNG, 'image/png')).error.code, 'invalid-input', key);
  }
  assert.equal((await storage.putObject('ok.png', 'a string', 'image/png')).error.code, 'invalid-input');
  assert.equal(validKey('chat-images/abc.png'), true);
  assert.equal(validKey('chat-images/abc.png/'), false);
  assert.equal(client.sent.length, 0);

  const small = createObjectStorage({ env: ENV, client: fakeClient(), config: { maxObjectBytes: 4 } });
  assert.equal((await small.putObject('chat-images/pixel.png', PNG, 'image/png')).error.code, 'object-too-large');
});

test('a hung request times out with a retryable error instead of blocking', async () => {
  const storage = createObjectStorage({
    env: ENV,
    client: { send: () => new Promise(() => {}) },
    config: { timeoutMs: 20 },
  });
  const result = await storage.headBucket();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.equal(result.error.retryable, true);
});

// ---------------------------------------------------------------------------
// chat-images.cjs (attachment path + S3 mirror)
// ---------------------------------------------------------------------------

test('chat-images module loads without Electron; helpers keep the original validation', () => {
  assert.equal(typeof createChatImages, 'function');
  assert.equal(validId(`${'a'.repeat(64)}.png`), true);
  assert.equal(validId('../a.png'), false);
  assert.equal(validId(`${'A'.repeat(64)}.png`), false);
  const decoded = decodeAttachment({ dataUrl: dataUrl(PNG), name: 'pixel' });
  assert.equal(decoded.mimeType, 'image/png');
  assert.match(decoded.id, /^[a-f0-9]{64}\.png$/);
  assert.equal(keyFor(decoded.id), `chat-images/${decoded.id}`);
  assert.throws(() => decodeAttachment({ dataUrl: 'data:image/svg+xml;base64,AAAA' }), error => error instanceof ModelError && error.code === 'image_type');
  assert.throws(() => decodeAttachment({ dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 49)}` }), error => error.code === 'image_size');
  assert.throws(() => decodeAttachment({}), error => error.code === 'image_size');
});

test('persistent images are written locally and mirrored to S3 under chat-images/<id>', async t => {
  const directory = await tmpdir(t);
  const { storage, client } = storageWith({ response: { $metadata: { httpStatusCode: 200 } } });
  const images = createChatImages({ directory, objectStorage: storage });
  const saved = await images.saveImage({ dataUrl: dataUrl(PNG), name: 'pixel' });
  await images.whenSettled();

  const local = await fs.readFile(path.join(directory, saved.id));
  assert.equal(Buffer.compare(local, PNG), 0);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].name, 'PutObjectCommand');
  assert.equal(client.sent[0].input.Key, `chat-images/${saved.id}`);
  assert.equal(client.sent[0].input.ContentType, 'image/png');
  assert.equal(images.status().uploads, 1);
  assert.equal(images.status().failures, 0);
  assert.deepEqual(Object.keys(saved).sort(), ['base64', 'id', 'mimeType', 'name']);
  assert.equal(saved.base64, PNG.toString('base64'));
});

test('temporary images stay in memory: no file, no upload', async t => {
  const directory = await tmpdir(t);
  const { storage, client } = storageWith({ response: {} });
  const images = createChatImages({ directory, objectStorage: storage });
  const saved = await images.saveImage({ dataUrl: dataUrl(PNG), name: 'temp' }, { temporary: true });
  await images.whenSettled();
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(client.sent.length, 0);
  assert.equal(images.status().skipped, 0);
  const read = await images.readImage(saved.id);
  assert.equal(Buffer.compare(read.bytes, PNG), 0);
  assert.equal(read.mimeType, 'image/png');
});

test('upload failure never breaks the local image path and is logged without secrets', async t => {
  const directory = await tmpdir(t);
  const lines = [];
  const { storage } = storageWith({ error: Object.assign(new Error('connect ECONNREFUSED test-secret-key'), { name: 'ECONNREFUSED' }) });
  const images = createChatImages({ directory, objectStorage: storage, logger: { warn: line => lines.push(String(line)) } });
  const saved = await images.saveImage({ dataUrl: dataUrl(PNG), name: 'pixel' });
  await images.whenSettled();

  assert.equal((await fs.readFile(path.join(directory, saved.id))).length, PNG.length);
  const read = await images.readImage(saved.id);
  assert.equal(Buffer.compare(read.bytes, PNG), 0);
  const status = images.status();
  assert.equal(status.failures, 1);
  assert.equal(status.uploads, 0);
  assert.equal(status.lastError.code, 'unavailable');
  assert.ok(lines.some(line => line.includes('chat-images')));
  assert.ok(!JSON.stringify(lines).includes('test-secret-key'));
});

test('readImage prefers the local file and falls back to S3 when it is missing', async t => {
  const directory = await tmpdir(t);
  const { storage, client } = storageWith({
    send: command => command.constructor.name === 'GetObjectCommand'
      ? { Body: { transformToByteArray: async () => new Uint8Array(PNG) }, ContentType: 'image/png' }
      : { $metadata: { httpStatusCode: 200 } },
  });
  const images = createChatImages({ directory, objectStorage: storage });
  const id = `${'b'.repeat(64)}.png`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, id), PNG);

  const local = await images.readImage(id);
  assert.equal(Buffer.compare(local.bytes, PNG), 0);
  assert.equal(client.sent.filter(entry => entry.name === 'GetObjectCommand').length, 0);

  await fs.rm(path.join(directory, id));
  const remote = await images.readImage(id);
  assert.equal(Buffer.compare(remote.bytes, PNG), 0);
  assert.equal(client.sent.at(-1).name, 'GetObjectCommand');
  assert.equal(client.sent.at(-1).input.Key, `chat-images/${id}`);
  // Remote bytes are cached locally for the next read.
  assert.equal((await fs.readFile(path.join(directory, id))).length, PNG.length);
});

test('serveChatImage returns 404 when neither local nor remote bytes exist', async t => {
  const directory = await tmpdir(t);
  const { storage } = storageWith({ error: Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }) });
  const images = createChatImages({ directory, objectStorage: storage });
  const missing = await images.serveChatImage(`${'c'.repeat(64)}.png`);
  assert.equal(missing.status, 404);
  await errorCode(() => images.readImage(`${'c'.repeat(64)}.png`), 'ENOENT');

  const saved = await images.saveImage({ dataUrl: dataUrl(PNG) });
  const served = await images.serveChatImage(saved.id);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('repeated upload failures open a cooldown breaker instead of retrying every image', async t => {
  const directory = await tmpdir(t);
  let clock = 1_000;
  const { storage, client } = storageWith({ error: Object.assign(new Error('down'), { name: 'ECONNREFUSED' }) });
  const images = createChatImages({ directory, objectStorage: storage, now: () => clock, uploadCooldownMs: 60_000 });
  for (let i = 0; i < 3; i++) await images.saveImage({ dataUrl: dataUrl(Buffer.concat([PNG, Buffer.from(String(i))])) });
  await images.whenSettled();
  assert.equal(client.sent.length, 3);
  assert.equal(images.status().degraded, true);

  await images.saveImage({ dataUrl: dataUrl(Buffer.concat([PNG, Buffer.from('fourth')])) });
  await images.whenSettled();
  assert.equal(client.sent.length, 3);
  assert.ok(images.status().skipped >= 1);

  clock += 60_001;
  assert.equal(images.status().degraded, false);
});

test('temporary images are capped at 64 entries and never touch the uploader', async t => {
  const directory = await tmpdir(t);
  const { storage, client } = storageWith({ response: {} });
  const images = createChatImages({ directory, objectStorage: storage });
  for (let i = 0; i < 64; i++) await images.saveImage({ dataUrl: dataUrl(Buffer.concat([PNG, Buffer.from(`t${i}`)])) }, { temporary: true });
  await errorCode(
    () => images.saveImage({ dataUrl: dataUrl(Buffer.concat([PNG, Buffer.from('overflow')])) }, { temporary: true }),
    'image_size',
  );
  assert.equal(client.sent.length, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('saveImage still rejects oversized or malformed attachments before writing anything', async t => {
  const directory = await tmpdir(t);
  const images = createChatImages({ directory, objectStorage: null });
  await errorCode(() => images.saveImage({ dataUrl: 'data:image/bmp;base64,AAAA' }), 'image_type');
  await errorCode(() => images.saveImage({ dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 49)}` }), 'image_size');
  const wrongMagic = Buffer.from('not a png at all');
  await errorCode(() => images.saveImage({ dataUrl: dataUrl(wrongMagic) }), 'image_type');
  assert.deepEqual(await fs.readdir(directory), []);
});

// ---------------------------------------------------------------------------
// chat-images.cjs + quota service (real enforcement hook)
// ---------------------------------------------------------------------------

function quotaService({ directory, databaseBytes = 0, quotaBytes = 10 * MIB, databaseDown = false }) {
  return createQuotaService({
    query: async () => {
      if (databaseDown) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      return { rows: [{ bytes: String(databaseBytes) }] };
    },
    directory,
    settingsProvider: () => ({ quotaBytes }),
  });
}

test('a quota refusal happens before the persistent write: no file, no upload, code propagated', async t => {
  const directory = await tmpdir(t);
  const { storage, client } = storageWith({ response: { $metadata: { httpStatusCode: 200 } } });
  const quota = quotaService({ directory, quotaBytes: 8 });
  const images = createChatImages({ directory, objectStorage: storage, quota });
  assert.equal(images.status().quota, true);

  await assert.rejects(() => images.saveImage({ dataUrl: dataUrl(PNG) }), rejection => {
    assert.equal(rejection.code, 'quota-exceeded');
    assert.equal(rejection.quotaBytes, 8);
    assert.equal(rejection.requestedBytes, PNG.length);
    assert.equal(rejection.usedBytes, 0);
    return true;
  });
  await images.whenSettled();
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(client.sent.length, 0);
  assert.equal(images.status().uploads, 0);
});

test('quota-unavailable propagates unchanged and writes nothing', async t => {
  const directory = await tmpdir(t);
  const quota = quotaService({ directory, quotaBytes: 10 * MIB, databaseDown: true });
  const images = createChatImages({ directory, objectStorage: null, quota });
  await assert.rejects(() => images.saveImage({ dataUrl: dataUrl(PNG) }), rejection => {
    assert.ok(rejection instanceof QuotaError);
    assert.equal(rejection.code, 'quota-unavailable');
    return true;
  });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('temporary images bypass quota entirely', async t => {
  const directory = await tmpdir(t);
  let calls = 0;
  const quota = { checkWrite: async () => { calls += 1; throw new QuotaError('quota-exceeded'); } };
  const images = createChatImages({ directory, objectStorage: null, quota });
  const saved = await images.saveImage({ dataUrl: dataUrl(PNG) }, { temporary: true });
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await images.readImage(saved.id)).bytes.length, PNG.length);
});

test('quota.checkWrite is called with the exact attachment size before upload', async t => {
  const directory = await tmpdir(t);
  const seen = [];
  const quota = { checkWrite: async input => { seen.push(input); return { ok: true, allowed: true, quotaBytes: 0, unlimited: true }; } };
  const images = createChatImages({ directory, objectStorage: null, quota });
  const saved = await images.saveImage({ dataUrl: dataUrl(PNG) });
  assert.deepEqual(seen, [{ bytes: PNG.length }]);
  assert.deepEqual(await fs.readdir(directory), [saved.id]);
});

test('a quota pass with a failing S3 upload keeps the local file (no rollback)', async t => {
  const directory = await tmpdir(t);
  const { storage } = storageWith({ error: Object.assign(new Error('down'), { name: 'ECONNREFUSED' }) });
  const quota = quotaService({ directory, quotaBytes: 10 * MIB });
  const images = createChatImages({ directory, objectStorage: storage, quota });
  const saved = await images.saveImage({ dataUrl: dataUrl(PNG) });
  await images.whenSettled();
  assert.equal((await fs.readFile(path.join(directory, saved.id))).length, PNG.length);
  assert.equal(images.status().failures, 1);
  assert.equal((await images.readImage(saved.id)).bytes.length, PNG.length);
});

test('configureDefaultChatImages injects the runtime quota service into the default instance', async t => {
  const directory = await tmpdir(t);
  const seen = [];
  const quota = { checkWrite: async input => { seen.push(input); return { ok: true, allowed: true, quotaBytes: 0, unlimited: true }; } };
  const { storage, client } = storageWith({ response: { $metadata: { httpStatusCode: 200 } } });
  const instance = configureDefaultChatImages({ directory, objectStorage: storage, quota, logger: null });
  assert.equal(instance.status().quota, true);
  assert.equal(instance.status().enabled, true);

  const saved = await saveImage({ dataUrl: dataUrl(PNG), name: 'default' });
  await instance.whenSettled();
  assert.deepEqual(seen, [{ bytes: PNG.length }]);
  assert.equal((await readImage(saved.id)).bytes.length, PNG.length);
  assert.equal((await serveChatImage(saved.id)).status, 200);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].input.Key, `chat-images/${saved.id}`);

  // Restore a plain default (local only) so exported helpers stay inert afterwards.
  configureDefaultChatImages({ directory, objectStorage: null, quota: null, logger: null });
  assert.equal(typeof configureDefaultChatImages, 'function');
});
