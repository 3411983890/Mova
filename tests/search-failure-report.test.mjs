import test from 'node:test';
import assert from 'node:assert/strict';

import { createSearchService } from '../electron/search/index.cjs';
import { createCache } from '../electron/search/cache.cjs';
import { createBudget } from '../electron/search/budget.cjs';
import { formatEvidence } from '../electron/search/pack.cjs';
import { SearchProviderError } from '../electron/search/providers/errors.cjs';

const offlineProvider = (id, error) => ({
  id,
  label: id,
  hasExtract: false,
  async search() { throw error; },
});

const service = providers => createSearchService({
  providers,
  cache: createCache(),
  limits: { queries: 4, reads: 0, chars: 1000, ms: 5000 },
});

test('every provider unreachable is reported as a failure, not as "no sources exist"', async () => {
  const search = service([
    offlineProvider('anysearch', new SearchProviderError('anysearch', 0)),
    offlineProvider('tavily', new SearchProviderError('tavily', 503)),
  ]);
  const result = await search.search({
    queries: ['香港故宫 2025 特展'],
    options: { readCount: 0 },
    budget: createBudget({ queries: 4, reads: 0, chars: 1000, ms: 5000 }),
  });

  assert.equal(result.meta.candidates, 0);
  assert.equal(result.meta.failed, 2, 'one query × two providers = two failed attempts');
  assert.deepEqual([...result.meta.failedSources].sort(), ['anysearch', 'tavily']);

  const packed = formatEvidence(result.evidence, { ...result.meta, queries: ['香港故宫 2025 特展'] });
  assert.match(packed, /请求失败/);
  assert.match(packed, /不代表网上没有资料/);
  assert.doesNotMatch(packed, /没有找到可用的公开来源/);
});

test('a partial failure still returns usable sources and reports the failed count', async () => {
  const good = {
    id: 'anysearch',
    label: 'AnySearch',
    hasExtract: false,
    async search(query) {
      return [{
        url: 'https://www.hkpm.org.hk/tc/exhibition',
        title: '香港故宮文化博物館 | 展覽',
        snippet: '2025 年特展',
        content: '',
        published: null,
        provider: 'anysearch',
        query,
        rank: 1,
      }];
    },
  };
  const search = service([good, offlineProvider('tavily', new SearchProviderError('tavily', 0))]);
  const result = await search.search({
    queries: ['香港故宫 2025 特展'],
    options: { readCount: 0 },
    budget: createBudget({ queries: 4, reads: 0, chars: 1000, ms: 5000 }),
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.meta.failed, 1);
  const packed = formatEvidence(result.evidence, { ...result.meta, queries: ['香港故宫 2025 特展'] });
  assert.match(packed, /\[1\]/);
  assert.match(packed, /1 次检索请求失败/);
  assert.doesNotMatch(packed, /不能据此认为/);
});

test('a clean miss keeps the plain "no usable sources" wording', async () => {
  const search = service([{
    id: 'anysearch',
    label: 'AnySearch',
    hasExtract: false,
    async search() { return []; },
  }]);
  const result = await search.search({
    queries: ['something obscure'],
    options: { readCount: 0 },
    budget: createBudget({ queries: 4, reads: 0, chars: 1000, ms: 5000 }),
  });

  assert.equal(result.meta.failed, 0);
  const packed = formatEvidence(result.evidence, { ...result.meta, queries: ['something obscure'] });
  assert.match(packed, /没有找到可用的公开来源/);
  assert.doesNotMatch(packed, /请求失败/);
});
