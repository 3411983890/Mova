// 复用 Codex CLI 登录态（方案 A）的解析约定。
//
// 真实文件长这样（本机实测，仅结构）：
//   auth_mode: "chatgpt"
//   tokens: { id_token, access_token, refresh_token,
//             oauth_provenance: { issuer, client_id }, account_id, login_owner_id }
//   last_refresh
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  codexAuthFile, codexRecord, decodeJwtPayload, parseCodexAuth, readCodexAuth,
} from '../electron/subscription/codex-auth.mjs';

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `header.${body}.signature`;
}

const ID_TOKEN = jwt({
  email: 'alice@example.com',
  chatgpt_plan_type: 'plus',
  exp: 1_900_000_000,
  'https://api.openai.com/auth': { chatgpt_account_id: 'claim-account-id' },
});
const ACCESS_TOKEN = jwt({ exp: 1_900_000_100 });

function codexPayload(overrides = {}) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: ID_TOKEN,
      access_token: ACCESS_TOKEN,
      refresh_token: 'refresh-123',
      oauth_provenance: { issuer: 'https://auth.openai.com', client_id: 'official-client-id' },
      account_id: 'uuid-account-id',
      login_owner_id: 'owner',
    },
    last_refresh: '2026-11-13T00:00:00Z',
    ...overrides,
  };
}

test('decodeJwtPayload reads a base64url payload and tolerates junk', () => {
  assert.equal(decodeJwtPayload(ID_TOKEN).email, 'alice@example.com');
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(decodeJwtPayload(''), null);
  assert.equal(decodeJwtPayload(undefined), null);
});

test('parseCodexAuth keeps the fields the usage endpoint needs', () => {
  const parsed = parseCodexAuth(codexPayload());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tokens.access, ACCESS_TOKEN);
  assert.equal(parsed.tokens.refresh, 'refresh-123');
  // 这两格是 401 的关键：额度接口要 chatgpt-account-id，刷新要官方 client_id。
  assert.equal(parsed.tokens.accountId, 'uuid-account-id');
  assert.equal(parsed.tokens.clientId, 'official-client-id');
  assert.equal(parsed.tokens.email, 'alice@example.com');
  assert.equal(parsed.tokens.plan, 'plus');
  assert.equal(parsed.tokens.expiresAt, 1_900_000_100_000, '用 access_token 的 exp');
});

test('parseCodexAuth falls back to JWT claims when account_id is absent', () => {
  const payload = codexPayload();
  delete payload.tokens.account_id;
  const parsed = parseCodexAuth(payload);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tokens.accountId, 'claim-account-id');
});

test('parseCodexAuth refuses api-key mode and missing tokens', () => {
  assert.equal(parseCodexAuth(codexPayload({ auth_mode: 'apikey' })).ok, false);
  assert.equal(parseCodexAuth(codexPayload({ auth_mode: 'apikey' })).detail, 'auth_mode=apikey');
  const noRefresh = codexPayload();
  delete noRefresh.tokens.refresh_token;
  assert.deepEqual(parseCodexAuth(noRefresh), { ok: false, detail: 'missing_tokens', tokens: null });
  assert.equal(parseCodexAuth(null).ok, false);
});

test('codexAuthFile honours CODEX_HOME', () => {
  assert.equal(
    codexAuthFile({ env: { CODEX_HOME: 'D:\\codex-home' }, home: 'C:\\Users\\me' }),
    join('D:\\codex-home', 'auth.json'),
  );
  assert.equal(
    codexAuthFile({ env: {}, home: join('C:', 'Users', 'me') }),
    join('C:', 'Users', 'me', '.codex', 'auth.json'),
  );
});

test('readCodexAuth reports a missing file instead of throwing', async () => {
  const result = await readCodexAuth({
    env: { CODEX_HOME: 'D:\\nope' },
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'not_found');
});

test('readCodexAuth reports invalid JSON', async () => {
  const result = await readCodexAuth({ env: { CODEX_HOME: 'D:\\x' }, readFile: async () => '{nope' });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'invalid_json');
});

test('readCodexAuth parses a real payload', async () => {
  const result = await readCodexAuth({
    env: { CODEX_HOME: 'D:\\x' },
    readFile: async () => JSON.stringify(codexPayload()),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tokens.email, 'alice@example.com');
});

test('codexRecord produces a store record with a stable identity', () => {
  const { tokens } = parseCodexAuth(codexPayload());
  const record = codexRecord(tokens, { now: () => 42, hash: value => `h(${value})` });
  assert.equal(record.type, 'codex');
  assert.equal(record.accountId, 'h(codex:uuid-account-id)', '身份只认上游 account id');
  assert.equal(record.chatgptAccountId, 'uuid-account-id');
  assert.equal(record.clientId, 'official-client-id', '刷新必须用官方 client id');
  assert.equal(record.expiresAt, 1_900_000_100_000);
  assert.equal(record.createdAt, 42);
  assert.equal(record.importedFrom, 'codex-cli');
  // 同一份凭据必须算出同一个 accountId：否则每导入一次就多一条账号。
  const again = codexRecord(tokens, { hash: value => `h(${value})` });
  assert.equal(again.accountId, record.accountId);
});
