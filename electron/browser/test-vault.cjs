'use strict';
// In-memory vault used only by MOVA_TEST_VAULT=1 test runs. It must never be
// selected in a normal launch; main.cjs gates it on the environment variable.

const { randomUUID } = require('node:crypto');

function createMemoryVault() {
  const entries = new Map();
  let unlocked = true;
  return {
    async status() { return { configured: true, unlocked, count: entries.size }; },
    async setup() { unlocked = true; return this.status(); },
    async unlock() { unlocked = true; return this.status(); },
    async lock() { unlocked = false; return this.status(); },
    async put(input) {
      if (!unlocked) { const error = new Error('locked'); error.code = 'vault-locked'; throw error; }
      const name = String(input?.name || '');
      if (!name) throw new Error('name required');
      entries.set(name, { name, kind: input.kind || 'password', value: String(input.value || ''), updatedAt: new Date().toISOString() });
      return { name, updatedAt: entries.get(name).updatedAt };
    },
    async get(name) {
      if (!unlocked) { const error = new Error('locked'); error.code = 'vault-locked'; throw error; }
      const entry = entries.get(name);
      if (!entry) { const error = new Error('not-found'); error.code = 'not-found'; throw error; }
      return entry.value;
    },
    async list() {
      return [...entries.values()].map(entry => ({
        name: entry.name,
        kind: entry.kind,
        preview: entry.value.length <= 4 ? '****' : entry.value.slice(-4),
        updatedAt: entry.updatedAt,
      }));
    },
    async remove(name) { return entries.delete(name); },
    async changePassphrase() { return { configured: true, unlocked, count: entries.size, rotatedAt: new Date().toISOString() }; },
    __entries: entries,
    __id: randomUUID(),
  };
}

module.exports = { createMemoryVault };
