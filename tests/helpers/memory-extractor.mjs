// Deterministic stand-in for the real LLM extractor in repository tests.
// It deliberately returns the same structured shape as memory-extractor.cjs so
// tests exercise the LLM ingestion path without network access.
const REMEMBER = /^(?:请|帮我|麻烦|劳驾)?\s*(?:记住|记一下|记下|记着)[：:,，]?\s*/u;
const PROJECT_DECISION = /^(?:(?:本)?项目(?:数据库)?|我决定|我们决定)\s*(?:决定)?\s*(?:使用|采用|改用|改为)\s*(?:数据库\s*)?(?:MySQL|PostgreSQL|Postgres|SQLite|MariaDB|MongoDB|SQL Server|Oracle)(?:\b|$)/i;

function keyFor(text) {
  return PROJECT_DECISION.test(text.split(/[，,；;]/, 1)[0]) ? 'database' : null;
}

function kindFor(text) {
  if (/决定|改用|改为|decid/i.test(text)) return 'decision';
  if (/偏好|喜欢|习惯|prefer|like/i.test(text)) return 'preference';
  return 'fact';
}

export function createTestExtractor(overrides = {}) {
  return {
    async extract(text) {
      if (overrides.error) throw overrides.error;
      if (typeof overrides.raw === 'function') return overrides.raw(text);
      const memories = [];
      for (const raw of String(text).split(/[\n。！!]+/)) {
        const sentence = raw.trim();
        if (sentence.length < 4 || sentence.length > 500 || /[?？]/.test(sentence)) continue;
        const explicit = REMEMBER.test(sentence);
        const preference = /^(?:我的偏好是|我(?:喜欢|偏好|习惯|通常使用|使用|叫|的名字是|决定)|我们决定)/u.test(sentence)
          || /^(?:remember(?: that)?[,:]?\s+|I (?:prefer|like|use|am called|decided)|my (?:name|preference) is|we (?:decided|will use))/i.test(sentence);
        const project = /^(?:本项目|项目)/u.test(sentence);
        if (!explicit && !preference && !project) continue;
        const clean = sentence.replace(REMEMBER, '').replace(/^(?:please\s+)?remember(?: that)?[,:]?\s*/i, '').trim();
        memories.push({
          text: clean.length >= 2 ? clean : sentence,
          kind: kindFor(sentence),
          key: keyFor(sentence),
          confidence: explicit ? 0.95 : 0.75,
        });
      }
      return {
        memories: memories.slice(0, 5),
        extractor: 'llm',
        providerId: 'test',
        modelId: 'test-extractor',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
    },
    async rerank(_query, candidates, limit) {
      return { ids: candidates.slice(0, limit).map(item => item.id), reranked: true };
    },
  };
}
