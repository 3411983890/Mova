const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PageTarget } = require('./target.cjs');

function fakeGuest() {
  return {
    id: 1,
    isDestroyed: () => false,
    getURL: () => 'https://shop.example.com/cart',
    getTitle: () => '购物车',
    isLoading: () => false,
    on() {},
    removeListener() {},
    debugger: { isAttached: () => false, on() {}, removeListener() {} },
  };
}

test('download wait resolves on a terminal state instead of sleeping', async () => {
  const target = new PageTarget({ guest: fakeGuest() });
  target.lastDownload = { filename: 'setup.exe', state: 'blocked', reason: 'executable' };
  const result = await target.wait({ for: 'download', timeout: 2000 });
  assert.equal(result.condition, 'download');
  assert.equal(result.state, 'blocked');
  assert.equal(result.download.reason, 'executable');
});

test('a download that never finishes is a determinate timeout', async () => {
  const target = new PageTarget({ guest: fakeGuest() });
  target.downloadItem = { getState: () => 'progressing' };
  await assert.rejects(target.wait({ for: 'download', timeout: 250 }), error => {
    assert.equal(error.code, 'download-timeout');
    assert.equal(error.detail.condition, 'download');
    return true;
  });
});

test('a completed download reports its final path', async () => {
  const target = new PageTarget({ guest: fakeGuest() });
  target.lastDownload = { filename: 'report.pdf', path: 'C:\\tmp\\report.pdf', state: 'completed', bytes: 10 };
  const result = await target.wait({ for: 'download', timeout: 500 });
  assert.equal(result.state, 'completed');
  assert.equal(result.download.path, 'C:\\tmp\\report.pdf');
});
