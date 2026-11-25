/**
 * 负责：新对话的「即时标题」——第一句话进来就能变成一个能进左侧列表的短标题。
 * 不负责：模型取名（electron/services/chat-title.cjs）、改名与 key 迁移（chat-rename.js）。
 * 被谁调用：npm test / npm run accept。
 *
 * 为什么值得钉：这段以前不存在，左侧列表的标题就是「第一句话的前 36 个字符」，
 * 而模型改名那条路对订阅账号是走不通的（`loadProviderKey()` 对内置订阅 provider 恒返回空串）。
 * 所以这里的输出**就是用户实际看到的标题**，不能把「帮我」「你好」和一堆路径留在上面。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { instantChatTitle, TITLE_MAX_CHARS } from '../src/features/chat/chat-title-text.mjs';

test('去掉开头的「帮我/请/你好」与结尾的语气词', () => {
  assert.equal(instantChatTitle('帮我把登录页改成深色'), '把登录页改成深色');
  assert.equal(instantChatTitle('请看看这个报错是什么意思？'), '看看这个报错是什么意思');
  assert.equal(instantChatTitle('你好，我想问一下 Mova 怎么开自启'), '问一下 Mova 怎么开自启');
  assert.equal(instantChatTitle('能不能把这个函数拆一下呢'), '把这个函数拆一下');
});

test('链接、邮箱与路径不进标题（与模型取名的隐私规则一致）', () => {
  assert.equal(instantChatTitle('帮我看看 https://example.com/a/b 这个页面'), '看看 这个页面');
  assert.equal(instantChatTitle('改一下 electron/chat-agent.mjs 里的超时'), '改一下 里的超时');
  assert.equal(instantChatTitle('发邮件给 someone@example.com 问进度'), '发邮件给 问进度');
  // 整条消息只有链接：退回原文，不能给空标题。
  assert.equal(instantChatTitle('https://example.com/a/b'), 'https://example.com/a/b');
});

test('压成一行、按字符截断、超长加省略号', () => {
  assert.equal(instantChatTitle('第一行\n第二行\t第三行'), '第一行 第二行 第三行');
  assert.equal(instantChatTitle('**加粗** 和 `代码`'), '加粗 和 代码');
  const long = instantChatTitle('一'.repeat(60));
  assert.equal(Array.from(long).length, TITLE_MAX_CHARS + 1, '截断到上限并加一个省略号');
  assert.equal(long.endsWith('…'), true);
  assert.equal(instantChatTitle('短标题', { maxChars: 3 }), '短标题', '正好等于上限时不加省略号');
});

test('空输入与纯噪声都有确定行为（返回空串由调用方兜底）', () => {
  assert.equal(instantChatTitle(''), '');
  assert.equal(instantChatTitle('   '), '');
  assert.equal(instantChatTitle(null), '');
  assert.equal(instantChatTitle(undefined), '');
  assert.equal(instantChatTitle('。。。'), '');
});

test('不改句中内容：只吃紧贴开头/结尾的那一小段', () => {
  assert.equal(instantChatTitle('登录页请改成深色'), '登录页请改成深色', '句中出现的「请」不能动');
  assert.equal(instantChatTitle('A 和 B 的区别'), 'A 和 B 的区别');
});
