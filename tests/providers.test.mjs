import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeModel, inferEfforts, normalizeBaseUrl } from '../electron/providers.cjs';
import { validHost } from '../electron/site-icons.cjs';

test('normalizes provider base URLs for each protocol', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com', 'openai'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/', 'openai'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://4router.net/v1', 'anthropic'), 'https://4router.net');
  assert.equal(normalizeBaseUrl('https://api.anthropic.com/', 'anthropic'), 'https://api.anthropic.com');
  assert.throws(() => normalizeBaseUrl('ftp://api.example.com', 'openai'), { code: 'invalid_url' });
  assert.throws(() => normalizeBaseUrl('https://api.example.com?key=1', 'openai'), { code: 'invalid_url' });
});

test('reads multimodal capability and thinking efforts from a provider catalog entry', () => {
  const claude = describeModel({
    id: 'claude-opus-5-5',
    display_name: 'Claude-5.5 Opus',
    input_modalities: ['text', 'image'],
    reasoning_efforts: ['low', 'high', 'xhigh'],
  });
  assert.deepEqual(claude, { id: 'claude-opus-5-5', name: 'Claude-5.5 Opus', vision: true, efforts: ['low', 'high', 'xhigh'] });

  const deepseek = describeModel({
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    architecture: { input_modalities: ['text'] },
    reasoning: { efforts: ['high', 'max'] },
  });
  assert.equal(deepseek.vision, false);
  assert.deepEqual(deepseek.efforts, ['high', 'max']);

  assert.equal(describeModel({ id: 'has space' }), null);
  assert.equal(describeModel(null), null);
});

test('infers thinking levels when a provider does not declare them', () => {
  assert.deepEqual(inferEfforts('claude-sonnet-5-5'), ['low', 'medium', 'high']);
  assert.deepEqual(inferEfforts('deepseek-r1'), ['low', 'medium', 'high']);
  assert.deepEqual(inferEfforts('deepseek-v4-pro'), ['low', 'high', 'max']);
  assert.deepEqual(inferEfforts('glm-5.1'), []);
});

test('accepts only public hostnames for favicon lookups', () => {
  assert.equal(validHost('www.reddit.com'), 'www.reddit.com');
  assert.equal(validHost('reddit.com.'), 'reddit.com');
  assert.equal(validHost('127.0.0.1'), null);
  assert.equal(validHost('localhost'), null);
  assert.equal(validHost('internal.lan'), null);
  assert.equal(validHost('https://reddit.com'), null);
});
