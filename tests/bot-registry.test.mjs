/**
 * 负责：测试 BotRegistry 身份与生命周期管理（UUID 不可变、允许重名、安全改名、四条创建通路、模型切换兼容性检查、
 *   克隆/暂停/归档/导入导出、删除前影响面预览与分范围清理，以及 Six-Way 权限交集与非提权委派检验）。
 * 不负责：渲染器 React 组件 UI 测试。
 * 被谁调用：`node --test` 与 `scripts/accept.mjs`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotRuntime } from '../electron/bots/runtime.mjs';

test('BotRegistry: immutable UUID, duplicate names allowed, safe rename preserves history/groups/tasks/mini-apps', async () => {
  let now = 1_700_000_000_000;
  const rt = createBotRuntime({ clock: () => now, initialSeed: true });

  // 允许同名 Bot 共存，并以不同 UUID 区分
  const botA = rt.registry.createBot({ name: '研发搭档', tag: '编程', description: '前端方向' });
  const botB = rt.registry.createBot({ name: '研发搭档', tag: '编程', description: '后端方向' });
  assert.notEqual(botA.id, botB.id);
  assert.equal(botA.name, '研发搭档');
  assert.equal(botB.name, '研发搭档');

  // 关联群聊、私聊、任务与自研小程序
  const priv = rt.conversationService.createPrivateTopicConversation({ botId: botA.id, topic: '架构讨论' });
  rt.conversationService.addBotMessage({ conversationId: priv.id, botId: botA.id, content: '历史消息1' });
  const grp = rt.conversationService.createGroupConversation({ title: '技术群', memberBotIds: [botA.id, botB.id] });
  const task = rt.taskService.createTask({ conversationId: priv.id, ownerBotId: botA.id, title: '重构任务', goal: '拆分模块' });
  const app = rt.miniAppService.incubateMiniApp({
    botId: botA.id,
    conversationId: priv.id,
    spec: { name: '进度板', routes: [{ id: 'overview', title: '总览' }] },
  });

  // 安全改名不破坏任何既有引用关系
  const renamed = rt.registry.renameBot(botA.id, '前端架构师');
  assert.equal(renamed.id, botA.id);
  assert.equal(renamed.name, '前端架构师');
  const reloadedGrp = rt.conversationService.getConversation(grp.id);
  assert.ok(reloadedGrp.memberBotIds.includes(botA.id));
  assert.equal(rt.taskService.getTask(task.id).ownerBotId, botA.id);
  assert.equal(rt.miniAppService.getApp(app.app.appId).createdByBotId, botA.id);
});

test('BotRegistry: 4 creation pathways, model compatibility warnings, clone/pause/archive/import/export', () => {
  const rt = createBotRuntime({ initialSeed: true });

  // 1. 模板创建
  const fromTpl = rt.registry.createFromTemplate('code-reviewer', { name: '代码审查员副本' });
  assert.equal(fromTpl.tag, '编程');

  // 2. 一句话自然语言创建
  const fromNl = rt.registry.createFromNaturalLanguage('帮我建一个叫小夏的设计评审助手，熟悉界面配色，尽量简短');
  assert.equal(fromNl.name, '小夏');
  assert.equal(fromNl.tag, '设计');

  // 3. 自定义表单创建（带 image + high effort 便于测切换警告）
  const custom = rt.registry.createBot({
    name: '多模态专家',
    tag: '设计',
    model: 'gpt-4o',
    capabilityConfig: { model: 'gpt-4o', effort: 'high', tools: ['image', 'files'] },
  });
  assert.equal(custom.capabilityConfig.model, 'gpt-4o');

  // 4. Bot 自主创建受限子 Bot（非提权且无自主创建权限）
  assert.throws(
    () => rt.registry.createAutonomousBot({ creatorBotId: 'helper', payload: { name: '越权子Bot' } }),
    /未被允许自主创建/,
  );
  const child = rt.registry.createAutonomousBot({
    creatorBotId: 'mova',
    payload: {
      name: 'Mova子助手',
      capabilityConfig: { tools: ['search', 'terminal'], browserAllowed: true },
    },
    userApproved: false,
  });
  assert.equal(child.createdByBotId, 'mova');
  assert.equal(child.capabilityConfig.browserAllowed, false);
  assert.equal(child.capabilityConfig.autonomousCreateAllowed, false);
  assert.ok(!child.capabilityConfig.tools.includes('terminal'));

  // 模型切换兼容性警示（deepseek-chat 不支持 vision 与 thinking effort）
  const impact = rt.registry.checkModelSwitchImpact(custom.id, 'deepseek-chat');
  assert.equal(impact.compatible, false);
  assert.ok(impact.warnings.some(w => w.code === 'VISION_UNSUPPORTED'));
  assert.ok(impact.warnings.some(w => w.code === 'THINKING_IGNORED'));

  // 克隆 / 暂停 / 归档 / 导入导出
  const cloned = rt.registry.cloneBot(custom.id);
  assert.notEqual(cloned.id, custom.id);
  assert.match(cloned.name, /副本/);

  const paused = rt.registry.setBotStatus(cloned.id, 'paused');
  assert.equal(paused.status, 'paused');
  const archived = rt.registry.setBotStatus(cloned.id, 'archived');
  assert.equal(archived.status, 'archived');
  assert.equal(rt.registry.listBots({ includeArchived: false }).some(b => b.id === cloned.id), false);

  const exportedJson = rt.registry.exportBotConfig(custom.id);
  const imported = rt.registry.importBotConfig(exportedJson);
  assert.notEqual(imported.id, custom.id);
  assert.equal(imported.name, custom.name);
});

test('BotRegistry: deletion impact preview & scoped cleanup + PolicyGateway non-escalation', () => {
  const rt = createBotRuntime({
    initialSeed: true,
    envCapabilities: { search: true, files: true, memory: true, code: true, browser: false, desktop: false },
    userGrants: { search: true, files: true, memory: true, code: true, browser: true, desktop: true },
  });

  // 6 层交集裁决 & 禁止委派提权
  const evalMov = rt.policyGateway.evaluatePermission({ botId: 'mova', toolName: 'code' });
  assert.equal(evalMov.allowed, true);
  const evalBrowser = rt.policyGateway.evaluatePermission({ botId: 'mova', toolName: 'browser' });
  assert.equal(evalBrowser.allowed, false); // 环境能力不支持 browser

  // helper 仅拥有 ['search', 'memory']，mova 若将 'code' 委派给 helper，不能提权执行
  const deleg = rt.policyGateway.validateDelegation({
    senderBotId: 'mova',
    receiverBotId: 'helper',
    requestedTools: ['search', 'code'],
  });
  assert.equal(deleg.ok, false);
  assert.ok(deleg.deniedTools.includes('code'));
  assert.ok(deleg.effectiveTools.includes('search'));

  // 持久化 paramsHash 防篡改审批验证
  const apr = rt.policyGateway.createApprovalRequest({
    botId: 'mova',
    toolName: 'terminal',
    actionSummary: '执行测试命令',
    boundParams: { cmd: 'npm test', cwd: '/repo' },
  });
  rt.policyGateway.resolveApprovalRequest(apr.id, { decision: 'approved' });
  assert.equal(rt.policyGateway.verifyApprovalForExecution(apr.id, { cmd: 'npm test', cwd: '/repo' }).valid, true);
  assert.equal(rt.policyGateway.verifyApprovalForExecution(apr.id, { cmd: 'rm -rf /', cwd: '/repo' }).reason, 'params_mismatch');

  // 删除影响预览与分范围清理
  const victim = rt.registry.createBot({ name: '临时调研员', tag: '研究' });
  const priv = rt.conversationService.createPrivateTopicConversation({ botId: victim.id, topic: '独立调研' });
  rt.conversationService.addUserMessage({ conversationId: priv.id, content: '帮我查一下' });
  rt.memoryGateway.writeBotMemory({ botId: victim.id, category: 'fact', content: '私有记忆条' });
  const grp = rt.conversationService.createGroupConversation({ title: '临时讨论组', memberBotIds: ['mova', victim.id] });
  rt.conversationService.addBotMessage({ conversationId: grp.id, botId: victim.id, content: '我在群里说过的话' });

  const impact = rt.registry.getDeletionImpact(victim.id);
  assert.equal(impact.privateChats.length, 1);
  assert.equal(impact.groups.length, 1);
  assert.equal(impact.independentMemoryCount, 1);

  rt.registry.deleteBot(victim.id, {
    deletePrivateChats: true,
    deleteIndependentMemories: true,
    keepGroupHistory: true,
  });

  assert.equal(rt.registry.getBot(victim.id), null);
  assert.equal(rt.conversationService.getConversation(priv.id), null);
  assert.equal(rt.store.state.memories.some(m => m.botId === victim.id), false);
  const reloadedGrp = rt.conversationService.getConversation(grp.id);
  const victimMsgs = reloadedGrp.messages.filter(m => m.senderId === victim.id);
  assert.equal(victimMsgs.length, 1);
  assert.match(victimMsgs[0].senderNameSnapshot, /已删除/);
});

test('BotRegistry: persists capabilityConfig.providerId across create, update, and restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mova-bot-reg-'));
  const filePath = path.join(dir, 'bots-state.json');
  try {
    const rt1 = createBotRuntime({ filePath, initialSeed: true });
    const bot = rt1.registry.createBot({
      name: '双模型消歧Bot',
      providerId: 'openai-relay',
      model: 'gpt-4o',
    });
    assert.equal(bot.capabilityConfig.providerId, 'openai-relay');
    assert.equal(bot.capabilityConfig.model, 'gpt-4o');

    const updated = rt1.registry.updateBot(bot.id, {
      providerId: 'anthropic-backup',
      model: 'gpt-4o',
    });
    assert.equal(updated.capabilityConfig.providerId, 'anthropic-backup');

    const rt2 = createBotRuntime({ filePath, initialSeed: false });
    const reloaded = rt2.registry.getBot(bot.id);
    assert.equal(reloaded.capabilityConfig.providerId, 'anthropic-backup');
    assert.equal(reloaded.capabilityConfig.model, 'gpt-4o');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
