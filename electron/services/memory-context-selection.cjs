'use strict';

// Broad recall requests intentionally retain a wider candidate pool. For ordinary
// questions recency and importance alone do not establish topical relevance.
function isBroadRecall(query) {
  return /(?:记得|记住|记忆|回忆|记过|remember|recall|memor(?:y|ies))/i.test(query || '');
}

function selectRelevantCandidates(candidates, query) {
  if (!query?.trim() || isBroadRecall(query)) return candidates;
  return candidates.filter(item => item.pinned === true
    || (item.signals?.lexical ?? 0) >= 0.1
    || (item.signals?.semantic ?? 0) >= 0.15);
}

// Never backfill memories a successful relevance decision did not select.
function selectRerankedCandidates(candidates, ids) {
  const byId = new Map(candidates.map(item => [String(item.id), item]));
  const selected = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id);
    if (byId.has(key) && !seen.has(key)) {
      selected.push(byId.get(key));
      seen.add(key);
    }
  }
  return selected;
}

module.exports = { isBroadRecall, selectRelevantCandidates, selectRerankedCandidates };
