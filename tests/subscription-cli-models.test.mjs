// `agy models` 的解析与调用约定。
//
// 背景：`agy` 1.5.8 没有 auth/login 子命令，`agy models` 才是「这台机器是否已授权」的判据，
// 也是 Gemini 侧唯一真实的模型来源（实测 18 个模型）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyModelLabel, effortsFromLabel, groupModels, listCliModels, nameFromLabel,
  parseModelsOutput, resolveVariantId,
} from '../electron/subscription/cli-models.mjs';

const SAMPLE = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)',
  '',
].join('\n');

test('parseModelsOutput reads tab-separated id/label pairs and skips chatter', () => {
  const models = parseModelsOutput(SAMPLE);
  assert.equal(models.length, 4, '提示行与空行要被跳过');
  assert.deepEqual(models[0], {
    id: 'gemini-4-argon-medium',
    label: 'Gemini 4 Argon (Medium)',
    name: 'Gemini 4 Argon',
    efforts: ['medium'],
  });
  assert.equal(models[3].id, 'gemini-pro-orchestrator-g1-pro');
  assert.deepEqual(models[3].efforts, [], '没有括注就没有档位，不能瞎猜');
});

test('parseModelsOutput also accepts multi-space separators and de-dupes ids', () => {
  const models = parseModelsOutput([
    'gemini-3.8-flash-low    Gemini 3.8 Flash (Low)',
    'gemini-3.8-flash-low    Gemini 3.8 Flash (Low)',
  ].join('\n'));
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].efforts, ['low']);
});

test('parseModelsOutput ignores lines that are not model rows', () => {
  assert.deepEqual(parseModelsOutput('Error: not logged in\n\n  \n'), []);
  assert.deepEqual(parseModelsOutput(undefined), []);
});

test('effortsFromLabel maps the documented suffixes', () => {
  assert.deepEqual(effortsFromLabel('Gemini 4 Hydrogen (XHigh)'), ['xhigh']);
  assert.deepEqual(effortsFromLabel('Gemini 4 Argon (High)'), ['high']);
  assert.deepEqual(effortsFromLabel('Something (Low)'), ['low']);
  assert.deepEqual(effortsFromLabel('Gemini Pro'), []);
});

test('nameFromLabel drops a trailing parenthetical only', () => {
  assert.equal(nameFromLabel('Gemini 4 Argon (High)'), 'Gemini 4 Argon');
  assert.equal(nameFromLabel('Orchestrator (Argon)'), 'Orchestrator (Argon)', '不是档位括注就保留');
});

test('listCliModels returns models when the CLI prints them', async () => {
  const result = await listCliModels({
    command: 'agy.exe',
    exec: async (command, args) => {
      assert.deepEqual(args, ['models'], '只能问 models 子命令');
      return { stdout: SAMPLE, stderr: '', code: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 4);
  assert.equal(result.detail, '');
});

test('listCliModels explains an empty list instead of pretending success', async () => {
  const result = await listCliModels({
    command: 'agy.exe',
    exec: async () => ({ stdout: 'Fetching available models...\n', stderr: '', code: 0 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /no_models/, '空清单要能区分「没登录」而不是「命令错了」');
});

test('listCliModels surfaces a non-zero exit with the CLI stderr', async () => {
  const result = await listCliModels({
    command: 'agy.exe',
    exec: async () => ({ stdout: '', stderr: 'auth required', code: 3 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /cli_exit_3/);
  assert.match(result.detail, /auth required/);
});

test('listCliModels never throws when exec fails', async () => {
  const result = await listCliModels({
    command: 'agy.exe',
    exec: async () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /exec_failed/);
});

test('listCliModels refuses to run without a command', async () => {
  const result = await listCliModels({ command: '', exec: async () => ({ stdout: SAMPLE }) });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'no_exec');
});

// ACP 报的 18 条（实测 session/new 的真实清单）。
const ACP_MODELS = [
  ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
  ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
  ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'],
  ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
  ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Medium)'],
  ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Low)'],
  ['gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
  ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)'],
  ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
].map(([id, label]) => ({ id, label }));

test('classifyModelLabel splits family and effort from the label', () => {
  assert.deepEqual(classifyModelLabel('gemini-4-argon-high', 'Gemini 4 Argon (High)'), {
    familyId: 'gemini-4-argon', familyLabel: 'Gemini 4 Argon', effort: 'high', variantId: 'gemini-4-argon-high',
  });
  // XHigh 不能被 high 抢先命中。
  assert.equal(classifyModelLabel('gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)').effort, 'xhigh');
});

test('classifyModelLabel falls back to the id suffix when the label has no parenthesis', () => {
  const result = classifyModelLabel('gemini-3.8-flash-low', 'Gemini 3.8 Flash');
  assert.equal(result.effort, 'low');
  assert.equal(result.familyId, 'gemini-3.8-flash');
});

test('classifyModelLabel leaves a single-model entry alone', () => {
  const result = classifyModelLabel('gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)');
  assert.equal(result.effort, '');
  assert.equal(result.familyId, 'gemini-pro-orchestrator-g1-pro');
  assert.equal(result.familyLabel, 'Orchestrator (Argon)');
});

test('groupModels merges the 18 advertised ids into one row per family', () => {
  const grouped = groupModels(ACP_MODELS);
  assert.equal(grouped.length, 7, '18 条档位合并成 7 个模型');
  const byId = Object.fromEntries(grouped.map(model => [model.id, model]));
  assert.deepEqual(byId['gemini-4-argon'].efforts, ['low', 'medium', 'high'], '档位按规范顺序排列');
  assert.deepEqual(byId['gemini-4-hydrogen'].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(byId['gemini-4-argon'].name, 'Gemini 4 Argon');
  assert.deepEqual(byId['gemini-4-argon'].variants, {
    low: 'gemini-4-argon-low',
    medium: 'gemini-4-argon-medium',
    high: 'gemini-4-argon-high',
  });
  assert.deepEqual(byId['gemini-pro-orchestrator-g1-pro'].efforts, [], '无档位模型不该有档位');
  assert.deepEqual(byId['gpt-oss-120b'].efforts, ['medium'], '只有一个档位的模型也走同一条合并规则');
});

test('groupModels is idempotent: grouping an already-merged catalog changes nothing', () => {
  const once = groupModels(ACP_MODELS);
  const twice = groupModels(once);
  assert.deepEqual(twice.map(model => model.id), once.map(model => model.id));
  assert.deepEqual(twice.map(model => model.efforts), once.map(model => model.efforts));
});

test('resolveVariantId maps the chosen effort to the id agy actually accepts', () => {
  const argon = groupModels(ACP_MODELS).find(model => model.id === 'gemini-4-argon');
  assert.equal(resolveVariantId(argon, 'high'), 'gemini-4-argon-high');
  assert.equal(resolveVariantId(argon, 'low'), 'gemini-4-argon-low');
  // 没有这个档位时取最近的档位：`max` 落到 `high`，比回传家族 id（agy 不认）安全。
  assert.equal(resolveVariantId(argon, 'max'), 'gemini-4-argon-high');
  assert.equal(resolveVariantId(argon, 'minimal'), 'gemini-4-argon-low');
  assert.equal(resolveVariantId(argon, 'nonsense'), 'gemini-4-argon-high');
  assert.equal(resolveVariantId({ id: 'custom-model' }, 'high'), 'custom-model');
  assert.equal(resolveVariantId(null, 'high'), '');
});
