// 站点技能「模型判断」模式：设置默认/校验/迁移，以及不落盘的候选逻辑。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrowserSettings, normalize, defaults, SKILL_MODES } = require('../electron/browser/settings.cjs');
const { skillCandidateOf } = require('../electron/browser/controller.cjs');
const { fingerprintOf, stepsFromTrace } = require('../electron/browser/procedures.cjs');

const BASE = () => defaults('/tmp/downloads');
const modeOf = input => normalize(input, BASE()).skills.mode;

const URL_CART = 'https://shop.example.com/cart';
const TRACE_3 = [
  { op: 'navigate', url: URL_CART },
  { op: 'click', selector: '#coupon' },
  { op: 'fill', selector: '#code', value: 'SAVE10', saveValue: true },
];
const TRACE_2 = [
  { op: 'click', selector: '#coupon' },
  { op: 'fill', selector: '#code', value: 'SAVE10', saveValue: true },
];

test('skills default to model and expose only the mode key', () => {
  assert.deepEqual(SKILL_MODES, ['model', 'always', 'off']);
  assert.deepEqual(defaults('/tmp/downloads').skills, { mode: 'model' });
  assert.deepEqual(Object.keys(normalize(null, BASE()).skills), ['mode']);
  assert.equal(normalize({}, BASE()).skills.mode, 'model');
});

test('mode accepts the three documented values and falls back for anything else', () => {
  assert.equal(modeOf({ skills: { mode: 'always' } }), 'always');
  assert.equal(modeOf({ skills: { mode: 'off' } }), 'off');
  assert.equal(modeOf({ skills: { mode: 'model' } }), 'model');
  assert.equal(modeOf({ skills: { mode: 'root' } }), 'model', '未知模式回落默认');
  assert.equal(modeOf({ skills: 'off' }), 'model', '非对象不猜');
});

test('legacy autoRecord only maps to off when it was explicitly false', () => {
  assert.equal(modeOf({ skills: { autoRecord: false } }), 'off');
  assert.equal(modeOf({ skills: { autoRecord: true } }), 'model', 'autoRecord:true 不能变成静默记录');
  assert.equal(modeOf({ skills: {} }), 'model');
  assert.equal(modeOf({ skills: { promptAtThreeSteps: false } }), 'model', '旧提示开关不再影响模式');
  assert.equal(modeOf({ skills: { promptAtThreeSteps: true } }), 'model');
  assert.equal(modeOf({ skills: { mode: 'off', autoRecord: true } }), 'off', '显式 mode 优先');
});

test('old settings files migrate on read and stop writing dead keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mova-skills-mode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'settings.json');
  await writeFile(filePath, JSON.stringify({ skills: { autoRecord: false, promptAtThreeSteps: true } }), 'utf8');

  const store = createBrowserSettings({ filePath, defaultDownloadsDir: dir });
  assert.equal(store.read().skills.mode, 'off');
  assert.deepEqual(store.read().skills, { mode: 'off' });

  store.patch({ skills: { mode: 'always' } });
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(saved.skills, { mode: 'always' });

  const reopened = createBrowserSettings({ filePath, defaultDownloadsDir: dir });
  assert.equal(reopened.read().skills.mode, 'always');
  assert.deepEqual(Object.keys(reopened.read().skills), ['mode'], '旧键不再回写');
});

test('batch success of three or more http(s) steps yields a candidate', () => {
  const candidate = skillCandidateOf({ trace: TRACE_3, url: URL_CART, title: '  领取优惠券 ', existing: [] });
  assert.ok(candidate);
  assert.deepEqual(Object.keys(candidate).sort(), ['origin', 'pathPattern', 'stepCount', 'title']);
  assert.equal(candidate.origin, 'https://shop.example.com');
  assert.equal(candidate.pathPattern, '/cart');
  assert.equal(candidate.stepCount, 3);
  assert.equal(candidate.title, '领取优惠券');
});

test('too few steps, non-http pages and known fingerprints produce no candidate', () => {
  assert.equal(skillCandidateOf({ trace: TRACE_2, url: URL_CART, existing: [] }), null, '少于 3 步不提示');
  assert.equal(skillCandidateOf({ trace: [], url: URL_CART, existing: [] }), null);
  assert.equal(skillCandidateOf({ trace: TRACE_3, url: 'file:///c:/tmp/a.html', existing: [] }), null, '非 http(s) 不记录');
  assert.equal(skillCandidateOf({ trace: TRACE_3, url: 'about:blank', existing: [] }), null);

  const fingerprint = fingerprintOf(stepsFromTrace(TRACE_3));
  const sameSite = [{ origin: 'https://shop.example.com', fingerprint }];
  assert.equal(skillCandidateOf({ trace: TRACE_3, url: URL_CART, existing: sameSite }), null, '指纹去重');
  const otherSite = [{ origin: 'https://other.example.com', fingerprint }];
  assert.ok(skillCandidateOf({ trace: TRACE_3, url: URL_CART, existing: otherSite }), '别的站点同步骤不算重复');
});

test('candidate title falls back to the path pattern', () => {
  const candidate = skillCandidateOf({ trace: TRACE_3, url: URL_CART });
  assert.equal(candidate.title, '/cart');
  assert.equal(skillCandidateOf({ trace: TRACE_3, url: 'https://shop.example.com/' }).title, '/');
});
