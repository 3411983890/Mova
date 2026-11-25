import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

// The file-reference syntax only helps if the model is actually told about it.
// This guard fails loudly if a prompt rewrite drops the instruction again.
test('the project system prompt teaches the file-reference syntax', async () => {
  const source = await readFile(new URL('../electron/chat-agent.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('[[file:relative/path#L12]]'), 'missing [[file:…]] instruction');
  assert.match(source, /right-side viewer/, 'missing destination hint');
  assert.match(source, /never use absolute paths/, 'missing absolute-path guard');
  assert.ok(source.includes('完全访问权限已开启'), 'missing full-access scope note');
});

/**
 * 文件引用从「散文里的一句」升级成「独立槽位 + 规则表 + 正例」。
 * 为什么值得钉住：用户实测的现象是「回答里贴了路径但点不动」，根因就是原来那句话既没有例子、
 * 也没说清「什么时候必须写」。少一条规则，模型就会退回到「路径只在它想说的时候才写」。
 */
test('文件引用是独立槽位：带 path:line 正例、禁绝对路径/file:// /行区间、限定只写碰过的文件', async () => {
  const source = await readFile(new URL('../electron/chat-agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /`electron\/chat-agent\.mjs:1746`/, '必须给出 project-relative:line 的正例');
  assert.match(source, /one path per reference/);
  assert.match(source, /no file:\/\/ URIs/);
  assert.match(source, /no line ranges such as :10-20/);
  assert.match(source, /Only reference files you really touched in this session/);
  // 旧的一句式描述必须已经移出「身份」槽位，否则两处规则会互相冲淡。
  assert.equal(
    source.includes('When you mention a project file the user can open (a path they gave you'),
    false,
    '旧的「散文式」文件引用说明应当已被独立槽位取代',
  );
});

/** 说话方式与计划纪律：三条外部产品里最值得抄的硬约束（如实报告 / 不空响应 / 计划状态机）。 */
test('system prompt 含三条通用纪律：如实报告、工具后必须二选一、计划状态机', async () => {
  const source = await readFile(new URL('../electron/chat-agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /Report what actually happened, not what you intended/);
  assert.match(source, /never end a turn with neither/);
  assert.match(source, /Keep it short by default/);
  assert.match(source, /Plan discipline: exactly one step may be active at a time/);
});
