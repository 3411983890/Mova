import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSessionStore,
  rebuildConversation,
  snapshotToEvents,
  eventIdFor,
  SQL,
  EVENT_TYPES,
  SessionStoreError,
  stripPrivateReasoning,
} = require('../electron/services/session-store.cjs');

/** Minimal in-memory stand-in for the `mova_session_events` table. */
function fakeDb() {
  const rows = [];
  const calls = [];
  const state = { rows, calls };
  state.query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === SQL.insertEvent) {
      const [eventId, conversationId, parentEventId, sequenceInput, type, role, content, modelId, providerId, createdAt] = params;
      if (rows.some(row => row.event_id === eventId)) return { rows: [] };
      const maxSequence = rows.filter(row => row.conversation_id === conversationId).reduce((max, row) => Math.max(max, Number(row.sequence)), 0);
      const sequence = sequenceInput === null || sequenceInput === undefined ? maxSequence + 1 : Number(sequenceInput);
      if (rows.some(row => row.conversation_id === conversationId && Number(row.sequence) === sequence)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "mova_session_events_conversation_id_sequence_key"'), {
          code: '23505',
          constraint: 'mova_session_events_conversation_id_sequence_key',
        });
      }
      const row = {
        event_id: eventId,
        conversation_id: conversationId,
        parent_event_id: parentEventId ?? null,
        sequence,
        type,
        role: role ?? null,
        content: typeof content === 'string' ? JSON.parse(content) : content,
        model_id: modelId ?? null,
        provider_id: providerId ?? null,
        created_at: createdAt ?? new Date().toISOString(),
      };
      rows.push(row);
      return { rows: [row] };
    }
    if (sql === SQL.getEvent) {
      return { rows: rows.filter(row => row.event_id === params[0]) };
    }
    if (sql === SQL.latestSequence) {
      const filtered = rows.filter(row => row.conversation_id === params[0]);
      return { rows: [{ sequence: filtered.reduce((max, row) => Math.max(max, Number(row.sequence)), 0) }] };
    }
    if (sql === SQL.latestEvent) {
      const filtered = rows.filter(row => row.conversation_id === params[0]).sort((a, b) => Number(b.sequence) - Number(a.sequence));
      return { rows: filtered.slice(0, 1) };
    }
    if (sql === SQL.listEvents) {
      const [conversationId, from, to, limit] = params;
      return {
        rows: rows
          .filter(row => row.conversation_id === conversationId && Number(row.sequence) >= from && Number(row.sequence) <= to)
          .sort((a, b) => Number(a.sequence) - Number(b.sequence))
          .slice(0, limit),
      };
    }
    if (sql === SQL.listEventChain) {
      const [conversationId, leafEventId, limit] = params;
      const byId = new Map(rows.filter(row => row.conversation_id === conversationId).map(row => [row.event_id, row]));
      const chain = [];
      let current = byId.get(leafEventId) ?? null;
      const guard = new Set();
      while (current && !guard.has(current.event_id)) {
        guard.add(current.event_id);
        chain.push(current);
        current = current.parent_event_id ? byId.get(current.parent_event_id) : null;
      }
      return { rows: chain.sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(0, limit) };
    }
    if (sql === SQL.countEvents) {
      return { rows: [{ count: rows.filter(row => row.conversation_id === params[0]).length }] };
    }
    if (sql === SQL.lastModelChange) {
      const filtered = rows.filter(row => row.conversation_id === params[0] && row.type === 'model_change').sort((a, b) => Number(b.sequence) - Number(a.sequence));
      return { rows: filtered.slice(0, 1) };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return state;
}

function store(extra = {}) {
  const db = fakeDb();
  const log = { entries: [], debug: (...args) => log.entries.push(['debug', ...args]), info: (...args) => log.entries.push(['info', ...args]), warn: (...args) => log.entries.push(['warn', ...args]), error: (...args) => log.entries.push(['error', ...args]) };
  const instance = createSessionStore({
    query: db.query,
    logger: log,
    now: () => new Date('2026-11-10T12:00:00.000Z'),
    ...extra,
  });
  return { instance, db, log };
}

const code = async (fn, value) => {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${value} but nothing was thrown`);
  assert.ok(error instanceof SessionStoreError, `expected SessionStoreError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, value);
};

test('event types follow the contract and no Dot/task tables are used', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), ['branch', 'compaction', 'message', 'model_change', 'task_event', 'tool_call', 'tool_result']);
  for (const sql of Object.values(SQL)) assert.match(sql, /mova_session_events/);
  const { instance } = store();
  assert.equal(typeof instance.rebuildMessages, 'function');
  assert.equal(typeof instance.importSnapshot, 'function');
  // No official Pi SessionManager surface: this layer must not expose snapshot/agent mutation.
  assert.equal(instance.replaceSnapshot, undefined);
  assert.equal(instance.saveSessions, undefined);
});

test('appendEvent assigns stable ids, increasing sequences and parent links', async () => {
  const { instance, db } = store();
  const first = await instance.appendEvent({ conversationId: 'conversation-a', type: 'message', role: 'user', content: { text: 'hello' } });
  assert.equal(first.sequence, 1);
  assert.equal(first.parentEventId, null);
  assert.match(first.eventId, /^evt_[0-9a-f]{40}$/);
  assert.deepEqual(first.content, { text: 'hello' });
  assert.equal(first.createdAt, '2026-11-10T12:00:00.000Z');
  assert.equal(first.duplicated, false);

  const second = await instance.appendEvent({ conversationId: 'conversation-a', type: 'message', role: 'assistant', parentEventId: first.eventId, content: { text: 'hi' } });
  assert.equal(second.sequence, 2);
  assert.equal(second.parentEventId, first.eventId);
  const explicit = await instance.appendEvent({ conversationId: 'conversation-a', eventId: 'event-explicit', sequence: 10, parentEventId: second.eventId, type: 'model_change', content: { modelId: 'deepseek-chat' }, modelId: 'deepseek-chat', providerId: 'mova-deepseek' });
  assert.equal(explicit.eventId, 'event-explicit');
  assert.equal(explicit.sequence, 10);
  assert.equal(explicit.modelId, 'deepseek-chat');
  assert.equal(explicit.providerId, 'mova-deepseek');

  const other = await instance.appendEvent({ conversationId: 'conversation-b', type: 'message', role: 'user', content: { text: 'other' } });
  assert.equal(other.sequence, 1, 'sequences are per conversation');
  assert.equal(db.rows.length, 4);
});

test('appendEvent is idempotent for redelivered sync jobs and rejects temporary conversations', async () => {
  const { instance, db } = store();
  const input = { conversationId: 'c', type: 'message', role: 'user', parentEventId: null, content: { user: { text: 'same' }, reply: { text: 'same reply' } } };
  const first = await instance.appendEvent(input);
  const again = await instance.appendEvent(input);
  assert.equal(again.eventId, first.eventId);
  assert.equal(again.duplicated, true);
  assert.equal(db.rows.length, 1);

  const explicit = await instance.appendEvent({ conversationId: 'c', eventId: 'fixed-id', type: 'message', role: 'user', content: { text: 'a' } });
  assert.equal(explicit.eventId, 'fixed-id');
  const explicitAgain = await instance.appendEvent({ conversationId: 'c', eventId: 'fixed-id', type: 'message', role: 'user', content: { text: 'a' } });
  assert.equal(explicitAgain.duplicated, true);
  assert.equal((await instance.countEvents('c')), 2);

  assert.equal(await instance.appendEvent({ conversationId: 'temp', temporary: true, type: 'message', role: 'user', content: { text: 'x' } }), null);
  assert.equal(db.rows.some(row => row.conversation_id === 'temp'), false);
});

test('appendEvent validates type, role, sequence, parent and content size', async () => {
  const { instance } = store();
  await code(() => instance.appendEvent({}), 'invalid-input');
  await code(() => instance.appendEvent({ conversationId: 'c' }), 'invalid-type');
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'dot_task', content: {} }), 'invalid-type');
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'thinking', content: { text: 'x' } }), 'invalid-role');
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'x' }, sequence: 0 }), 'invalid-sequence');
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'x' }, sequence: 1.5 }), 'invalid-sequence');
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'x' }, parentEventId: 'same', eventId: 'same' }), 'invalid-parent');
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user' }), 'invalid-content');
  await code(() => instance.appendEvent({ conversationId: ' ', type: 'message', role: 'user', content: {} }), 'invalid-input');
  const huge = { text: 'x'.repeat(1_000_001) };
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: huge }), 'content-limit');
});

test('sequence collisions surface as sequence-conflict so the caller can retry', async () => {
  const { instance } = store();
  await instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'one' } });
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'two' }, sequence: 1 }), 'sequence-conflict');
});

test('listEvents supports ranges, type filters, limits and parent chains', async () => {
  const { instance } = store();
  const events = [];
  for (const [index, type] of ['message', 'tool_call', 'tool_result', 'message'].entries()) {
    events.push(await instance.appendEvent({ conversationId: 'c', type, role: type === 'message' ? (index === 0 ? 'user' : 'assistant') : null, parentEventId: index ? events[index - 1].eventId : null, content: { text: `event ${index}` } }));
  }
  const all = await instance.listEvents({ conversationId: 'c' });
  assert.deepEqual(all.map(event => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual((await instance.listEvents({ conversationId: 'c', fromSequence: 2, toSequence: 3 })).map(event => event.type), ['tool_call', 'tool_result']);
  assert.deepEqual((await instance.listEvents({ conversationId: 'c', types: ['message'] })).map(event => event.sequence), [1, 4]);
  assert.equal((await instance.listEvents({ conversationId: 'c', limit: 2 })).length, 2);
  await code(() => instance.listEvents({ conversationId: 'c', fromSequence: 4, toSequence: 2 }), 'invalid-range');
  await code(() => instance.listEvents({}), 'invalid-input');
  const chain = await instance.listEvents({ conversationId: 'c', leafEventId: events[3].eventId });
  assert.deepEqual(chain.map(event => event.sequence), [1, 2, 3, 4]);
  const partial = await instance.listEvents({ conversationId: 'c', leafEventId: events[2].eventId });
  assert.deepEqual(partial.map(event => event.sequence), [1, 2, 3]);
  assert.equal(await instance.latestSequence('c'), 4);
  assert.equal(await instance.countEvents('c'), 4);
  assert.equal(await instance.latestSequence('missing'), 0);
});

test('rebuildMessages returns only visible messages and tool results, never private reasoning', () => {
  const events = [
    { eventId: 'e1', sequence: 1, type: 'message', role: 'user', content: { text: 'first question', reasoning: 'SECRET-REASONING' } },
    { eventId: 'e2', sequence: 2, type: 'message', role: 'assistant', content: { text: 'first answer', thinking: 'SECRET-THINKING' }, modelId: 'm1' },
    { eventId: 'e3', sequence: 3, type: 'message', role: 'thinking', content: { text: 'SECRET-THINKING-BLOCK' } },
    { eventId: 'e4', sequence: 4, type: 'message', role: 'assistant', content: { user: { text: 'snapshot question', thinking: 'SECRET' }, reply: { text: 'snapshot reply', reasoning: 'SECRET-REASONING', timeline: [{ type: 'thinking', text: 'SECRET' }] } } },
    { eventId: 'e5', sequence: 5, type: 'tool_call', content: { callId: 'call-1', name: 'web_search', arguments: { query: 'mova' } } },
    { eventId: 'e6', sequence: 6, type: 'tool_result', content: { callId: 'call-1', name: 'web_search', text: 'source list' } },
    { eventId: 'e7', sequence: 7, type: 'branch', content: { name: 'main' } },
    { eventId: 'e8', sequence: 8, type: 'task_event', content: { phase: 'x' } },
    { eventId: 'e9', sequence: 9, type: 'tool_call', content: { callId: 'call-2', name: 'file_write', arguments: { path: 'a.txt' } } },
  ];
  const rebuilt = rebuildConversation(events);
  assert.deepEqual(rebuilt.messages.map(message => [message.role, message.text ?? message.arguments]), [
    ['user', 'first question'],
    ['assistant', 'first answer'],
    ['user', 'snapshot question'],
    ['assistant', 'snapshot reply'],
    ['assistant', '{"query":"mova"}'],
    ['tool', 'source list'],
    ['assistant', '{"path":"a.txt"}'],
  ]);
  const serialized = JSON.stringify(rebuilt);
  assert.equal(serialized.includes('SECRET'), false, 'reasoning must never be rebuilt');
  assert.equal(rebuilt.pendingToolCalls.length, 1);
  assert.equal(rebuilt.pendingToolCalls[0].callId, 'call-2');
  assert.equal(rebuilt.pendingToolCalls[0].name, 'file_write');
  assert.equal(rebuilt.interrupted, false);

  const interrupted = rebuildConversation([{ eventId: 'x', sequence: 1, type: 'message', role: 'assistant', content: { text: 'partial', interrupted: true } }]);
  assert.equal(interrupted.interrupted, true);
  const streaming = rebuildConversation([{ eventId: 'x', sequence: 1, type: 'message', role: 'assistant', content: { reply: { text: 'partial', status: 'streaming' } } }]);
  assert.equal(streaming.interrupted, true);
  const errored = rebuildConversation([{ eventId: 'x', sequence: 1, type: 'message', role: 'assistant', content: { reply: { text: '', status: 'error' } } }]);
  assert.equal(errored.interrupted, true);
  assert.deepEqual(errored.messages, []);
});

test('rebuildMessages truncates large tool output, keeps refs, and applies compaction boundaries', () => {
  const long = 'x'.repeat(300);
  const events = [
    { eventId: 'a', sequence: 1, type: 'message', role: 'user', content: { text: 'before compaction' } },
    { eventId: 'b', sequence: 2, type: 'compaction', role: null, content: { summary: 'earlier summary', coversUpTo: 'a' } },
    { eventId: 'c', sequence: 3, type: 'message', role: 'user', content: { text: 'after compaction' } },
    { eventId: 'd', sequence: 4, type: 'tool_result', content: { callId: 'call-9', name: 'read', text: long } },
    { eventId: 'e', sequence: 5, type: 'tool_result', content: { callId: 'call-10', name: 'blob', ref: 's3://bucket/key', summary: 'stored blob' } },
    { eventId: 'f', sequence: 6, type: 'model_change', content: { thinkingLevel: 'high' }, modelId: 'deepseek-reasoner', providerId: 'mova-deepseek' },
  ];
  const rebuilt = rebuildConversation(events, { maxToolChars: 50 });
  assert.deepEqual(rebuilt.messages.map(message => message.kind ?? message.role), ['summary', 'user', 'tool_result', 'tool_result']);
  assert.equal(rebuilt.messages[0].text, 'earlier summary');
  assert.equal(rebuilt.messages.some(message => message.text === 'before compaction'), false);
  assert.equal(rebuilt.messages[1].text, 'after compaction');
  assert.equal(rebuilt.messages[2].truncated, true);
  assert.ok(rebuilt.messages[2].text.length <= 51);
  assert.equal(rebuilt.messages[3].ref, 's3://bucket/key');
  assert.equal(rebuilt.messages[3].text, 'stored blob');
  assert.equal(rebuilt.compaction.eventId, 'b');
  assert.equal(rebuilt.compaction.summary, 'earlier summary');
  assert.deepEqual(rebuilt.model, { modelId: 'deepseek-reasoner', providerId: 'mova-deepseek', thinkingLevel: 'high', eventId: 'f', sequence: 6 });

  const noSummary = rebuildConversation(events, { includeSummary: false });
  assert.equal(noSummary.messages.some(message => message.kind === 'summary'), false);
  assert.equal(noSummary.messages[0].text, 'after compaction');

  const emptySummary = rebuildConversation([{ eventId: 'z', sequence: 1, type: 'compaction', content: {} }]);
  assert.deepEqual(emptySummary.warnings, ['compaction-without-summary']);
  assert.equal(rebuildConversation([]).messages.length, 0);
  assert.throws(() => rebuildConversation('nope'), error => error.code === 'invalid-events');
});

test('loadConversation rebuilds the stored log without touching runtime state', async () => {
  const { instance, db } = store();
  await instance.appendEvent({ conversationId: 'conv', type: 'message', role: 'user', content: { text: 'hi' } });
  const model = await instance.appendEvent({ conversationId: 'conv', type: 'model_change', modelId: 'deepseek-chat', providerId: 'mova-deepseek', content: { thinkingLevel: 'low' } });
  const call = await instance.appendEvent({ conversationId: 'conv', type: 'tool_call', parentEventId: model.eventId, content: { callId: 'c1', name: 'web_search', arguments: { q: 'x' } } });
  assert.ok(call.eventId);
  const loaded = await instance.loadConversation({ conversationId: 'conv' });
  assert.equal(loaded.conversationId, 'conv');
  assert.equal(loaded.events.length, 3);
  assert.equal(loaded.leafEventId, call.eventId);
  assert.equal(loaded.sequence, 3);
  assert.equal(loaded.model.modelId, 'deepseek-chat');
  assert.deepEqual(loaded.messages.map(message => message.kind ?? message.role), ['user', 'tool_call']);
  assert.equal(loaded.pendingToolCalls.length, 1);
  assert.deepEqual(db.rows.map(row => row.type), ['message', 'model_change', 'tool_call']);
  assert.equal(db.rows.some(row => row.conversation_id !== 'conv'), false, 'nothing outside the event log is written');
  assert.equal((await instance.latestModelChange('conv')).modelId, 'deepseek-chat');
  assert.equal((await instance.loadConversation({ conversationId: 'empty' })).messages.length, 0);
});

test('snapshot import maps renderer turns to stable message events and strips reasoning', async () => {
  const snapshot = {
    version: 1,
    projects: [{ name: 'Alpha' }],
    conversations: [
      [JSON.stringify(['ChatMova', 'Alpha', 'Chat']), [
        { id: 'turn-1', text: '你好', thinking: { text: 'SECRET-THINKING' }, reply: { text: '你好！', status: 'done', model: 'deepseek-chat', timeline: [{ type: 'thinking', text: 'SECRET-THINKING' }] } },
        { id: 'turn-2', text: '第二个问题', reply: { text: '回答二', status: 'done', model: 'deepseek-chat' }, attempts: [{ index: 1, status: 'error' }] },
        { text: '没有 id 的一轮', reply: { text: '可见回复', status: 'done' } },
      ]],
      ['temporary', { projectId: 'Alpha', temporary: true, messages: [{ id: 't1', text: '临时消息' }] }],
      [JSON.stringify(['CodeMova', 'Beta', 'Chat']), { projectId: 'Beta', messages: [{ id: 'turn-b', text: '项目消息', reply: { text: '项目回复', status: 'done', model: 'other-model' } }] }],
    ],
  };
  const plan = snapshotToEvents(snapshot);
  assert.equal(plan.length, 3);
  const chat = plan.find(entry => entry.conversationId === JSON.stringify(['ChatMova', 'Alpha', 'Chat']));
  assert.equal(chat.temporary, false);
  assert.equal(chat.events.length, 3);
  assert.deepEqual(chat.events.map(event => event.sequence), [1, 2, 3]);
  assert.deepEqual(chat.events.map(event => event.eventId), ['turn-1', 'turn-2', chat.events[2].eventId]);
  assert.equal(chat.events[0].type, 'message');
  assert.equal(chat.events[1].parentEventId, 'turn-1');
  assert.equal(chat.events[2].parentEventId, 'turn-2');
  assert.deepEqual(chat.events[0].content.user, { text: '你好' });
  assert.deepEqual(chat.events[0].content.reply, { text: '你好！', status: 'done', model: 'deepseek-chat' });
  assert.equal(JSON.stringify(chat.events).includes('SECRET-THINKING'), false, 'reasoning timeline entries are stripped');
  assert.equal(JSON.stringify(chat.events).includes('SECRET'), false);
  assert.deepEqual(chat.events[1].content.attempts, [{ index: 1, status: 'error' }]);
  assert.equal('attempts' in chat.events[1].content.reply, false);
  const temporary = plan.find(entry => entry.conversationId === 'temporary');
  assert.equal(temporary.temporary, true);
  assert.deepEqual(temporary.events, []);
  const code = plan.find(entry => entry.conversationId === JSON.stringify(['CodeMova', 'Beta', 'Chat']));
  assert.equal(code.projectId, 'Beta');
  assert.equal(code.events[0].type, 'message');

  // Stable across runs and independent of array order for the same input.
  assert.deepEqual(snapshotToEvents(structuredClone(snapshot)).map(entry => entry.events.map(event => event.eventId)), plan.map(entry => entry.events.map(event => event.eventId)));
  assert.equal(chat.events[2].eventId, eventIdFor({ conversationId: chat.conversationId, parentEventId: 'turn-2', sequence: 3, type: 'message', role: null, content: chat.events[2].content }));

  const withModel = snapshotToEvents(snapshot, { modelChanges: true, conversationIds: [chat.conversationId] });
  assert.equal(withModel.length, 1);
  assert.deepEqual(withModel[0].events.map(event => event.type), ['model_change', 'message', 'message', 'message']);
  assert.equal(withModel[0].events[0].modelId, 'deepseek-chat');
  assert.equal(withModel[0].events[1].parentEventId, withModel[0].events[0].eventId);
  assert.deepEqual(withModel[0].events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.throws(() => snapshotToEvents({ version: 2, conversations: [] }), error => error.code === 'invalid-snapshot');
  assert.throws(() => snapshotToEvents({ version: 1, conversations: [['a', {}, 'extra']] }), error => error.code === 'invalid-snapshot');
  // Duplicate turn ids are event-id collisions, not silent overwrites.
  assert.throws(() => snapshotToEvents({ version: 1, conversations: [['c1', [{ id: 'same', text: 'a' }]], ['c2', [{ id: 'same', text: 'b' }]]] }), error => error.code === 'duplicate-event-id');
});

test('importSnapshot is idempotent, skips temporary conversations and reports counts', async () => {
  const { instance, db } = store();
  const snapshot = {
    version: 1,
    conversations: [
      ['conv-1', [{ id: 'turn-1', text: 'one', reply: { text: 'uno', status: 'done' } }, { id: 'turn-2', text: 'two', reply: { text: 'dos', status: 'done' } }]],
      ['conv-temp', { temporary: true, messages: [{ id: 't', text: 'secret' }] }],
    ],
  };
  const first = await instance.importSnapshot(snapshot);
  assert.equal(first.conversations, 2);
  assert.equal(first.inserted, 2);
  assert.equal(first.duplicated, 0);
  assert.deepEqual(first.temporary, ['conv-temp']);
  assert.equal(db.rows.length, 2);
  assert.deepEqual(db.rows.map(row => row.sequence), [1, 2]);
  assert.equal(db.rows[0].content.user.text, 'one');
  assert.equal(db.rows[0].content.reply.text, 'uno');
  assert.equal(db.rows.some(row => row.conversation_id === 'conv-temp'), false);

  const second = await instance.importSnapshot(snapshot);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicated, 2);
  assert.equal(second.skipped, 2);
  assert.equal(db.rows.length, 2, 're-import must not duplicate events');

  const loaded = await instance.loadConversation({ conversationId: 'conv-1' });
  assert.deepEqual(loaded.messages.map(message => message.text), ['one', 'uno', 'two', 'dos']);
  assert.deepEqual(loaded.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(JSON.stringify(loaded).includes('SECRET'), false);
});

test('storage failures map to storage-error without leaking SQL or secrets', async () => {
  const instance = createSessionStore({
    query: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED postgres://mova:secret@127.0.0.1:55432/mova'), { code: 'ECONNREFUSED' });
    },
  });
  await code(() => instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'x' } }), 'storage-error');
  await instance.appendEvent({ conversationId: 'c', type: 'message', role: 'user', content: { text: 'x' } }).catch(error => {
    assert.equal(String(error.detail).includes('secret'), false, 'storage errors must redact DB passwords');
  });
  assert.throws(() => createSessionStore({}), error => error.code === 'query-required');
});

test('stripPrivateReasoning removes reasoning fields recursively but keeps visible content', () => {
  const input = { text: 'visible', thinking: { text: 'secret' }, nested: { reasoning: 'secret', reasoning_content: 'x', keep: 1 }, thinkingBlocks: [1] };
  assert.deepEqual(stripPrivateReasoning(input), { text: 'visible', nested: { keep: 1 } });
  assert.deepEqual(stripPrivateReasoning([{ thinking: 'x', text: 'y' }]), [{ text: 'y' }]);
  const timeline = { reply: { text: 'ok', timeline: [{ type: 'thinking', text: 'secret' }, { type: 'search', query: 'q' }] } };
  assert.deepEqual(stripPrivateReasoning(timeline), { reply: { text: 'ok', timeline: [{ type: 'search', query: 'q' }] } });
  assert.deepEqual(stripPrivateReasoning({ reply: { text: 'ok', timeline: [{ type: 'thinking', text: 'secret' }] } }), { reply: { text: 'ok' } });
});
