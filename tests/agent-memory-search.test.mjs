import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createAgentMemorySearch, formatMemoryHit } = createRequire(import.meta.url)('../electron/services/agent-memory-search.cjs');

const request = { memoryScope: { projectId: 'Alpha', includeGlobal: true } };

test('disabled memory and temporary chats never expose agent search', () => {
  const repo = {};
  assert.equal(createAgentMemorySearch(repo, request, false), null);
  assert.equal(createAgentMemorySearch(repo, { ...request, temporary: true }, true), null);
  assert.equal(createAgentMemorySearch(repo, {}, true), null);
});

test('agent search checks current switch, preserves scope and excludes session hits', async () => {
  let enabled = true;
  const calls = [];
  const repo = { settings: async () => ({ memoryEnabled: enabled }), search: async input => {
    calls.push(input);
    return [{ kind: 'memory', id: 'm', projectId: 'Alpha' }, { kind: 'session', id: 's' }];
  } };
  const search = createAgentMemorySearch(repo, request, true);
  assert.deepEqual(await search({ query: 'abc', limit: 100 }), [{ kind: 'memory', id: 'm', projectId: 'Alpha' }]);
  assert.deepEqual(calls[0], { query: 'abc', projectId: 'Alpha', includeGlobal: true, allProjects: false, includeSessions: false, limit: 12 });
  enabled = false;
  assert.deepEqual(await search({ query: 'abc' }), []);
  assert.equal(calls.length, 1);
});

test('global scope respects project setting but global chat can search itself', async () => {
  const calls = [];
  const repo = { settings: async () => ({ memoryEnabled: true }), search: async input => { calls.push(input); return []; } };
  const project = createAgentMemorySearch(repo, { memoryScope: { projectId: 'Alpha', includeGlobal: false } }, true);
  await project({ query: 'private', scope: 'global' });
  assert.equal(calls.length, 0);
  await project({ query: 'project' });
  assert.equal(calls[0].includeGlobal, false);
  const chat = createAgentMemorySearch(repo, { memoryScope: { projectGlobal: false, projectId: null, includeGlobal: false } }, true);
  await chat({ query: 'global', scope: 'global' });
  assert.equal(calls[1].projectId, null);
  assert.equal(calls[1].includeGlobal, true);
});

test('current settings bound structured results and changes during search apply', async () => {
  let settings = { memoryEnabled: true, contextMaxMemories: 5, contextMaxChars: 6000 };
  const hits = Array.from({ length: 5 }, (_, i) => ({ kind: 'memory', id: `m${i}`, text: 'text' }));
  const repo = { settings: async () => settings, search: async input => {
    assert.equal(input.limit, 5);
    settings = { memoryEnabled: true, contextMaxMemories: 2, contextMaxChars: 120 };
    return hits;
  } };
  const search = createAgentMemorySearch(repo, request, true);
  const result = await search({ query: 'x', limit: 12 });
  assert.equal(result.length, 2);
  const output = result.map(item => ({ id: item.id, text: item.text, projectId: item.projectId ?? null, source: item.source ?? null }));
  assert.ok(JSON.stringify(output).length <= 120);
  settings.contextMaxChars = 3;
  repo.search = async () => hits;
  assert.deepEqual(await search({ query: 'x' }), []);
});

test('project scope excludes global if disabled mid-search and never returns other projects', async () => {
  let settings = { memoryEnabled: true, includeGlobal: true };
  const repo = { settings: async () => settings, search: async () => {
    settings = { memoryEnabled: true, includeGlobal: false };
    return [{ kind: 'memory', id: 'local', projectId: 'Alpha' },
      { kind: 'memory', id: 'global', projectId: null },
      { kind: 'memory', id: 'other', projectId: 'Beta' }];
  } };
  const search = createAgentMemorySearch(repo, request, true);
  assert.deepEqual((await search({ query: 'x' })).map(hit => hit.id), ['local']);
  assert.deepEqual(await search({ query: 'x', scope: 'global' }), []);
});

test('cancelled search never returns retrieved memories', async () => {
  const controller = new AbortController();
  const repo = { settings: async () => ({ memoryEnabled: true }), search: async () => {
    controller.abort();
    return [{ kind: 'memory', id: 'm', projectId: 'Alpha' }];
  } };
  await assert.rejects(createAgentMemorySearch(repo, request, true)({ query: 'x' }, controller.signal),
    error => error.name === 'AbortError');
});

test('turning memory off during retrieval discards results; setting failures fail closed', async () => {
  let enabled = true;
  const repo = { settings: async () => ({ memoryEnabled: enabled }), search: async () => {
    enabled = false;
    return [{ kind: 'memory', text: 'private' }];
  } };
  const search = createAgentMemorySearch(repo, request, true);
  assert.deepEqual(await search({ query: 'x' }), []);
  repo.settings = async () => { throw new Error('unavailable'); };
  await assert.rejects(search({ query: 'x' }));
});

test('readSource follows only returned hits, redacts secrets, and pages the original', async () => {
  let enabled = true;
  let reads = 0;
  const hit = { kind: 'memory', id: 'm', text: 'Saved preference', projectId: 'Alpha',
    source: 'automatic', conversationId: 'chat-a', messageId: 'turn-a' };
  const repo = {
    settings: async () => ({ memoryEnabled: enabled }),
    search: async () => [hit, { ...hit, id: 'other', projectId: 'Beta' }],
    async readMemorySource(input) {
      reads++;
      assert.deepEqual(input, { id: 'm', conversationId: 'chat-a', messageId: 'turn-a', projectId: 'Alpha', includeGlobal: true });
      return { text: 'Original wording. password: actual-secret', role: 'user', projectId: 'Alpha' };
    },
  };
  const search = createAgentMemorySearch(repo, request, true);
  assert.equal((await search.readSource({ id: 'm' })).code, 'source-unavailable');
  const [result] = await search({ query: 'preference' });
  assert.deepEqual(formatMemoryHit(result).original, { conversationId: 'chat-a', messageId: 'turn-a' });
  assert.equal((await search.readSource({ id: 'other' })).code, 'source-unavailable');
  const first = await search.readSource({ id: 'm', limit: 8 });
  const rest = await search.readSource({ id: 'm', offset: first.nextOffset });
  assert.equal(first.text + rest.text, 'Original wording. password: [REDACTED]');
  assert.equal(rest.nextOffset, null);
  enabled = false;
  assert.equal((await search.readSource({ id: 'm' })).code, 'source-unavailable');
  assert.equal(reads, 2);
});

test('a memory miss searches all saved chats and gives overviews before opening a chosen source', async () => {
  const conversationId = JSON.stringify(['CodeMova', 'Beta', '配置记录']);
  const text = 'Earlier context. '.repeat(50) + '保留参数为 30 Mbps。';
  const calls = [];
  let memoryHit = false;
  let sourceReads = 0;
  const repo = {
    settings: async () => ({ memoryEnabled: true }),
    async search(input) {
      calls.push(input);
      if (!input.includeSessions) return memoryHit ? [{ kind: 'memory', id: 'm', text: 'Known', projectId: 'Alpha' }] : [];
      return [{ kind: 'session', conversationId, messageId: 'turn-2', projectId: 'Beta', role: 'user', text }];
    },
    async readHistorySource(input) {
      sourceReads++;
      assert.deepEqual(input, { conversationId, messageId: 'turn-2', mode: 'around' });
      return { messages: [
        { messageId: 'turn-1', role: 'assistant', text: 'Previous message.' },
        { messageId: 'turn-2', role: 'user', text: '保留参数为 30 Mbps。' },
      ] };
    },
  };
  const search = createAgentMemorySearch(repo, request, true);
  const [hit] = await search({ query: '30 Mbps' });
  assert.deepEqual(calls.map(call => call.includeSessions), [false, true]);
  assert.equal(calls[1].includeMemories, false);
  assert.equal(calls[1].allProjects, true);
  assert.equal(sourceReads, 0);
  const result = formatMemoryHit(hit);
  assert.equal(result.kind, 'history');
  assert.equal(result.title, '配置记录');
  assert.match(result.overview, /30 Mbps/);
  assert.ok(result.overview.length <= 222);
  assert.equal(result.text, undefined);
  assert.equal((await search.readSource({ id: 'unseen', mode: 'conversation' })).code, 'source-unavailable');
  const first = await search.readSource({ id: hit.id, mode: 'around', limit: 17 });
  assert.equal(first.messages[0].text, 'Previous message.');
  const rest = await search.readSource({ id: hit.id, mode: 'around', offset: first.nextOffset });
  assert.equal(rest.messages[0].text, '保留参数为 30 Mbps。');
  assert.equal(rest.nextOffset, null);
  memoryHit = true;
  assert.equal((await search({ query: '30 Mbps' }))[0].kind, 'memory');
  assert.equal(calls.length, 3);
  assert.equal((await search({ query: '30 Mbps', source: 'history' }))[0].kind, 'session');
  assert.equal(calls.length, 4);
});
