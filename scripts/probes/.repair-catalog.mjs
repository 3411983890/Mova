/**
 * 修复被截断的模型目录：Gemini 用当前 agy 的实时清单重新合并，ChatGPT 用内置默认目录。
 * 只写 subscription-models.json，不碰凭据。
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import { acpDescribe } from '../../electron/subscription/acp-auth.mjs';
import { groupModels } from '../../electron/subscription/cli-models.mjs';
import subscriptionModels from '../../electron/subscription-models.cjs';

const userData = process.env.APPDATA ? `${process.env.APPDATA}\\Mova` : homedir();
subscriptionModels.configureUserDataDir(() => userData);

const before = await subscriptionModels.readCatalog();
console.log('before: gemini=%d chatgpt=%d', before.providers.gemini.models.length, before.providers.chatgpt.models.length);

const described = await acpDescribe({
  spawn,
  command: 'C:\\Users\\34119\\AppData\\Local\\agy\\bin\\agy.exe',
  env: process.env,
  cwd: userData,
  timeoutMs: 60_000,
});
console.log('acp: ok=%s models=%d authorized=%s', described.ok, described.models.length, described.authorized);

if (described.models.length > 0) {
  const merged = groupModels(described.models.map(model => ({
    id: model.id,
    label: model.label || model.id,
    vision: true,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  })));
  await subscriptionModels.saveProvider('gemini', { models: merged });
  console.log('gemini restored: %d raw -> %d merged', described.models.length, merged.length);
} else {
  console.log('gemini NOT restored (agy 没有返回模型)');
}

const chatgpt = subscriptionModels.DEFAULT_CATALOG.chatgpt.models.map(model => ({ ...model, efforts: [...model.efforts] }));
await subscriptionModels.saveProvider('chatgpt', { models: chatgpt });
console.log('chatgpt restored:', chatgpt.length);

const after = await subscriptionModels.readCatalog();
for (const target of ['chatgpt', 'gemini']) {
  const models = after.providers[target].models;
  console.log(`\n${target}: ${models.length}`);
  for (const model of models) {
    console.log('  ', model.id, '|', model.name, '|', JSON.stringify(model.efforts), '|', JSON.stringify(model.variants ?? {}));
  }
}
