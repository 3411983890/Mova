'use strict';
// Pure natural-language memory command parser. It never mutates storage; the
// repository decides whether a command is unique enough to execute or must be
// confirmed by the user.

const { normalizeMemoryText } = require('./memory-quality.cjs');

const MAX_TEXT = 2000;
const MAX_QUERY = 500;

function clean(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[“”"'‘’]+|[“”"'‘’]+$/g, '')
    .replace(/[。.!！?？\s]+$/g, '')
    .trim();
}

function command(action, query, replacement, original, extra = {}) {
  const target = clean(query);
  if (!target || target.length > MAX_QUERY) return null;
  return {
    action,
    query: target,
    ...(replacement === undefined ? {} : { replacement: clean(replacement) }),
    original: String(original).trim(),
    ...extra,
  };
}

function isQuestion(text) {
  return /(?:你|您)(?:还)?记得|记得.{0,20}吗|do you remember|what did i (?:say|tell)/i.test(text)
    || /[?？]\s*$/.test(text);
}

function parseMemoryCommand(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_TEXT) return null;
  if (isQuestion(text)) return null;

  const forgetPatterns = [
    /^(?:请|麻烦)?\s*(?:忘记|忘掉|删掉记忆|删除记忆)\s*[：:,，]?\s*(.+)$/u,
    /^(?:请|麻烦)?\s*以后不要再记(?:住)?(?:关于)?\s*(.+?)(?:的内容)?$/u,
    /^(?:please\s+)?forget(?:\s+about)?\s+(.+)$/i,
    /^(?:please\s+)?do not remember\s+(.+)$/i,
  ];
  for (const pattern of forgetPatterns) {
    const match = text.match(pattern);
    if (match) {
      return command('forget', match[1], undefined, text, /以后不要再记|do not remember/i.test(text) ? { blocked: true } : {});
    }
  }

  const correctPatterns = [
    /^(?:请|麻烦)?\s*(?:把|将)\s*(.+?)\s*(?:改成|改为|更正为|更正成|更正|替换为)\s*(.+)$/u,
    /^(?:请|麻烦)?\s*更正\s*(.+?)\s*(?:为|成)\s*(.+)$/u,
    /^(?:please\s+)?(?:change|correct)\s+(.+?)\s+to\s+(.+)$/i,
  ];
  for (const pattern of correctPatterns) {
    const match = text.match(pattern);
    if (match) return command('correct', match[1], match[2], text);
  }
  return null;
}

function findCommandTargets(memories, parsed, options = {}) {
  if (!parsed || !Array.isArray(memories)) return [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 20) : 5;
  const query = normalizeMemoryText(parsed.query);
  if (!query) return [];
  const hits = [];
  for (const memory of memories) {
    if (!memory || typeof memory.text !== 'string' || memory.status === 'disabled' || memory.status === 'superseded') continue;
    const text = normalizeMemoryText(memory.text);
    let score = 0;
    if (text === query) score = 1;
    else if (text.includes(query)) score = 0.85;
    else if (query.includes(text) && text.length >= 2) score = 0.7;
    else {
      const tokens = query.match(/[\u3400-\u9fff]{2,}|[a-z0-9_-]{2,}/gi) || [];
      if (tokens.length) {
        const matched = tokens.filter(token => text.includes(token)).length;
        if (matched) score = 0.5 * (matched / tokens.length);
      }
    }
    if (score > 0) hits.push({ id: memory.id, text: memory.text, score });
  }
  return hits.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

module.exports = { parseMemoryCommand, findCommandTargets, MAX_TEXT, MAX_QUERY };
