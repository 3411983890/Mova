/**
 * 负责：守住「旧的手写工具装配不会从备份里被粘回来」这条纪律——直接读 electron/chat-agent.mjs
 *   的源码，断言旧实现的名字一个都不在：`buildMovaHandlers`（Step 6 删掉的旧工具表）、
 *   `legacyToolTable` / `isLegacyTurn`（旧路径的开关壳）、`MOVA_SKILLS_SSOT`（旧路径的环境变量）。
 * 不负责：语法/行为（tests/pi-chat、tests/skills-wiring 跑真实装配），也不负责历史备份文件。
 * 被谁调用：node --test。纯读文件，零副作用。
 *
 * 为什么用正则读源码而不是「跑一遍」：被禁的正是「多出来的一份实现」，而它在运行时是惰性的
 * （只有环境变量打开才走），跑测试永远发现不了。源码断言是唯一能挡住它的地方。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const SOURCE_URL = new URL('../electron/chat-agent.mjs', import.meta.url);

/** 去掉行注释与块注释，避免「注释里提到旧名字」被误判（也避免注释里藏实现）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('chat-agent.mjs 里不再有旧的手写工具装配（buildMovaHandlers / legacyToolTable / MOVA_SKILLS_SSOT）', async () => {
  const source = await readFile(SOURCE_URL, 'utf8');
  assert.ok(source.length > 10_000, '读到的是真的 chat-agent.mjs');

  const code = stripComments(source);
  for (const banned of ['buildMovaHandlers', 'legacyToolTable', 'isLegacyTurn', 'MOVA_SKILLS_SSOT']) {
    assert.equal(code.includes(banned), false,
      `${banned} 必须已被删除（旧实现不允许以任何形式留在源码里；回滚用 .code-backups 快照，不是分支）`);
  }
});

test('两条链路都经同一个技能运行时装配（runChatAgent 与 runAcpSubscriptionTurn 各一次）', async () => {
  const source = await readFile(SOURCE_URL, 'utf8');
  const calls = source.split('createSkillRuntimeForTurn(').length - 1;
  assert.equal(calls, 2,
    `装配函数应当正好被调用两次（pi-ai 主循环 + ACP 支路），实际 ${calls} 次`);
  assert.match(source, /toPiAiTools\(/, 'pi-ai 的 tools[] 必须由适配层投影，不能手写数组');
});

test('pi-ai 侧不再手写目标/记忆/上下文工具的描述数组', async () => {
  const source = await readFile(SOURCE_URL, 'utf8');
  const code = stripComments(source);
  // 这些名字现在只该出现在 packs/** 的 manifest 里；chat-agent 里再写一份就是双份定义。
  for (const banned of ["name: 'set_goal'", "name: 'accept_goal'", "name: 'update_goal'", "name: 'set_plan'", "name: 'memory_search'", "name: 'memory_read_source'", "name: 'ask_user'", "name: 'request_approval'"]) {
    assert.equal(code.includes(banned), false, `chat-agent.mjs 不该再手写 ${banned}（定义在 skills/packs）`);
  }
});
