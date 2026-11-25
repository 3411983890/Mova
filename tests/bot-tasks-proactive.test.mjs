/**
 * 负责：验证统一任务状态机与 revisions 记录、对话内指令控制（暂停/继续/取消/少发一点/只汇报任务/这个话题别再提）、
 *   IANA 时区与夏令时触发计算、应用重启错过窗口的三种 missPolicy（skip/catch_up_once/verify_or_ask）、
 *   主动关怀静默时段（22:00-08:00）、每日限额与连续忽略退避、以及 Outbox 幂等去重投递。
 * 不负责：操作系统底层定时器精度与系统通知 UI 测验。
 * 被谁调用：`node --test` 与 `scripts/accept.mjs`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotRuntime } from '../electron/bots/runtime.mjs';
import { computeNextFireAt, isWithinQuietHours } from '../electron/bots/task-service.mjs';

test('TaskService: state machine, revisions, conversational controls & proactive quotas/quiet-hours/backoff', async () => {
  // 2026-06-01T14:00:00Z = 北京时间 22:00:00（处于默认静默时段）
  const quietUtcMs = Date.UTC(2026, 5, 1, 14, 30, 0);
  // 2026-06-01T02:00:00Z = 北京时间 10:00:00（白天非静默时段）
  let now = Date.UTC(2026, 5, 1, 2, 0, 0);

  const rt = createBotRuntime({ clock: () => now, initialSeed: true });
  const task = rt.taskService.createTask({
    conversationId: 'mova',
    ownerBotId: 'mova',
    title: '整理旅行行程',
    goal: '整理3天行程方案',
    status: 'running',
  });

  // 修改目标记录 revisions 并推进会话 version
  const v0 = rt.conversationService.getConversation('mova').version;
  const revised = rt.taskService.updateTaskGoal(task.id, '整理5天日本关西行程方案');
  assert.equal(revised.revisions.length, 1);
  assert.equal(revised.revisions[0].previousGoal, '整理3天行程方案');
  assert.ok(rt.conversationService.getConversation('mova').version > v0);

  // 对话内操控：暂停 -> 继续 -> 取消刚才的任务 -> 少发一点 -> 只汇报任务 -> 这个话题别再提
  const pauseCmd = rt.taskService.parseAndApplyConversationalControl({ conversationId: 'mova', botId: 'mova', text: '暂停' });
  assert.equal(pauseCmd.action, 'pause_task');
  assert.equal(rt.taskService.getTask(task.id).status, 'paused');

  const resumeCmd = rt.taskService.parseAndApplyConversationalControl({ conversationId: 'mova', botId: 'mova', text: '继续' });
  assert.equal(resumeCmd.action, 'resume_task');
  assert.equal(rt.taskService.getTask(task.id).status, 'running');

  const cancelCmd = rt.taskService.parseAndApplyConversationalControl({ conversationId: 'mova', botId: 'mova', text: '取消刚才的任务' });
  assert.equal(cancelCmd.action, 'cancel_task');
  assert.equal(rt.taskService.getTask(task.id).status, 'cancelled');

  rt.taskService.parseAndApplyConversationalControl({ conversationId: 'mova', botId: 'mova', text: '这个话题别再提天气' });
  assert.equal(
    rt.taskService.evaluateProactiveCandidate({ botId: 'mova', now, topic: '今日天气预报' }).reason,
    'topic_muted',
  );

  rt.taskService.parseAndApplyConversationalControl({ conversationId: 'mova', botId: 'mova', text: '只汇报任务' });
  assert.equal(
    rt.taskService.evaluateProactiveCandidate({ botId: 'mova', now, topic: '闲聊问候' }).reason,
    'task_only_mode',
  );

  // 静默时段拦截 + 显式定时提醒豁免
  const pBot = rt.registry.createBot({
    name: '晨报助理',
    proactiveConfig: { enabled: true, maxDaily: 2, timezone: 'Asia/Shanghai', quietHoursStart: '22:00', quietHoursEnd: '08:00' },
  });
  assert.equal(isWithinQuietHours(quietUtcMs, { startHm: '22:00', endHm: '08:00', timeZone: 'Asia/Shanghai' }), true);
  assert.equal(
    rt.taskService.evaluateProactiveCandidate({ botId: pBot.id, now: quietUtcMs }).reason,
    'quiet_hours',
  );
  assert.equal(
    rt.taskService.evaluateProactiveCandidate({ botId: pBot.id, now: quietUtcMs, isExplicitReminder: true }).allowed,
    true,
  );

  // 每日配额与连续忽略退避（连续 3 次忽略 -> ignored_backoff；用户互动重置后恢复）
  rt.taskService.recordProactiveSent(pBot.id, now);
  rt.taskService.recordProactiveSent(pBot.id, now);
  assert.equal(rt.taskService.evaluateProactiveCandidate({ botId: pBot.id, now }).reason, 'bot_daily_quota_exceeded');

  // 换到次日再推 1 次累计满 3 次忽略 -> 进入 ignored_backoff
  const nextDay = now + 24 * 3600_000;
  rt.taskService.recordProactiveSent(pBot.id, nextDay);
  assert.equal(rt.taskService.evaluateProactiveCandidate({ botId: pBot.id, now: nextDay }).reason, 'ignored_backoff');

  rt.taskService.recordUserInteractionResetIgnore(pBot.id);
  assert.equal(rt.taskService.evaluateProactiveCandidate({ botId: pBot.id, now: nextDay + 24 * 3600_000 }).allowed, true);
});

test('TaskService: IANA timezone DST trigger calculation, startup missPolicy & transactional Outbox deduplication', async () => {
  let now = Date.UTC(2026, 5, 1, 5, 0, 0);
  const rt = createBotRuntime({ clock: () => now, initialSeed: true });
  const emittedEvents = [];
  rt.onEvent(evt => emittedEvents.push(evt));

  // 跨美国夏令时切入（2026-03-08 02:00 America/New_York 跳变）测试：computeNextFireAt 能产出未来有效时间戳
  const beforeDst = Date.UTC(2026, 2, 8, 6, 0, 0); // 01:00 EST
  const nextNy = computeNextFireAt({ afterMs: beforeDst, triggerType: 'cron', cronExpr: '0 9 * * *', timezone: 'America/New_York' });
  assert.ok(nextNy > beforeDst);
  const nyLocal = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(nextNy);
  assert.equal(nyLocal, '09');

  // 创建 3 个过去时间点触发器：验证重启恢复 missPolicy
  const pastDue = now - 60 * 60_000;
  // 1) 普通关怀 -> skip
  const tSkip = rt.taskService.createTrigger({
    botId: 'planner',
    conversationId: 'mova',
    cronExpr: '0 9 * * *',
    runAt: pastDue,
    missPolicy: 'skip',
    isExplicitReminder: false,
    message: '早安问候',
  });
  // 2) 显式提醒 -> catch_up_once
  const tCatch = rt.taskService.createTrigger({
    botId: 'planner',
    conversationId: 'mova',
    triggerType: 'one_shot',
    runAt: pastDue,
    missPolicy: 'catch_up_once',
    isExplicitReminder: true,
    message: '提交周报提醒',
  });
  // 3) 带外部副作用任务 -> verify_or_ask
  const sideTask = rt.taskService.createTask({ conversationId: 'mova', ownerBotId: 'planner', title: '发送外部邮件', hasSideEffects: true });
  const tSide = rt.taskService.createTrigger({
    botId: 'planner',
    taskId: sideTask.id,
    conversationId: 'mova',
    triggerType: 'one_shot',
    runAt: pastDue,
    missPolicy: 'verify_or_ask',
    hasSideEffects: true,
    message: '批量发邮件给客户',
  });

  const actions = await rt.startupRecovery();
  const byId = new Map(actions.map(a => [a.triggerId, a]));
  assert.equal(byId.get(tSkip.id).outcome, 'skipped_missed_window');
  assert.equal(byId.get(tCatch.id).outcome, 'caught_up_once');
  assert.match(byId.get(tCatch.id).finalText, /补发提醒/);
  assert.equal(byId.get(tSide.id).outcome, 'waiting_verification');
  assert.equal(rt.taskService.getTask(sideTask.id).status, 'waiting_info');
  assert.ok(emittedEvents.some(e => e.type === 'task:proactive-sent' && e.triggerId === tCatch.id && e.conversationId === 'mova'));

  // Outbox 幂等去重：相同 dedupeKey 不会重复入队投递
  const o1 = rt.taskService.enqueueOutbox({ dedupeKey: 'k-once', payload: { conversationId: 'mova', botId: 'planner', content: '唯一消息' } });
  const o2 = rt.taskService.enqueueOutbox({ dedupeKey: 'k-once', payload: { conversationId: 'mova', botId: 'planner', content: '唯一消息' } });
  assert.equal(o1.duplicate, false);
  assert.equal(o2.duplicate, true);
});
