/**
 * 负责：实现 Bot 任务的统一状态机（草稿→待执行→执行中→等待用户/审批/资源→完成/暂停/取消/失败）、对话式自然语言任务与主动频率控制、
 *   IANA 时区感知的触发器调度与重启补发策略（跳过普通问候 / 补发显式提醒并说明延迟 / 副作用任务先核对）、
 *   主动发起聊天引擎（静默时段 22:00-08:00、单 Bot 与全局每日限额、连续忽略降频、话题屏蔽、通知合并），以及 Outbox 幂等投递。
 * 不负责：底层文件写入、LLM 文本生成或 UI 弹窗展示（通过注入 store、conversationService、registry 与 outboxSender 完成）。
 * 被谁调用：electron/bots/runtime.mjs、electron/bots/run-service.mjs、electron/bots/ipc.mjs 及测试。
 */
import { cloneJson, generateId } from './store.mjs';

export const TASK_STATUSES = [
  'draft',
  'pending',
  'running',
  'waiting_info',
  'waiting_approval',
  'waiting_resource',
  'completed',
  'paused',
  'cancelled',
  'failed',
];

const TERMINAL_TASK_STATUSES = new Set(['completed', 'cancelled', 'failed']);

/** 在指定 IANA 时区取得年月日时分，准确应对夏令时与系统时区切换。 */
export function getZonedParts(epochMs, timeZone = 'Asia/Shanghai') {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
    const hour = Number(parts.hour === '24' ? '0' : parts.hour);
    const minute = Number(parts.minute);
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour,
      minute,
      second: Number(parts.second),
      dateKey,
      minutesOfDay: hour * 60 + minute,
    };
  } catch {
    const d = new Date(epochMs);
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const dateKey = d.toISOString().slice(0, 10);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour,
      minute,
      second: d.getUTCSeconds(),
      dateKey,
      minutesOfDay: hour * 60 + minute,
    };
  }
}

function parseHmToMinutes(hm, fallbackMinutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!match) return fallbackMinutes;
  const h = Math.min(23, Math.max(0, Number(match[1])));
  const m = Math.min(59, Math.max(0, Number(match[2])));
  return h * 60 + m;
}

export function isWithinQuietHours(epochMs, { startHm = '22:00', endHm = '08:00', timeZone = 'Asia/Shanghai' } = {}) {
  const start = parseHmToMinutes(startHm, 22 * 60);
  const end = parseHmToMinutes(endHm, 8 * 60);
  const { minutesOfDay } = getZonedParts(epochMs, timeZone);
  if (start === end) return false;
  if (start < end) return minutesOfDay >= start && minutesOfDay < end;
  return minutesOfDay >= start || minutesOfDay < end;
}

/**
 * 计算按指定 IANA 时区每日/每隔一段时间触发的下一个 UTC 时间戳，支持 `HH:MM` 每日 cron 或简单 `daily@HH:MM` / 标准 5 段 `m h * * *`。
 */
export function computeNextFireAt({
  afterMs,
  triggerType = 'cron',
  cronExpr = '0 9 * * *',
  timezone = 'Asia/Shanghai',
  intervalMs = 24 * 3600_000,
}) {
  if (triggerType === 'interval') {
    return afterMs + Math.max(1000, Number(intervalMs) || 3600_000);
  }

  // 解析 `minute hour * * *` 或 `HH:MM`
  let targetMinute = 0;
  let targetHour = 9;
  const cronMatch = /^(\d{1,2})\s+(\d{1,2})\s+/.exec(String(cronExpr || '').trim());
  const hmMatch = /^(\d{1,2}):(\d{2})$/.exec(String(cronExpr || '').trim());
  if (cronMatch) {
    targetMinute = Math.min(59, Math.max(0, Number(cronMatch[1])));
    targetHour = Math.min(23, Math.max(0, Number(cronMatch[2])));
  } else if (hmMatch) {
    targetHour = Math.min(23, Math.max(0, Number(hmMatch[1])));
    targetMinute = Math.min(59, Math.max(0, Number(hmMatch[2])));
  }

  // 从 afterMs 下一分钟起按分钟步进至多 48 小时以精确对齐目标时区的墙上时间（天然兼容夏令时跳变）
  const startSearch = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 48 * 60; i += 1) {
    const candidate = startSearch + i * 60_000;
    const parts = getZonedParts(candidate, timezone);
    if (parts.hour === targetHour && parts.minute === targetMinute) {
      return candidate;
    }
  }
  return afterMs + 24 * 3600_000;
}

export function createTaskService(
  store,
  {
    conversationService,
    runService = null,
    outboxSender = null,
    onEvent = null,
  } = {},
) {
  const clock = store.clock;

  // ── 1. 任务状态机与修订历史 ─────────────────────────────────────────────

  function createTask({
    conversationId = null,
    ownerBotId,
    collaboratorBotIds = [],
    title,
    goal,
    status = 'pending',
    priority = 5,
    budgetConfig = {},
    scheduleConfig = null,
    hasSideEffects = false,
  }) {
    if (!TASK_STATUSES.includes(status)) throw new Error(`无效任务状态: ${status}`);
    return store.mutate(state => {
      const now = clock();
      const task = {
        id: generateId('tsk'),
        conversationId,
        ownerBotId,
        collaboratorBotIds: [...collaboratorBotIds],
        title: String(title || goal || '未命名任务').slice(0, 60),
        goal: String(goal || title || ''),
        status,
        priority,
        budgetConfig: {
          maxSteps: 12,
          maxDurationMs: 120_000,
          allowedTools: ['search', 'memory', 'files'],
          ...cloneJson(budgetConfig),
        },
        scheduleConfig: cloneJson(scheduleConfig),
        hasSideEffects: Boolean(hasSideEffects),
        revisions: [],
        resultSummary: null,
        waitingReason: null,
        createdAt: now,
        updatedAt: now,
      };
      state.tasks.unshift(task);
      return cloneJson(task);
    });
  }

  function listTasks({ conversationId = null, ownerBotId = null, status = null } = {}) {
    return store.state.tasks
      .filter(t => (conversationId ? t.conversationId === conversationId : true))
      .filter(t => (ownerBotId ? t.ownerBotId === ownerBotId : true))
      .filter(t => (status ? t.status === status : true))
      .map(cloneJson);
  }

  function getTask(taskId) {
    const task = store.state.tasks.find(t => t.id === taskId);
    return task ? cloneJson(task) : null;
  }

  function transitionTask(taskId, nextStatus, { reason = null, resultSummary = null } = {}) {
    if (!TASK_STATUSES.includes(nextStatus)) throw new Error(`无效任务状态: ${nextStatus}`);
    return store.mutate(state => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`任务不存在: ${taskId}`);
      task.status = nextStatus;
      if (reason !== null) task.waitingReason = reason;
      if (resultSummary !== null) task.resultSummary = resultSummary;
      task.updatedAt = clock();
      return cloneJson(task);
    });
  }

  function updateTaskGoal(taskId, newGoal, { updatedBy = 'user' } = {}) {
    return store.mutate(state => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`任务不存在: ${taskId}`);
      const now = clock();
      task.revisions.push({
        previousGoal: task.goal,
        newGoal: String(newGoal),
        updatedBy,
        at: now,
      });
      task.goal = String(newGoal);
      task.title = String(newGoal).slice(0, 60);
      task.updatedAt = now;
      if (task.conversationId) {
        const conv = state.conversations.find(c => c.id === task.conversationId);
        if (conv) conv.version += 1;
      }
      return cloneJson(task);
    });
  }

  // ── 2. 对话式任务与主动打扰控制（无独立任务中心页面，全部对话内操控） ───

  function parseAndApplyConversationalControl({ conversationId, botId = null, text }) {
    const clean = String(text || '').trim();
    if (!clean) return { matched: false };

    const targetBotId = botId || store.state.conversations.find(c => c.id === conversationId)?.botId || null;

    if (/^(暂停|先停一下|pause)$/i.test(clean)) {
      const activeTask = store.state.tasks.find(
        t => t.conversationId === conversationId && !TERMINAL_TASK_STATUSES.has(t.status) && t.status !== 'paused',
      );
      if (activeTask) transitionTask(activeTask.id, 'paused', { reason: '用户对话内暂停' });
      runService?.cancelConversationRuns?.(conversationId, 'user_paused');
      return { matched: true, action: 'pause_task', taskId: activeTask?.id || null };
    }

    if (/^(继续|恢复|resume)$/i.test(clean)) {
      const pausedTask = store.state.tasks.find(t => t.conversationId === conversationId && t.status === 'paused');
      if (pausedTask) transitionTask(pausedTask.id, 'running', { reason: null });
      return { matched: true, action: 'resume_task', taskId: pausedTask?.id || null };
    }

    if (/^(取消刚才的任务|取消任务|别做了|cancel)$/i.test(clean)) {
      const activeTask = store.state.tasks.find(
        t => t.conversationId === conversationId && !TERMINAL_TASK_STATUSES.has(t.status),
      );
      if (activeTask) transitionTask(activeTask.id, 'cancelled', { reason: '用户对话内取消' });
      runService?.cancelConversationRuns?.(conversationId, 'user_cancelled');
      return { matched: true, action: 'cancel_task', taskId: activeTask?.id || null };
    }

    if (/少发一点|别总提醒|减少打扰|降频/.test(clean) && targetBotId) {
      store.mutate(state => {
        const bot = state.bots.find(b => b.id === targetBotId);
        if (bot) {
          bot.proactiveConfig.maxDaily = Math.max(0, Number(bot.proactiveConfig.maxDaily ?? 1) - 1);
          if (bot.proactiveConfig.maxDaily === 0) bot.proactiveConfig.enabled = false;
        }
      });
      return { matched: true, action: 'reduce_proactive_frequency', botId: targetBotId };
    }

    if (/只汇报任务/.test(clean) && targetBotId) {
      store.mutate(state => {
        const bot = state.bots.find(b => b.id === targetBotId);
        if (bot) {
          bot.proactiveConfig.mode = 'task_only';
        }
      });
      return { matched: true, action: 'proactive_task_only', botId: targetBotId };
    }

    const muteMatch = /(?:这个话题别再提|别提|屏蔽话题)[:：\s]*([^\s，。！？]{1,24})/.exec(clean);
    if (muteMatch && targetBotId) {
      const topic = muteMatch[1];
      store.mutate(state => {
        const bot = state.bots.find(b => b.id === targetBotId);
        if (bot) {
          bot.proactiveConfig.mutedTopics = [...new Set([...(bot.proactiveConfig.mutedTopics || []), topic])];
        }
      });
      return { matched: true, action: 'mute_topic', botId: targetBotId, topic };
    }

    return { matched: false };
  }

  // ── 3. 时区敏感定时器与重启错过策略（missPolicy） ─────────────────────────

  function createTrigger({
    botId,
    taskId = null,
    conversationId = null,
    triggerType = 'cron', // 'one_shot' | 'cron' | 'interval' | 'event'
    cronExpr = '0 9 * * *',
    runAt = null,
    timezone = null,
    missPolicy = 'skip', // 'skip' | 'catch_up_once' | 'verify_or_ask'
    isExplicitReminder = false,
    hasSideEffects = false,
    message = '定时任务触发',
    intervalMs = 24 * 3600_000,
    topic = null,
  }) {
    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot) throw new Error(`Bot 不存在: ${botId}`);

    const tz = timezone || bot.proactiveConfig?.timezone || store.state.settings.defaultTimezone || 'Asia/Shanghai';
    const now = clock();
    let nextFireAt = null;
    if (triggerType === 'one_shot') {
      nextFireAt = Number(runAt) || now + 60_000;
    } else if (triggerType === 'cron' || triggerType === 'interval') {
      nextFireAt = Number(runAt) || computeNextFireAt({ afterMs: now, triggerType, cronExpr, timezone: tz, intervalMs });
    }

    return store.mutate(state => {
      const trigger = {
        id: generateId('trg'),
        botId,
        taskId,
        conversationId: conversationId || state.conversations.find(c => c.type === 'private' && c.botId === botId)?.id || null,
        triggerType,
        cronExpr,
        runAt,
        timezone: tz,
        missPolicy,
        isExplicitReminder: Boolean(isExplicitReminder),
        hasSideEffects: Boolean(hasSideEffects),
        enabled: true,
        lastFiredAt: null,
        nextFireAt,
        metadata: {
          message,
          intervalMs,
          topic,
        },
      };
      state.triggers.unshift(trigger);
      return cloneJson(trigger);
    });
  }

  /**
   * 评估当前到点触发器，或在应用重启恢复时执行 missPolicy（区分已错过时间窗口）：
   * - 普通问候/关怀 (`missPolicy === 'skip'`): 跳过历史漏触窗口并推进至未来下一次
   * - 显式提醒 (`missPolicy === 'catch_up_once'`): 补发一次并明确说明延迟时间，不重复连环轰炸
   * - 副作用任务 (`missPolicy === 'verify_or_ask'` 或 `hasSideEffects === true`): 挂起为 `waiting_info` 先请用户确认
   */
  async function evaluateDueTriggers({ now = clock(), isStartupRecovery = false } = {}) {
    const actions = [];
    const dueTriggers = store.state.triggers.filter(
      t => t.enabled && t.nextFireAt !== null && t.nextFireAt <= now,
    );

    for (const trg of dueTriggers) {
      const bot = store.state.bots.find(b => b.id === trg.botId);
      if (!bot || bot.status !== 'active') continue;

      const overdueMs = now - trg.nextFireAt;
      const isMissedWindow = isStartupRecovery || overdueMs > 5 * 60_000;

      // 计算下一个未来时间点，防止同一时间窗口重复触发
      const advanceNext = () => {
        store.mutate(state => {
          const row = state.triggers.find(x => x.id === trg.id);
          if (!row) return;
          row.lastFiredAt = now;
          if (row.triggerType === 'one_shot') {
            row.enabled = false;
            row.nextFireAt = null;
          } else {
            row.nextFireAt = computeNextFireAt({
              afterMs: now,
              triggerType: row.triggerType,
              cronExpr: row.cronExpr,
              timezone: row.timezone,
              intervalMs: row.metadata?.intervalMs,
            });
          }
        });
      };

      // 副作用任务错过窗口，绝不盲目自动重放
      if (isMissedWindow && (trg.missPolicy === 'verify_or_ask' || trg.hasSideEffects)) {
        advanceNext();
        if (trg.taskId) transitionTask(trg.taskId, 'waiting_info', { reason: '错过预定执行时间，等待用户确认是否仍需执行' });
        const msgText = `[待确认] 原定于 ${new Date(trg.nextFireAt).toLocaleString('zh-CN', { timeZone: trg.timezone })} 执行的任务「${trg.metadata?.message}」已过计划窗口（带外部副作用）。请确认是否现在补执行？`;
        if (trg.conversationId && conversationService) {
          conversationService.addBotMessage({
            conversationId: trg.conversationId,
            botId: trg.botId,
            content: msgText,
            incrementUnread: true,
          });
        }
        actions.push({ triggerId: trg.id, outcome: 'waiting_verification', overdueMs });
        continue;
      }

      // 普通日常主动问候错过窗口：直接跳过并推进到下一个未来时刻
      if (isMissedWindow && trg.missPolicy === 'skip' && !trg.isExplicitReminder) {
        advanceNext();
        actions.push({ triggerId: trg.id, outcome: 'skipped_missed_window', overdueMs });
        continue;
      }

      // 若属于非显式提醒的普通主动关怀，先过主动关怀门禁（静默时段、每日限额、连续忽略退避、屏蔽话题）
      if (!trg.isExplicitReminder) {
        const verdict = evaluateProactiveCandidate({
          botId: trg.botId,
          now,
          isExplicitReminder: false,
          topic: trg.metadata?.topic || null,
        });
        if (!verdict.allowed) {
          advanceNext();
          actions.push({ triggerId: trg.id, outcome: `blocked_${verdict.reason}` });
          continue;
        }
      }

      // 显式提醒（即使逾期也补发 1 次并说明延迟），或正点触发
      const delayMinutes = Math.max(1, Math.round(overdueMs / 60_000));
      const baseText = String(trg.metadata?.message || '定时提醒');
      const finalText = isMissedWindow && trg.isExplicitReminder
        ? `[补发提醒 · 原定时间已延误约 ${delayMinutes} 分钟] ${baseText}`
        : baseText;

      const dedupeKey = `trg:${trg.id}:${trg.nextFireAt}`;
      enqueueOutbox({
        dedupeKey,
        channel: 'conversation_message',
        targetId: trg.conversationId,
        payload: {
          conversationId: trg.conversationId,
          botId: trg.botId,
          content: finalText,
          incrementUnread: true,
        },
      });
      await flushOutbox();

      if (!trg.isExplicitReminder) {
        recordProactiveSent(trg.botId, now);
      }
      advanceNext();
      try {
        onEvent?.({
          type: 'task:proactive-sent',
          triggerId: trg.id,
          botId: trg.botId,
          conversationId: trg.conversationId,
          isExplicitReminder: Boolean(trg.isExplicitReminder),
          content: finalText,
        });
      } catch {
        // ignore listener failure
      }
      actions.push({ triggerId: trg.id, outcome: isMissedWindow ? 'caught_up_once' : 'fired', finalText });
    }

    return actions;
  }

  // ── 4. 主动交互与主动发起聊天门禁（§8） ─────────────────────────────────

  function evaluateProactiveCandidate({
    botId,
    now = clock(),
    isExplicitReminder = false,
    topic = null,
    isUrgentAlert = false,
  }) {
    if (isExplicitReminder) return { allowed: true, reason: 'explicit_reminder_exempt' };

    const bot = store.state.bots.find(b => b.id === botId);
    if (!bot || bot.status !== 'active') return { allowed: false, reason: 'bot_inactive' };
    if (bot.muted) return { allowed: false, reason: 'bot_muted' };

    const cfg = bot.proactiveConfig || {};
    if (!cfg.enabled || cfg.mode === 'off') return { allowed: false, reason: 'proactive_disabled' };
    if (cfg.mode === 'task_only' && !isUrgentAlert) return { allowed: false, reason: 'task_only_mode' };

    // 屏蔽话题拦截
    if (topic && Array.isArray(cfg.mutedTopics)) {
      const lowerTopic = String(topic).toLowerCase();
      if (cfg.mutedTopics.some(mt => lowerTopic.includes(String(mt).toLowerCase()))) {
        return { allowed: false, reason: 'topic_muted' };
      }
    }

    // 静默时段拦截（默认 22:00 - 08:00）
    const tz = cfg.timezone || store.state.settings.defaultTimezone || 'Asia/Shanghai';
    if (!isUrgentAlert && isWithinQuietHours(now, {
      startHm: cfg.quietHoursStart || store.state.settings.defaultQuietHoursStart || '22:00',
      endHm: cfg.quietHoursEnd || store.state.settings.defaultQuietHoursEnd || '08:00',
      timeZone: tz,
    })) {
      return { allowed: false, reason: 'quiet_hours' };
    }

    // 连续忽略退避（连续 >=3 次忽略自动降频休眠，直到用户再次主动互动）
    if ((cfg.ignoredCount || 0) >= 3) {
      return { allowed: false, reason: 'ignored_backoff' };
    }

    // 每日限额检查：单 Bot 上限（默认 1/天） + 全局上限（默认 2/天）
    const todayKey = getZonedParts(now, tz).dateKey;
    const botDaily = cfg.lastProactiveDate === todayKey ? (cfg.dailyCount || 0) : 0;
    const botCap = cfg.maxDaily ?? store.state.settings.defaultBotMaxDailyProactive ?? 1;
    if (botDaily >= botCap) {
      return { allowed: false, reason: 'bot_daily_quota_exceeded' };
    }

    const globalTodayCount = store.state.bots.reduce((sum, item) => {
      const p = item.proactiveConfig || {};
      const itemKey = getZonedParts(now, p.timezone || tz).dateKey;
      return sum + (p.lastProactiveDate === itemKey ? (p.dailyCount || 0) : 0);
    }, 0);
    const globalCap = store.state.settings.globalMaxDailyProactive ?? 2;
    if (globalTodayCount >= globalCap) {
      return { allowed: false, reason: 'global_daily_quota_exceeded' };
    }

    return { allowed: true, reason: 'allowed' };
  }

  function recordProactiveSent(botId, now = clock()) {
    return store.mutate(state => {
      const bot = state.bots.find(b => b.id === botId);
      if (!bot) return;
      const tz = bot.proactiveConfig?.timezone || state.settings.defaultTimezone || 'Asia/Shanghai';
      const todayKey = getZonedParts(now, tz).dateKey;
      if (bot.proactiveConfig.lastProactiveDate !== todayKey) {
        bot.proactiveConfig.lastProactiveDate = todayKey;
        bot.proactiveConfig.dailyCount = 1;
      } else {
        bot.proactiveConfig.dailyCount = (bot.proactiveConfig.dailyCount || 0) + 1;
      }
      bot.proactiveConfig.ignoredCount = (bot.proactiveConfig.ignoredCount || 0) + 1;
    });
  }

  function recordUserInteractionResetIgnore(botId) {
    return store.mutate(state => {
      const bot = state.bots.find(b => b.id === botId);
      if (bot?.proactiveConfig) bot.proactiveConfig.ignoredCount = 0;
    });
  }

  // ── 5. 事务型 Outbox 与去重幂等投递（§7.4 & §13.7） ────────────────────

  function enqueueOutbox({ dedupeKey, channel = 'conversation_message', targetId = null, payload = {} }) {
    if (!dedupeKey) throw new Error('dedupeKey 不能为空');
    return store.mutate(state => {
      const existing = state.outbox.find(o => o.dedupeKey === dedupeKey);
      if (existing) {
        return { duplicate: true, record: cloneJson(existing) };
      }
      const record = {
        id: generateId('obx'),
        dedupeKey,
        channel,
        targetId,
        payload: cloneJson(payload),
        status: 'pending',
        attempts: 0,
        error: null,
        createdAt: clock(),
        deliveredAt: null,
      };
      state.outbox.push(record);
      return { duplicate: false, record: cloneJson(record) };
    });
  }

  async function flushOutbox() {
    const delivered = [];
    const pending = store.state.outbox.filter(o => o.status === 'pending');

    for (const item of pending) {
      try {
        if (item.channel === 'conversation_message' && conversationService) {
          conversationService.addBotMessage({
            conversationId: item.payload.conversationId,
            botId: item.payload.botId,
            content: item.payload.content,
            structuredPayload: item.payload.structuredPayload || null,
            incrementUnread: Boolean(item.payload.incrementUnread),
          });
        } else if (typeof outboxSender === 'function') {
          await outboxSender(cloneJson(item));
        }

        store.mutate(state => {
          const row = state.outbox.find(o => o.id === item.id);
          if (row) {
            row.status = 'delivered';
            row.attempts += 1;
            row.deliveredAt = clock();
          }
        });
        try { onEvent?.({ type: 'outbox:delivered', item: cloneJson(item) }); } catch { /* ignore */ }
        delivered.push(item.id);
      } catch (err) {
        store.mutate(state => {
          const row = state.outbox.find(o => o.id === item.id);
          if (row) {
            row.attempts += 1;
            row.error = String(err?.message || err);
          }
        });
      }
    }
    return delivered;
  }

  return {
    TASK_STATUSES,
    createTask,
    listTasks,
    getTask,
    transitionTask,
    updateTaskGoal,
    parseAndApplyConversationalControl,
    createTrigger,
    evaluateDueTriggers,
    evaluateProactiveCandidate,
    recordProactiveSent,
    recordUserInteractionResetIgnore,
    enqueueOutbox,
    flushOutbox,
    getZonedParts,
    isWithinQuietHours,
    computeNextFireAt,
  };
}
