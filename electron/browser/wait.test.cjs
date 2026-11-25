const assert = require('node:assert/strict');
const { test } = require('node:test');
const { waitFor, predicate, satisfied, MAX_TIME_WAIT, SETTLE_EXPRESSION } = require('./wait.cjs');

function fakeCdp(values) {
  const queue = Array.isArray(values) ? values.slice() : [values];
  return {
    calls: 0,
    async send() {
      this.calls += 1;
      const value = queue.length > 1 ? queue.shift() : queue[0];
      if (value instanceof Error) throw value;
      return { result: { value } };
    },
  };
}

test('settle waits for DOM quiet instead of a fixed sleep', async () => {
  const cdp = fakeCdp([
    { busy: false, animations: 0, images: 0, quietMs: 20, fonts: 'loaded' },
    { busy: false, animations: 0, images: 0, quietMs: 180, fonts: 'loaded' },
  ]);
  const result = await waitFor(cdp, { for: 'settle', quietMs: 150, timeout: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.condition, 'settle');
  assert.equal(result.value.quietMs, 180);
  assert.ok(cdp.calls >= 2, '第一次 quietMs 不足时必须继续等，不能当成稳定');
});

test('settle keeps waiting while the page is still animating', () => {
  assert.equal(satisfied({ for: 'settle' }, { busy: false, animations: 2, images: 0, quietMs: 900 }), false);
  assert.equal(satisfied({ for: 'settle' }, { busy: true, animations: 0, images: 0, quietMs: 900 }), false);
  assert.equal(satisfied({ for: 'settle' }, { busy: false, animations: 0, images: 1, quietMs: 900 }), false);
  assert.equal(satisfied({ for: 'settle' }, { busy: false, animations: 0, images: 0, quietMs: 200 }), true);
});

test('idle additionally waits for fonts, animation waits for running animations', () => {
  assert.equal(satisfied({ for: 'idle' }, { busy: false, animations: 0, images: 0, quietMs: 900, fonts: 'loading' }), false);
  assert.equal(satisfied({ for: 'idle' }, { busy: false, animations: 0, images: 0, quietMs: 900, fonts: 'loaded' }), true);
  assert.equal(satisfied({ for: 'animation' }, { attached: true, running: 1 }), false);
  assert.equal(satisfied({ for: 'animation' }, { attached: true, running: 0 }), true);
  assert.equal(satisfied({ for: 'animation' }, { attached: false, running: 0 }), false);
});

test('frame waits for the iframe document and reports cross-origin frames', () => {
  assert.equal(satisfied({ for: 'frame', selector: '#f' }, { attached: true, ready: true, crossOrigin: true }), true);
  assert.equal(satisfied({ for: 'frame', selector: '#f' }, { attached: true, ready: false }), false);
  assert.match(predicate({ for: 'frame', selector: '#f' }), /contentDocument/);
  // 也可以用快照里的 frame 编号（f2 = 第二个 iframe），省掉自己写选择器。
  const byFrameId = predicate({ for: 'frame', frame: 'f2' });
  assert.match(byFrameId, /querySelectorAll\('iframe,frame'\)\[1\]/);
});

test('fixed time waits are capped and marked as a last resort', async () => {
  const result = await waitFor(fakeCdp(null), { for: 'time', ms: 999999 });
  assert.equal(result.ms, MAX_TIME_WAIT);
  assert.equal(result.hint, 'prefer-conditional');
});

test('a condition that never becomes true fails as a timeout, not a fake success', async () => {
  const cdp = fakeCdp({ attached: false, visible: false });
  await assert.rejects(waitFor(cdp, { for: 'selector', selector: '#nope', timeout: 150 }), error => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.detail.condition, 'selector');
    return true;
  });
});

test('settle survives a navigation that destroys the execution context', async () => {
  const cdp = fakeCdp([
    Object.assign(new Error('Execution context was destroyed.'), { code: 'evaluate-failed' }),
    { busy: false, animations: 0, images: 0, quietMs: 200 },
  ]);
  const result = await waitFor(cdp, { for: 'settle', quietMs: 150, timeout: 2000 });
  assert.equal(result.ok, true);
});

test('the settle probe installs one observer and keeps the counters in the page', () => {
  assert.match(SETTLE_EXPRESSION, /MutationObserver/);
  assert.match(SETTLE_EXPRESSION, /__movaSettle/);
  assert.throws(() => predicate({ for: 'nonsense' }), /unsupported wait/);
});
