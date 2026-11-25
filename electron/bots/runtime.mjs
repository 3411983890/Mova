/**
 * 负责：装配完整的 Mova Bot 运行时门面（Store、Registry、PolicyGateway、MemoryGateway、ConversationService、
 *   EventRouter、RunService、TaskService、MiniAppService、BotCollabTools），管理事件广播与后台调度巡检生命周期。
 * 不负责：Electron BrowserWindow/IPC 绑定细节（由 electron/bots/ipc.mjs 负责）。
 * 被谁调用：electron/bots/ipc.mjs 及完整集成测试。
 */
import { EventEmitter } from 'node:events';
import { createBotStore, cloneJson } from './store.mjs';
import { createBotRegistry } from './registry.mjs';
import { createPolicyGateway } from './policy-gateway.mjs';
import { createMemoryGateway } from './memory-gateway.mjs';
import { createConversationService } from './conversation-service.mjs';
import { createEventRouter } from './router.mjs';
import { createRunService } from './run-service.mjs';
import { createTaskService } from './task-service.mjs';
import { createMiniAppService } from './mini-app-service.mjs';
import { createBotCollabTools } from './skills-pack.mjs';

export function createBotRuntime({
  filePath = null,
  pgPool = null,
  clock = () => Date.now(),
  initialSeed = true,
  externalChatProvider = null,
  modelRunner = null,
  envCapabilities = undefined,
  userGrants = undefined,
  schedulerIntervalMs = 30_000,
  autoStartScheduler = false,
  logger = console,
} = {}) {
  const emitter = new EventEmitter();
  const emitEvent = event => {
    emitter.emit('event', event);
  };

  const store = createBotStore({ filePath, pgPool, clock, initialSeed, logger });
  const registry = createBotRegistry(store);
  const policyGateway = createPolicyGateway(store, { envCapabilities, userGrants });
  const memoryGateway = createMemoryGateway(store, { externalChatProvider });
  const conversationService = createConversationService(store);
  const router = createEventRouter(store, { policyGateway });
  const miniAppService = createMiniAppService(store, { policyGateway, conversationService });

  const runService = createRunService({
    store,
    registry,
    conversationService,
    memoryGateway,
    router,
    policyGateway,
    miniAppService,
    modelRunner,
    onEvent: emitEvent,
  });

  const taskService = createTaskService(store, {
    conversationService,
    runService,
    onEvent: emitEvent,
  });

  const collabTools = createBotCollabTools({
    memoryGateway,
    router,
    conversationService,
    miniAppService,
    policyGateway,
  });

  let schedulerTimer = null;

  async function startupRecovery() {
    const recovered = await taskService.evaluateDueTriggers({ now: clock(), isStartupRecovery: true });
    await taskService.flushOutbox();
    if (recovered.length > 0) {
      emitEvent({ type: 'scheduler:recovered', count: recovered.length, recovered });
    }
    return recovered;
  }

  function startScheduler() {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => {
      void taskService.evaluateDueTriggers({ now: clock(), isStartupRecovery: false }).catch(err => {
        logger?.warn?.('[bot-runtime] scheduler tick failed:', err?.message || err);
      });
    }, Math.max(1000, schedulerIntervalMs));
    schedulerTimer.unref?.();
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  if (autoStartScheduler) {
    void startupRecovery();
    startScheduler();
  }

  /**
   * 统一用户消息发送入口：
   * 1. 重置主动消息连续忽略计数；
   * 2. 若属于对话内自然语言任务/频率控制（“暂停”“继续”“取消刚才的任务”“少发一点”“只汇报任务”“这个话题别再提…”），直接执行并给可见简短反馈；
   * 3. 否则走完整多 Bot 路由、静默内部委派与模型响应管线。
   */
  async function sendUserMessage({
    conversationId,
    content,
    mentions = [],
    replyToMessageId = null,
    attachments = [],
    waitForCompletion = true,
  }) {
    const conv = store.state.conversations.find(c => c.id === conversationId);
    if (!conv) throw new Error(`会话不存在: ${conversationId}`);

    if (conv.type === 'private' && conv.botId) {
      taskService.recordUserInteractionResetIgnore(conv.botId);
    }

    const ctrl = taskService.parseAndApplyConversationalControl({
      conversationId,
      botId: conv.botId,
      text: content,
    });

    if (ctrl.matched) {
      const { message: userMsg, conversationVersion } = conversationService.addUserMessage({
        conversationId,
        content,
        mentions,
        replyToMessageId,
        attachments,
      });
      const ackMap = {
        pause_task: '好的，已暂停当前任务。你可以随时说「继续」。',
        resume_task: '好的，已恢复任务执行。',
        cancel_task: '已取消刚才的任务。',
        reduce_proactive_frequency: '明白了，之后我会减少主动打扰频率。',
        proactive_task_only: '明白，接下来我只汇报正式任务进展，不再发闲聊关怀。',
        mute_topic: `好的，之后不再主动提起「${ctrl.topic}」。`,
      };
      const replyBotId = conv.botId
        || store.state.conversationMembers.find(m => m.conversationId === conversationId && m.memberType === 'bot' && !m.leftAt)?.memberId
        || 'mova';
      const botRes = conversationService.addBotMessage({
        conversationId,
        botId: replyBotId,
        content: ackMap[ctrl.action] || '已按你的指令调整。',
        expectedConversationVersion: conversationVersion,
      });
      emitEvent({ type: 'conversation:updated', conversationId });
      return {
        controlApplied: ctrl,
        userMessage: userMsg,
        conversationVersion,
        emittedMessages: botRes.message ? [botRes.message] : [],
        internalEvents: [],
      };
    }

    const turnResult = await runService.handleUserTurn({
      conversationId,
      content,
      mentions,
      replyToMessageId,
      attachments,
      waitForCompletion,
    });
    emitEvent({ type: 'conversation:updated', conversationId });
    return { controlApplied: { matched: false }, ...turnResult };
  }

  function getRuntimeSettings() {
    return cloneJson(store.state.settings);
  }

  function updateRuntimeSettings(patch = {}) {
    return store.mutate(state => {
      state.settings = {
        ...state.settings,
        ...cloneJson(patch),
      };
      emitEvent({ type: 'settings:updated', settings: cloneJson(state.settings) });
      return cloneJson(state.settings);
    });
  }

  function shouldKeepAliveOnWindowClose() {
    if (!store.state.settings.keepAliveOnWindowClose) return false;
    const hasActiveTasks = store.state.tasks.some(
      t => ['pending', 'running', 'waiting_info', 'waiting_approval', 'waiting_resource'].includes(t.status),
    );
    const hasEnabledTriggers = store.state.triggers.some(t => t.enabled);
    return hasActiveTasks || hasEnabledTriggers;
  }

  function dispose() {
    stopScheduler();
    emitter.removeAllListeners();
  }

  return {
    store,
    registry,
    policyGateway,
    memoryGateway,
    conversationService,
    router,
    runService,
    taskService,
    miniAppService,
    collabTools,
    sendUserMessage,
    startupRecovery,
    startScheduler,
    stopScheduler,
    getRuntimeSettings,
    updateRuntimeSettings,
    shouldKeepAliveOnWindowClose,
    dispose,
    onEvent(handler) {
      emitter.on('event', handler);
      return () => emitter.off('event', handler);
    },
  };
}
