'use strict';
// verify.cjs 接进引擎的护栏：
//  1) pixels 条件本身能判（同图 → pixels-unchanged，变图 → ok + meanAbsDiff）
//  2) session.verify({conditions}) 会把条件交给 verify.cjs 的条件引擎，而不是只看 ΔTree
//  3) 条件失败时返回该条件的错误码（不再一律 no-change）
const test = require('node:test');
const assert = require('node:assert');

const { createVerifier, CODES } = require('../../electron/desktop/verify.cjs');
const { createSession } = require('../../electron/desktop/session.cjs');

/** 生成一张纯色 PNG（sharp 是仓库依赖，不需要 Electron）。 */
async function frame(rgb, size = 24) {
  const sharp = require('sharp');
  const buffer = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  }).png().toBuffer();
  return { buffer };
}

test('pixels 条件：同一张图判 pixels-unchanged', async () => {
  const verifier = createVerifier({ sharp: require('sharp') });
  const before = await frame([10, 10, 10]);
  const after = await frame([10, 10, 10]);
  const verdict = await verifier.check({ kind: 'pixels', before, after }, { timeoutMs: 0 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.PIXELS_UNCHANGED);
});

test('pixels 条件：换了颜色的图判通过，并给出 meanAbsDiff', async () => {
  const verifier = createVerifier({ sharp: require('sharp') });
  const before = await frame([10, 10, 10]);
  const after = await frame([200, 200, 200]);
  const verdict = await verifier.check({ kind: 'pixels', before, after }, { timeoutMs: 0 });
  assert.equal(verdict.ok, true);
  assert.ok(verdict.detail.meanAbsDiff > 0.5, `meanAbsDiff=${verdict.detail.meanAbsDiff}`);
});

test('pixels 条件：缺图返回 pixels-unavailable，不抛', async () => {
  const verifier = createVerifier({ sharp: require('sharp') });
  const verdict = await verifier.check({ kind: 'pixels', before: null, after: null }, { timeoutMs: 0 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.PIXELS_UNAVAILABLE);
});

function makeSession(checkImpl) {
  const calls = [];
  const session = createSession({
    deps: {
      windows: {
        tree: async () => ({ nodes: [], window: { hwnd: 7, title: '记事本' } }),
        foreground: async () => ({ hwnd: 7, title: '记事本' }),
      },
      verify: {
        check: async (condition, ctx) => {
          calls.push({ condition, timeoutMs: ctx && ctx.timeoutMs });
          return checkImpl(condition);
        },
      },
    },
  });
  return { session, calls };
}

test('session.verify({conditions}) 走条件引擎，不走 ΔTree', async () => {
  const { session, calls } = makeSession(() => ({ ok: true, code: CODES.OK, detail: { meanAbsDiff: 0.3 } }));
  const started = await session.start({});
  assert.equal(started.ok, true);
  const verdict = await session.verify({ hwnd: 7, conditions: [{ kind: 'pixels' }], timeoutMs: 0 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.changed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].condition.kind, 'pixels');
});

test('条件失败时把条件自己的 code 透出来（不再一律 no-change）', async () => {
  const { session } = makeSession(() => ({ ok: false, code: CODES.PIXELS_UNCHANGED, detail: { meanAbsDiff: 0.001 } }));
  await session.start({});
  const verdict = await session.verify({ hwnd: 7, conditions: [{ kind: 'pixels' }], timeoutMs: 0 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.PIXELS_UNCHANGED);
  assert.equal(verdict.conditions[0].kind, 'pixels');
});

test('多条条件时遇到第一个失败就停', async () => {
  let seen = 0;
  const { session } = makeSession(() => {
    seen += 1;
    return seen === 1 ? { ok: true, code: CODES.OK } : { ok: false, code: CODES.NOT_FOCUSED };
  });
  await session.start({});
  const verdict = await session.verify({
    hwnd: 7,
    timeoutMs: 0,
    conditions: [{ kind: 'pixels' }, { kind: 'focused' }, { kind: 'text' }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.NOT_FOCUSED);
  assert.equal(seen, 2, '第三个条件不该被执行');
});

test('没有 conditions 时保持原有 ΔTree 行为', async () => {
  const { session, calls } = makeSession(() => ({ ok: true, code: CODES.OK }));
  await session.start({});
  const verdict = await session.verify({ hwnd: 7, timeoutMs: 0 }).catch(() => null);
  assert.equal(calls.length, 0, '不该调用条件引擎');
  // 没有基线树时 ΔTree 会报 no-change / no-baseline 之类，总之不是条件引擎的返回
  assert.ok(verdict === null || verdict.ok === false || verdict.changed === false);
});
