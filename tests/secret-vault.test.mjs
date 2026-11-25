import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDecipheriv, scryptSync } from 'node:crypto';

const require = createRequire(import.meta.url);
const {
  createSecretVault,
  VaultError,
  SQL,
  SCRYPT,
  KINDS,
} = require('../electron/services/secret-vault.cjs');

const OWNER = '00000000-0000-4000-8000-000000000001';
const PASS = 'correct horse battery staple';
const NEXT_PASS = 'another fine vault passphrase';
const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
const iso = ms => new Date(ms).toISOString();

/**
 * In-memory stand-in for `mova_vault` (one row per owner). Dispatches on the
 * statement keyword so the test is independent of SQL formatting, and exposes
 * the raw rows so ciphertext can be inspected directly.
 */
function fakeTable() {
  const rows = new Map();
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (query.failWith) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const statement = sql.trim().split(/\s+/)[0].toLowerCase();
    if (statement === 'select') {
      const row = rows.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (statement === 'insert') {
      const [ownerId, salt, nonce, tag, ciphertext] = params;
      if (rows.has(ownerId)) return { rows: [], rowCount: 0 };
      rows.set(ownerId, { owner_id: ownerId, salt, nonce, tag, ciphertext, updated_at: new Date().toISOString() });
      return { rows: [{ owner_id: ownerId }], rowCount: 1 };
    }
    if (statement === 'update') {
      const [ownerId, salt, nonce, tag, ciphertext] = params;
      if (!rows.has(ownerId)) return { rows: [], rowCount: 0 };
      rows.set(ownerId, { owner_id: ownerId, salt, nonce, tag, ciphertext, updated_at: new Date().toISOString() });
      return { rows: [{ owner_id: ownerId }], rowCount: 1 };
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  query.rows = rows;
  query.calls = calls;
  query.failWith = false;
  return query;
}

const vaultError = (fn, expected) => assert.rejects(fn, error => error instanceof VaultError && error.code === expected);

/**
 * Independently decrypt the stored envelope (no service internals), which both
 * checks the documented blob format and lets tests inspect createdAt.
 */
function decryptRow(row, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(row.salt, 'base64'), 32, {
    N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'base64'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]);
    try {
      return JSON.parse(plain.toString('utf8'));
    } finally {
      plain.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

function makeVault(options = {}) {
  const query = options.query || fakeTable();
  let clock = options.clock ?? T0;
  const vault = createSecretVault({ query, ownerId: OWNER, now: () => clock });
  return { query, vault, tick: (ms = 60_000) => { clock += ms; } };
}

// ---------------------------------------------------------------------------
// Setup and status
// ---------------------------------------------------------------------------

test('setup creates an empty vault and status reports configured/unlocked/count', async () => {
  const { query, vault } = makeVault();
  assert.deepEqual(await vault.status(), { configured: false, unlocked: false, count: 0 });

  assert.deepEqual(await vault.setup(PASS), { configured: true, unlocked: true, count: 0 });
  assert.deepEqual(await vault.status(), { configured: true, unlocked: true, count: 0 });
  assert.equal(query.rows.size, 1);

  const row = query.rows.get(OWNER);
  assert.deepEqual(Object.keys(row).sort(), ['ciphertext', 'nonce', 'owner_id', 'salt', 'tag', 'updated_at']);
  assert.equal(Buffer.from(row.salt, 'base64').length, 16);
  assert.equal(Buffer.from(row.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(row.tag, 'base64').length, 16);
  assert.ok(Buffer.from(row.ciphertext, 'base64').length > 0);
  for (const field of ['salt', 'nonce', 'tag', 'ciphertext']) {
    assert.match(row[field], /^[A-Za-z0-9+/]+={0,2}$/, field);
  }
  await vaultError(() => vault.get('anything'), 'not-found');

  // A second setup is refused and must not overwrite the envelope.
  await vaultError(() => vault.setup('a completely different passphrase'), 'vault-exists');
  assert.equal(query.rows.get(OWNER).salt, row.salt);
});

test('unlocking requires a configured vault', async () => {
  const { vault } = makeVault();
  await vaultError(() => vault.unlock(PASS), 'vault-not-configured');
  await vaultError(() => vault.changePassphrase(PASS, NEXT_PASS), 'vault-not-configured');
  assert.deepEqual(await vault.status(), { configured: false, unlocked: false, count: 0 });
});

// ---------------------------------------------------------------------------
// Authentication and locking
// ---------------------------------------------------------------------------

test('a wrong passphrase fails with vault-auth and leaves the vault locked', async () => {
  const { vault } = makeVault();
  await vault.setup(PASS);
  vault.lock();

  await vaultError(() => vault.unlock('definitely not the passphrase'), 'vault-auth');
  await vaultError(() => vault.unlock('short'), 'vault-auth'); // too short to be right, still just auth
  await vaultError(() => vault.unlock(''), 'invalid-input');
  await vaultError(() => vault.unlock(42), 'invalid-input');
  assert.deepEqual(await vault.status(), { configured: true, unlocked: false, count: 0 });

  assert.deepEqual(await vault.unlock(PASS), { configured: true, unlocked: true, count: 0 });
});

test('lock drops plaintext and blocks every operation that needs the key', async () => {
  const { vault } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'mail', value: 'app-password-1234', kind: 'password' });

  assert.deepEqual(vault.lock(), { configured: true, unlocked: false, count: 1 });
  for (const call of [
    () => vault.put({ name: 'x', value: 'y' }),
    () => vault.list(),
    () => vault.get('mail'),
    () => vault.remove('mail'),
  ]) {
    await vaultError(call, 'vault-locked');
  }
  // count survives lock as metadata only; the value does not.
  assert.deepEqual(await vault.status(), { configured: true, unlocked: false, count: 1 });
});

// ---------------------------------------------------------------------------
// put / list / get / remove
// ---------------------------------------------------------------------------

test('put/list/get/remove round-trip; list is masked metadata only', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);

  const put = await vault.put({ name: '  GitHub  ', value: 'ghp_abcdefghijklmnop1234', kind: 'token' });
  assert.deepEqual(put, { name: 'GitHub', kind: 'token', preview: '1234', updatedAt: iso(T0) });
  assert.equal(Object.hasOwn(put, 'value'), false);

  await vault.put({ name: 'DB', value: 'hunter2-password', kind: 'password' });
  const listed = await vault.list();
  assert.deepEqual(listed.map(entry => entry.name), ['GitHub', 'DB']);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['kind', 'name', 'preview', 'updatedAt']);
  assert.equal(listed[1].preview, 'word');
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes('ghp_abcdefghijklmnop1234'), false);
  assert.equal(serialized.includes('hunter2-password'), false);
  // Nothing plaintext reaches the stored row either.
  assert.equal(JSON.stringify([...query.rows.values()]).includes('hunter2-password'), false);

  assert.equal(await vault.get('GitHub'), 'ghp_abcdefghijklmnop1234');
  await vaultError(() => vault.get('Missing'), 'not-found');
  await vaultError(() => vault.remove('Missing'), 'not-found');

  assert.deepEqual(await vault.remove('DB'), { name: 'DB', removed: true, count: 1 });
  assert.deepEqual((await vault.list()).map(entry => entry.name), ['GitHub']);
  await vaultError(() => vault.get('DB'), 'not-found');

  // The removal is durable, not just an in-memory edit.
  vault.lock();
  await vault.unlock(PASS);
  assert.equal(await vault.get('GitHub'), 'ghp_abcdefghijklmnop1234');
  assert.deepEqual((await vault.list()).map(entry => entry.name), ['GitHub']);
});

test('put upserts by name: one entry, new value/kind, createdAt preserved', async () => {
  const { query, vault, tick } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'API', value: 'first-value-1111', kind: 'api-key' });
  tick();
  const second = await vault.put({ name: 'API', value: 'second-value-2222', kind: 'token' });

  const listed = await vault.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, 'token');
  assert.equal(listed[0].preview, '2222');
  assert.equal(listed[0].updatedAt, iso(T0 + 60_000));
  assert.equal(second.updatedAt, iso(T0 + 60_000));
  assert.equal(await vault.get('API'), 'second-value-2222');

  // The blob format is part of the contract: version 1 and one entry per name.
  const blob = decryptRow(query.rows.get(OWNER), PASS);
  assert.equal(blob.version, 1);
  assert.equal(blob.entries.length, 1);
  assert.deepEqual(Object.keys(blob.entries[0]).sort(), ['createdAt', 'kind', 'name', 'updatedAt', 'value']);
  assert.equal(blob.entries[0].createdAt, iso(T0));
  assert.equal(blob.entries[0].updatedAt, iso(T0 + 60_000));
  assert.equal(blob.entries[0].value, 'second-value-2222');
});

test('kind defaults to password and every documented kind is accepted', async () => {
  const { vault } = makeVault();
  await vault.setup(PASS);
  assert.equal((await vault.put({ name: 'default', value: 'value-0000' })).kind, 'password');
  for (const kind of KINDS) {
    assert.equal((await vault.put({ name: `kind-${kind}`, value: `value-${kind}` , kind })).kind, kind);
  }
  assert.deepEqual((await vault.list()).map(entry => entry.kind), ['password', ...KINDS]);
});

// ---------------------------------------------------------------------------
// Passphrase rotation
// ---------------------------------------------------------------------------

test('changePassphrase re-salts, invalidates the old passphrase and keeps entries', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'key', value: 'super-secret-9999', kind: 'api-key' });
  const before = { ...query.rows.get(OWNER) };

  const changed = await vault.changePassphrase(PASS, NEXT_PASS);
  assert.equal(changed.configured, true);
  assert.equal(changed.unlocked, true);
  assert.equal(changed.count, 1);
  assert.equal(changed.rotatedAt, iso(T0));

  const after = query.rows.get(OWNER);
  assert.notEqual(after.salt, before.salt);
  assert.notEqual(after.nonce, before.nonce);
  assert.notEqual(after.ciphertext, before.ciphertext);
  assert.equal(Buffer.from(after.salt, 'base64').length, 16);
  assert.equal(await vault.get('key'), 'super-secret-9999');

  vault.lock();
  await vaultError(() => vault.unlock(PASS), 'vault-auth');
  assert.deepEqual(await vault.unlock(NEXT_PASS), { configured: true, unlocked: true, count: 1 });
  assert.equal(await vault.get('key'), 'super-secret-9999');
});

test('changePassphrase verifies the old passphrase and validates the new one', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'key', value: 'super-secret-9999' });
  const before = { ...query.rows.get(OWNER) };

  await vaultError(() => vault.changePassphrase('wrong old passphrase', NEXT_PASS), 'vault-auth');
  await vaultError(() => vault.changePassphrase(PASS, 'short'), 'invalid-input');
  await vaultError(() => vault.changePassphrase(PASS, 123), 'invalid-input');
  // A missing next passphrase must fail loudly: the settings form used to send
  // `nextPassphrase: undefined`, which surfaced as a generic failure.
  await vaultError(() => vault.changePassphrase(PASS, undefined), 'invalid-input');
  await vaultError(() => vault.changePassphrase(PASS), 'invalid-input');
  assert.equal(query.rows.get(OWNER).ciphertext, before.ciphertext);

  // Rotating while locked is allowed: knowing the old passphrase unlocks it.
  vault.lock();
  assert.equal((await vault.changePassphrase(PASS, NEXT_PASS)).unlocked, true);
  assert.equal(await vault.get('key'), 'super-secret-9999');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('passphrase, name, value and kind validation', async () => {
  const { vault } = makeVault();
  for (const bad of ['', 'short', 'x'.repeat(2000), 123, null, undefined, {}]) {
    await vaultError(() => vault.setup(bad), 'invalid-input');
  }
  await vault.setup(PASS);

  const badEntries = [
    {},
    { value: 'x' },
    { name: '', value: 'x' },
    { name: '   ', value: 'x' },
    { name: 'x'.repeat(101), value: 'x' },
    { name: 42, value: 'x' },
    { name: 'ok', value: '' },
    { name: 'ok', value: 'x'.repeat(20001) },
    { name: 'ok', value: 42 },
    { name: 'ok', value: 'x', kind: 'secret' },
    { name: 'ok', value: 'x', kind: 42 },
  ];
  for (const input of badEntries) {
    await vaultError(() => vault.put(input), 'invalid-input');
  }
  await vaultError(() => vault.put(null), 'invalid-input');

  // Boundaries are accepted: 100-char name, 20000-char value.
  const boundary = await vault.put({ name: 'n'.repeat(100), value: 'v'.repeat(20000), kind: 'note' });
  assert.equal(boundary.name.length, 100);
  assert.equal((await vault.get('n'.repeat(100))).length, 20000);
  await vaultError(() => vault.get('n'.repeat(101)), 'invalid-input');
  await vaultError(() => vault.remove(''), 'invalid-input');
});

// ---------------------------------------------------------------------------
// Ciphertext hygiene
// ---------------------------------------------------------------------------

test('the stored envelope never contains the plaintext', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);
  const marker = 'sk-live-UNIQUE-MARKER-abcdef';
  await vault.put({ name: 'Stripe', value: marker, kind: 'api-key' });

  const row = query.rows.get(OWNER);
  for (const field of ['salt', 'nonce', 'tag', 'ciphertext']) {
    assert.equal(row[field].includes('UNIQUE-MARKER'), false, field);
    assert.equal(Buffer.from(row[field], 'base64').toString('latin1').includes('UNIQUE-MARKER'), false, field);
  }
  assert.equal(JSON.stringify([...query.rows.values()]).includes(marker), false);
  assert.equal(JSON.stringify([...query.rows.values()]).includes(PASS), false);
  // The envelope is the sealed JSON blob; the test helper can reopen it.
  const blob = decryptRow(row, PASS);
  assert.equal(blob.version, 1);
  assert.equal(blob.entries[0].value, marker);
});

test('tampered or malformed envelopes are rejected without leaking content', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'key', value: 'super-secret-9999' });
  const original = { ...query.rows.get(OWNER) };
  vault.lock();

  const flipped = Buffer.from(original.ciphertext, 'base64');
  flipped[0] ^= 0xff;
  query.rows.set(OWNER, { ...original, ciphertext: flipped.toString('base64') });
  await vaultError(() => vault.unlock(PASS), 'vault-auth');

  query.rows.set(OWNER, { ...original, salt: 'not-a-valid-salt' });
  await vaultError(() => vault.unlock(PASS), 'storage-error');
  assert.equal((await vault.status()).unlocked, false);

  query.rows.set(OWNER, original);
  assert.equal((await vault.unlock(PASS)).count, 1);
});

// ---------------------------------------------------------------------------
// Storage failures and instance isolation
// ---------------------------------------------------------------------------

test('storage failures surface as storage-error and do not corrupt memory', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'keep', value: 'value-keep-0000' });

  query.failWith = true;
  await vaultError(() => vault.status(), 'storage-error');
  await vaultError(() => vault.put({ name: 'new', value: 'value-new-0000' }), 'storage-error');
  await vaultError(() => vault.remove('keep'), 'storage-error');

  query.failWith = false;
  // The failed writes never became visible, and the session is still usable.
  assert.deepEqual((await vault.list()).map(entry => entry.name), ['keep']);
  assert.equal(await vault.get('keep'), 'value-keep-0000');
});

test('a missing row after setup is reported as vault-not-configured', async () => {
  const { query, vault } = makeVault();
  await vault.setup(PASS);
  await vault.put({ name: 'keep', value: 'value-keep-0000' });
  query.rows.clear();
  await vaultError(() => vault.put({ name: 'next', value: 'value-next-0000' }), 'vault-not-configured');
  assert.deepEqual(await vault.status(), { configured: false, unlocked: false, count: 0 });
});

test('unlocked state belongs to one factory instance only', async () => {
  const query = fakeTable();
  const first = createSecretVault({ query, ownerId: OWNER });
  await first.setup(PASS);
  await first.put({ name: 'a', value: 'value-a-1111' });

  const second = createSecretVault({ query, ownerId: OWNER });
  assert.deepEqual(await second.status(), { configured: true, unlocked: false, count: 0 });
  await vaultError(() => second.list(), 'vault-locked');
  await second.unlock(PASS);
  assert.equal(await second.get('a'), 'value-a-1111');
  // Locking the second instance must not touch the first.
  second.lock();
  assert.equal(await first.get('a'), 'value-a-1111');
});

test('scrypt parameters and the single-row SQL contract are pinned', () => {
  assert.deepEqual({ ...SCRYPT }, { N: 32768, r: 8, p: 1, keylen: 32 });
  assert.match(SQL.existsRow, /select owner_id from mova_vault where owner_id = \$1/);
  assert.match(SQL.selectRow, /from mova_vault where owner_id = \$1/);
  assert.match(SQL.insertRow, /on conflict \(owner_id\) do nothing/);
  assert.match(SQL.updateRow, /update mova_vault/);
  assert.equal((SQL.insertRow.match(/mova_vault/g) || []).length, 1);
});
