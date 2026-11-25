// 中断重试的动作记录（P0-5）：记录层折叠 + 恢复清单渲染。
// 只测两个纯函数：buildActionRecord（记录层）与 renderResumeChecklist（提示层），
// 不启动 Electron、不发请求、不落盘——这样任何一个分支坏了都能单独定位。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { renderResumeChecklist } from '../electron/chat-agent.mjs';

const require = createRequire(import.meta.url);
const { buildActionRecord } = require('../electron/model-ipc.cjs').__test__;
const tool = (id, name, status, detail, label = '操作页面') => ({ type: 'tool', id, name, status, detail, label });

test('same tool called twice produces two records with distinct actionId', () => {
  const records = buildActionRecord([
    tool('call-1', 'browser_act', 'done', 'diff: 表单 3 项已填', '登录按钮 @e12'),
    tool('call-2', 'browser_act', 'done', 'diff: 已进入下一步', '登录按钮 @e12'),
  ]);
  assert.equal(records.length, 2, '同一工具两次调用必须是两条记录');
  assert.notEqual(records[0].actionId, records[1].actionId, '两条记录必须有不同 actionId');
  assert.deepEqual(records.map(item => item.actionId), ['call-1', 'call-2']);
  assert.equal(records[0].evidence, 'diff: 表单 3 项已填', '证据必须来自各自的 detail');
});

test('a running event followed by done updates the same record instead of appending', () => {
  const records = buildActionRecord([
    tool('call-9', 'run_command', 'running', 'npm test', '运行命令'),
    tool('call-9', 'run_command', 'done', '12 passing', '运行命令'),
  ]);
  assert.equal(records.length, 1, 'running → done 只能有一条记录');
  assert.equal(records[0].result, 'done', '后到的状态必须覆盖 running');
  assert.equal(records[0].evidence, '12 passing', '证据要取最新一次结果');
});

test('events without an id fold into the previous undecided record of the same tool', () => {
  const records = buildActionRecord([
    tool(undefined, 'read_file', 'running', '正在读取', '读取文件'),
    tool(undefined, 'read_file', 'done', '120 行', '读取文件'),
  ]);
  assert.equal(records.length, 1, '没有 id 时也要按同名未决记录合并');
  assert.equal(records[0].result, 'done');
  assert.equal(records[0].evidence, '120 行');
});

test('status mapping: denied and error are failures, running stays unknown', () => {
  const records = buildActionRecord([
    tool('a', 'write_file', 'denied', '用户拒绝了写入', '写入文件'),
    tool('b', 'read_file', 'error', '文件不存在', '读取文件'),
    tool('c', 'git_status', 'running', '正在读取', '查看 Git 状态'),
    tool('d', 'list_files', 'done', '12 项', '列出文件'),
  ]);
  assert.deepEqual(records.map(item => item.result), ['failed', 'failed', 'unknown', 'done'],
    'denied/error 记为失败，running 记为未确定');
});

test('unknown results go into the 未确定 group with the observe-before-retry rule', () => {
  const records = buildActionRecord([
    tool('t1', 'browser_act', 'done', 'diff: 表单 3 项已填', '登录按钮 @e12'),
    tool('t2', 'browser_act', 'running', 'diff: 点了提交，结果未知', '提交按钮 @e20'),
  ]);
  const text = renderResumeChecklist(records);
  assert.match(text, /❓ 未确定/, '必须出现「未确定」分组');
  assert.match(text, /先观察/, '未确定分组后面必须有「先观察」强制指令');
  assert.match(text, /不要直接重试/, '必须明确禁止直接重试');
  assert.ok(text.indexOf('✅ 已完成') < text.indexOf('❓ 未确定'), '分组顺序应为 完成 → 未确定');
  assert.match(text, /- browser_act: 登录按钮 @e12 → diff: 表单 3 项已填/, '每行格式为「工具: 目标 → 证据」');
});

test('without unknown actions the forced-instruction line is absent', () => {
  const text = renderResumeChecklist(buildActionRecord([
    tool('t1', 'browser_act', 'done', 'diff: 已登录', '点击登录'),
  ]));
  assert.doesNotMatch(text, /❓ 未确定/, '没有未确定动作时不该出现该分组');
  assert.doesNotMatch(text, /先观察/, '没有未确定动作时不该出现该指令');
});

test('sensitive values never reach the record or the checklist', () => {
  const records = buildActionRecord([
    tool('s1', 'browser_act', 'done', 'password=Str0ngPass! 已填写', '登录表单'),
    tool('s2', 'browser_act', 'done', '验证码：864209 已填写', '短信验证'),
  ]);
  const serialized = JSON.stringify(records) + renderResumeChecklist(records);
  assert.ok(!serialized.includes('Str0ngPass!'), '密码原值不能出现在记录里');
  assert.ok(!serialized.includes('864209'), '验证码原值不能出现在记录里');
  assert.match(serialized, /\[REDACTED\]/, '必须留下脱敏占位，说明这里发生过脱敏');
});

test('detail longer than the evidence limit is truncated instead of stored in full', () => {
  const records = buildActionRecord([
    tool('long', 'browser_read', 'done', '页面正文'.repeat(200), '读取页面'),
  ]);
  assert.ok(records[0].evidence.length <= 200, '证据长度必须受 200 字符上限约束');
  assert.ok(records[0].evidence.endsWith('…'), '截断要有可见标记');
});

test('records are capped at 20 and the most recent calls survive', () => {
  const events = Array.from({ length: 25 }, (_, index) => tool(`c-${index + 1}`, 'read_file', 'done', `${index + 1} 行`));
  const records = buildActionRecord(events);
  assert.equal(records.length, 20, '条数上限为 20');
  assert.equal(records[0].actionId, 'c-6', '截断丢最旧的，保留最近 20 条');
  assert.equal(records.at(-1).actionId, 'c-25');
});

test('records respect the 4000-character budget', () => {
  const events = Array.from({ length: 20 }, (_, index) => tool(
    `b-${index}`, 'browser_act', 'done', '证'.repeat(200), '目'.repeat(120),
  ));
  const records = buildActionRecord(events);
  const total = records.reduce((sum, item) => sum
    + item.actionId.length + item.tool.length + item.target.length + (item.evidence || '').length, 0);
  assert.ok(total <= 4000, `总字符预算约 4000，实际 ${total}`);
  assert.ok(records.length >= 1, '预算裁剪后至少要留一条');
});

test('every rendered line stays within 160 characters', () => {
  const text = renderResumeChecklist(buildActionRecord([
    tool('x1', 'browser_act', 'done', '证'.repeat(200), '目'.repeat(120)),
  ]));
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 160, `单行不得超过 160 字符，实际 ${line.length}：${line.slice(0, 40)}…`);
  }
});

test('legacy {name,status} checkpoints still render the three groups', () => {
  const text = renderResumeChecklist([
    { name: 'read_file', status: 'done' },
    { name: 'write_file', status: 'error' },
    { name: 'run_command', status: 'running' },
  ]);
  assert.match(text, /✅ 已完成/, '旧格式也要渲染「已完成」组');
  assert.match(text, /❌ 失败/, '旧格式也要渲染「失败」组');
  assert.match(text, /❓ 未确定/, '旧格式也要渲染「未确定」组');
  assert.match(text, /- read_file（已完成）/, '旧格式降级为「工具名 + 结果」');
  assert.match(text, /- write_file（失败）/);
  assert.match(text, /先观察/, '旧格式里的 running 同样要带强制指令');
});

test('empty or malformed actions render nothing at all', () => {
  assert.equal(renderResumeChecklist([]), '', '空列表必须返回空字符串');
  assert.equal(renderResumeChecklist(null), '');
  assert.equal(renderResumeChecklist(undefined), '');
  assert.equal(renderResumeChecklist([null, {}, { name: '' }]), '', '无效条目不能渲染出空标题');
});
