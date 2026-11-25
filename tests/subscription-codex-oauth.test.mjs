import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_CLIENT_ID, CODEX_REDIRECT_URI, codexClaims, codexIdentityKey, codexRecordFromCredential,
  createCodexLogin, decodeCodexJwt, refreshCodexCredential,
} from '../electron/subscription/codex-oauth.mjs';

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwt(payload, header = { alg: 'RS256', typ: 'JWT' }) {
  return `${b64(header)}.${b64(payload)}.signature`;
}

const ACCESS_CLAIMS = {
  sub: 'user-123',
  exp: 1_900_000_000,
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-abc',
    chatgpt_plan_type: 'plus',
  },
  'https://api.openai.com/profile': { email: 'someone@example.com', email_verified: true },
};

test('the client id and redirect uri match the Codex CLI public client', () => {
  assert.equal(CODEX_CLIENT_ID, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(CODEX_REDIRECT_URI, 'http://localhost:1455/auth/callback');
});

test('decodeCodexJwt reads the payload and tolerates garbage', () => {
  assert.deepEqual(decodeCodexJwt(jwt({ a: 1 })), { a: 1 });
  assert.equal(decodeCodexJwt('not-a-jwt'), null);
  assert.equal(decodeCodexJwt('a.%%%.c'), null);
  assert.equal(decodeCodexJwt(undefined), null);
});

test('codexClaims pulls the account id, email, plan and expiry out of the access token', () => {
  const claims = codexClaims(jwt(ACCESS_CLAIMS));
  assert.equal(claims.accountId, 'acct-abc');
  assert.equal(claims.email, 'someone@example.com');
  assert.equal(claims.plan, 'plus');
  assert.equal(claims.expiresAt, 1_900_000_000_000);
  assert.equal(claims.subject, 'user-123');
});

test('codexClaims degrades to empty strings when the token carries nothing', () => {
  const claims = codexClaims(jwt({}));
  assert.deepEqual(claims, { accountId: '', email: '', plan: '', expiresAt: 0, subject: '' });
});

test('the identity key prefers account id, then email, then a token fingerprint', () => {
  assert.equal(codexIdentityKey({ accountId: 'acct-abc', email: 'a@b.c' }, 'tok'), 'chatgpt:acct-abc');
  assert.equal(codexIdentityKey({ accountId: '', email: 'A@B.C' }, 'tok'), 'chatgpt:a@b.c');
  assert.match(codexIdentityKey({}, 'tok'), /^chatgpt:[a-f0-9]{64}$/);
});

test('a credential becomes a subscription record with no id_token and no api key', () => {
  const record = codexRecordFromCredential({
    type: 'oauth', access: jwt(ACCESS_CLAIMS), refresh: 'rt_1', expires: 1_900_000_000_000, accountId: 'acct-abc',
  }, { now: 1_700_000_000_000 });
  assert.equal(record.type, 'codex-oauth');
  assert.equal(record.provider, 'chatgpt');
  assert.equal(record.accountId, 'chatgpt:acct-abc');
  assert.equal(record.chatgptAccountId, 'acct-abc');
  assert.equal(record.email, 'someone@example.com');
  assert.equal(record.plan, 'plus');
  assert.equal(record.access, jwt(ACCESS_CLAIMS));
  assert.equal(record.refresh, 'rt_1');
  assert.equal(record.expiresAt, 1_900_000_000_000);
  assert.equal(record.clientId, CODEX_CLIENT_ID);
  assert.equal('idToken' in record, false);
  assert.equal('apiKey' in record, false);
});

test('an incomplete credential is refused instead of half-saved', () => {
  assert.throws(() => codexRecordFromCredential({ access: 'a' }), /incomplete/);
  assert.throws(() => codexRecordFromCredential({ refresh: 'b' }), /incomplete/);
});

test('refresh keeps the old refresh token when the upstream does not rotate it', async () => {
  const calls = [];
  const oauth = {
    refresh: async (credential, signal) => {
      calls.push({ credential, signal });
      return { access: jwt(ACCESS_CLAIMS), expires: 1_950_000_000_000 };
    },
  };
  const next = await refreshCodexCredential({ access: 'old', refresh: 'rt_old', accountId: 'acct-abc' }, { oauth });
  assert.equal(next.refresh, 'rt_old');
  assert.equal(next.access, jwt(ACCESS_CLAIMS));
  assert.equal(next.expires, 1_950_000_000_000);
  assert.equal(next.accountId, 'acct-abc');
  assert.equal(calls.length, 1);
});

test('browser login surfaces the authorize url, then finishes from a pasted redirect', async () => {
  const opened = [];
  const seen = [];
  let manualPromptSeen = false;
  const oauth = {
    async login(interaction, options) {
      seen.push(options?.agentName);
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?client_id=x' });
      const pasted = await interaction.prompt({ type: 'manual_code', message: 'paste' });
      manualPromptSeen = true;
      assert.match(pasted, /code=abc/);
      return { type: 'oauth', access: jwt(ACCESS_CLAIMS), refresh: 'rt_1', expires: 1_900_000_000_000, accountId: 'acct-abc' };
    },
  };
  const login = createCodexLogin({ oauth, openBrowser: url => opened.push(url), timeoutMs: 5_000 });
  assert.equal(await login.authorizeUrl, 'https://auth.openai.com/oauth/authorize?client_id=x');
  assert.deepEqual(opened, ['https://auth.openai.com/oauth/authorize?client_id=x']);
  // 先给事件循环一拍，让 login 走到 manual_code 这一步
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(login.complete('http://localhost:1455/auth/callback?code=abc&state=s'), true);
  const record = await login.credential;
  assert.equal(manualPromptSeen, true);
  assert.equal(record.accountId, 'chatgpt:acct-abc');
  assert.deepEqual(seen, ['Mova']);
});

test('cancelling stops the flow and later pastes are ignored', async () => {
  const oauth = {
    login: interaction => new Promise((resolve, reject) => {
      interaction.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
  };
  const login = createCodexLogin({ oauth, openBrowser: () => {}, timeoutMs: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(login.cancel(), true);
  await assert.rejects(login.credential, /cancelled/);
  assert.equal(login.complete('code'), false);
  assert.equal(login.cancel(), false);
});
