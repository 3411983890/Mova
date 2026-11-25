/**
 * ACP（Gemini 订阅）支路的 prompt 契约：**必须在用户原话之前**带上「本地能力说明」，
 * 而 pi-ai 链路的 systemPrompt 一个字都不能沾（两边各说各的，避免串味）。
 *
 * 为什么值得单独一个文件：线上报障是「模型回答『我无法控制 IDE 打开右侧浏览器视图』」——
 * 根因之一是 ACP 只把用户原话当 prompt 发出去，CLI 侧的模型从未被告知 Mova 有内置浏览器
 * （右侧浏览器视图）、设计画板、桌面操控，也不知道浏览器工具是 on_demand、要靠
 * mova_skill_search 发现。这段说明是**每轮都发**的常驻 token，所以同时钉住体积上限。
 *
 * 全部纯内存：只 import 纯函数模块 + 读一次源文件做结构断言（不启动 Electron、不发请求）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { ACP_LOCAL_CAPABILITY_NOTE, ACP_OUTPUT_NOTE, buildAcpConversationContext, composeAcpPrompt } from '../electron/chat-agent-prompt.mjs';

const CHAT_AGENT = new URL('../electron/chat-agent.mjs', import.meta.url);

test('能力说明包含四个关键句：发现入口、导航工具、file:// 的真实限制、行为准则', () => {
  const note = ACP_LOCAL_CAPABILITY_NOTE;
  // 发现入口：浏览器/画板/桌面工具都是 on_demand，不搜索就永远看不见。
  assert.match(note, /mova_skill_search/, '必须写明先用 mova_skill_search 发现工具');
  assert.match(note, /mova_skill_call/, '必须写明再用 mova_skill_call 执行');
  // 「右侧浏览器视图」= 哪个工具，必须点名。
  assert.match(note, /浏览器/, '必须点名内置浏览器');
  assert.match(note, /browser_navigate/, '「在右侧浏览器视图打开」必须映射到 browser_navigate');
  // 本地文件：内置浏览器只导航 http(s)，唯一例外是**已登记项目根内**的可展示类型文件（file:），
  // 所以文案必须同时说清「用 file:///」与「只有项目目录内能打开」，不能承诺任意本地路径。
  assert.match(note, /file:\/\/\//, '必须提到 file:/// 这个形态（项目内的本地页面靠它打开）');
  assert.match(note, /http\(s\)/, '必须说明内置浏览器以 http(s) 为主');
  assert.match(note, /仅限「已登记的项目文件夹」内/, '必须写明 file:/// 只对已登记项目文件夹内的文件生效');
  assert.match(note, /项目外的路径会被拒绝/, '必须写明根外本地路径仍然被拒绝');
  assert.match(note, /html\/svg\/图片\/pdf/, '必须说明只限可展示类型（html/svg/图片/pdf 等）');
  // 行为准则：先调工具，别答「我无法控制」。
  assert.match(note, /我无法控制/, '必须明确禁止「我无法控制」这种回答');
  assert.match(note, /画板/);
  assert.match(note, /桌面/);
});

test('体积上限：不超过 12 行 / 约 400 字（这段每轮都发，等于每轮都在花 token）', () => {
  const lines = ACP_LOCAL_CAPABILITY_NOTE.split('\n');
  assert.ok(lines.length <= 12, `能力说明 ${lines.length} 行，超过 12 行上限`);
  assert.ok(ACP_LOCAL_CAPABILITY_NOTE.length <= 440, `能力说明 ${ACP_LOCAL_CAPABILITY_NOTE.length} 字符，超过约 400 字的上限`);
});

test('composeAcpPrompt：能力说明 → 输出规则 → 用户原话，空输入返回空串', () => {
  const text = '在右侧浏览器视图打开 C:\\Users\\34119\\Documents\\Mova\\design\\index.html';
  const prompt = composeAcpPrompt(text);

  // 用户原话必须完整保留，并且是最后一段（CLI 侧的「当前请求」语义依赖这一点）。
  assert.equal(prompt.endsWith(text), true, '用户原话必须在最末尾，且逐字保留');
  assert.equal(prompt.startsWith(ACP_LOCAL_CAPABILITY_NOTE), true, '能力说明必须在最前面');
  assert.equal(prompt, `${ACP_LOCAL_CAPABILITY_NOTE}\n\n${ACP_OUTPUT_NOTE}\n\n${text}`,
    '拼接形态固定：能力说明 + 输出规则 + 空行 + 原话');

  // 前后空白被 trim，其余一字不改（多行原话里的换行要保留）。
  assert.equal(composeAcpPrompt('  你好  '), `${ACP_LOCAL_CAPABILITY_NOTE}\n\n${ACP_OUTPUT_NOTE}\n\n你好`);
  assert.equal(composeAcpPrompt('第一行\n第二行').endsWith('第一行\n第二行'), true);

  // 空 / 非字符串：返回空串，调用方据此抛 ModelError('request')（不能拼出「只有说明」的 prompt）。
  assert.equal(composeAcpPrompt(''), '');
  assert.equal(composeAcpPrompt('   '), '');
  assert.equal(composeAcpPrompt(null), '');
  assert.equal(composeAcpPrompt(undefined), '');
});

test('输出规则：教文件引用（带正例、禁绝对路径）、如实报告、不空响应、默认简短、内容不可信', () => {
  // CLI 侧的模型完全不知道右侧查看器存在，也没有「可点击路径」的输出习惯——
  // 这条文案是「回答里的路径点不动」的唯一修复点，缺一项就退回到旧现象。
  assert.match(ACP_OUTPUT_NOTE, /行内代码/, '必须点明用行内代码');
  assert.match(ACP_OUTPUT_NOTE, /`electron\/chat-agent\.mjs:1746`/, '必须给出 project-relative:line 的正例');
  assert.match(ACP_OUTPUT_NOTE, /项目相对路径/);
  assert.match(ACP_OUTPUT_NOTE, /改写成相对项目根/, 'Gemini 的 CLI 工具常返回绝对路径，必须要求改写');
  assert.match(ACP_OUTPUT_NOTE, /不要贴盘符/, '必须禁盘符');
  assert.match(ACP_OUTPUT_NOTE, /file:\/\//, '必须禁 file:// URI');
  assert.match(ACP_OUTPUT_NOTE, /行区间/, '必须禁 :10-20 这种行区间');
  // 说话方式与诚实度（摘译自 Claude Code 的 Concise / report-what-happened 与 Gemini CLI 的禁止空响应）
  assert.match(ACP_OUTPUT_NOTE, /只报告真实发生的事/);
  assert.match(ACP_OUTPUT_NOTE, /绝不两头都不做/);
  assert.match(ACP_OUTPUT_NOTE, /默认简短/);
  assert.match(ACP_OUTPUT_NOTE, /不可信数据/, 'ACP 侧以前没有这条：网页内容不可信');
  // 体积上限：这段每轮都发。
  assert.ok(ACP_OUTPUT_NOTE.length <= 900, `输出规则 ${ACP_OUTPUT_NOTE.length} 字符，超过 900 的上限`);
});

test('能力说明只进 ACP 支路：chat-agent.mjs 里它只出现在 composeAcpPrompt 调用处，不在 pi-ai 的 systemPrompt 里', async () => {
  const source = await readFile(CHAT_AGENT, 'utf8');

  // 1) 文案本身只有一处定义（本常量所在模块），chat-agent.mjs 里没有内联副本。
  assert.equal(source.includes('【本地能力】'), false, 'chat-agent.mjs 不许内联这段文案（否则两处会漂移）');
  assert.equal(source.includes('我无法控制'), false, 'chat-agent.mjs 里不该出现这段文案的句子');

  // 2) 导入 + 只用于 ACP 的 prompt 参数。
  assert.match(source, /import \{ [^}]*composeAcpPrompt[^}]*\} from '\.\/chat-agent-prompt\.mjs'/, '必须从纯函数模块导入');
  // 变量名是 promptWithFiles：用户原话 + 非图片附件的文本块（ACP 没有单独的附件通道）。
  assert.match(source, /const acpPrompt = composeAcpPrompt\(promptWithFiles\b/, 'ACP 支路必须用 composeAcpPrompt 拼 prompt（含附件正文）');

  // 3) pi-ai 的 systemPrompt 数组里不许出现这些关键词（那是另一条链路，靠 tools[] 逐条注入）。
  const start = source.indexOf('systemPrompt: [');
  assert.ok(start > 0, '找不到 pi-ai 的 systemPrompt 数组');
  const end = source.indexOf("].join(' ')", start);
  assert.ok(end > start, '找不到 systemPrompt 数组的结束标记');
  const systemPrompt = source.slice(start, end);
  for (const token of ['【本地能力】', 'mova_skill_search', 'composeAcpPrompt', 'file:///']) {
    assert.equal(systemPrompt.includes(token), false, `pi-ai 的 systemPrompt 里不该出现 ${token}（会串味）`);
  }

  // 4) 反证：ACP 支路传给 engine 的确实是拼好的那一份，而不是原始 prompt。
  assert.match(source, /prompt: acpPrompt/, 'engine.runTurn 必须收到拼好的 prompt');
});

test('图片不许在 ACP 支路被静默丢掉：落盘/暂存 → 取真实路径 → 作为文本块进入 prompt，并回传 image 事件', async () => {
  const source = await readFile(CHAT_AGENT, 'utf8');

  // 以前图片在这里被 attachmentTextBlocks 过滤掉：渲染层看得到缩略图，模型什么都没收到。
  assert.match(source, /imageLocationBlocks\(await Promise\.all\(imageRows\.map/, '图片必须作为「文件位置」块拼进 prompt');
  // 普通会话：路径必须与 saveImage 真正写入的目录同源，否则模型拿到一个不存在的路径。
  assert.match(source, /imageFilePath\(row\.id\)/, '路径必须来自 chat-images（与实际落盘目录同源）');
  // 临时会话：图片只在内存里，先复制到系统临时目录再给路径（本轮结束必须删）。
  assert.match(source, /openImageStaging\(\)/, '临时会话必须建一次性暂存目录，否则只能告诉模型「读不到」');
  assert.match(source, /await staging\?\.dispose\?\.\(\)/, 'finally 必须删掉暂存目录（成功/失败/取消都要走到）');
  // 渲染层靠这个事件把「占位图」换成真实 id（重试那一轮也才有图可带）。
  assert.match(source, /type: 'image', id: saved\.id/, '落盘后必须发 image 事件，否则占位图永远替换不掉');
  // 失败不能拖垮整轮：必须 catch 并转成「读不到」的说明，而不是抛错。
  assert.match(source, /unavailable: typeof error\?\.message === 'string'/, '保存/暂存失败要转成如实说明，不能中断对话');
});

// ── 上下文块：ACP 每轮都是新进程 + 新 session，CLI 侧没有任何上文 ──────────────
test('上下文块：历史按时间正序、记忆在后，用户原话仍然是最后一段', () => {
  const context = buildAcpConversationContext({
    messages: [
      { role: 'user', text: '把 design/index.html 打开' },
      { role: 'assistant', text: '已经打开了。' },
    ],
    memory: [{ text: '用户偏好深色主题', source: 'pref' }],
  });
  assert.match(context, /【最近的对话】/);
  assert.match(context, /用户：把 design\/index\.html 打开/);
  assert.match(context, /助手：已经打开了。/);
  assert.ok(context.indexOf('用户：') < context.indexOf('助手：'), '历史必须按时间正序');
  assert.match(context, /【相关记忆】/);
  assert.match(context, /用户偏好深色主题/, '记忆要带上原文');

  const prompt = composeAcpPrompt('那把它改成浅色', context);
  assert.ok(prompt.endsWith('那把它改成浅色'), '用户原话永远在最后');
  assert.ok(prompt.indexOf('【最近的对话】') < prompt.indexOf('那把它改成浅色'), '上下文在用户原话之前');
});

test('上下文块：没有历史也没有记忆时返回空串，prompt 只剩两段固定说明', () => {
  assert.equal(buildAcpConversationContext({}), '');
  assert.equal(buildAcpConversationContext({ messages: [], memory: [] }), '');
  assert.equal(composeAcpPrompt('你好'), `${ACP_LOCAL_CAPABILITY_NOTE}\n\n${ACP_OUTPUT_NOTE}\n\n你好`);
  assert.equal(composeAcpPrompt('你好', ''), composeAcpPrompt('你好'), '空上下文不能改变拼接结果');
});

test('上下文块：预算从最新往旧装，丢的是更早的，不丢最新的那一轮', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index} 条消息 ${'x'.repeat(200)}`,
  }));
  const context = buildAcpConversationContext({ messages, maxChars: 900 });
  assert.ok(context.length <= 1_000, `上下文块超预算：${context.length}`);
  assert.match(context, /第 39 条消息/, '最新一条必须留下');
  assert.equal(context.includes('第 0 条消息'), false, '最早的必须被丢掉');
  assert.match(context, /更早的已省略/);
});

test('上下文块：只收 user/assistant 两种角色，其它角色跳过', () => {
  const context = buildAcpConversationContext({
    messages: [
      { role: 'system', text: '你是助手' },
      { role: 'tool', text: '工具结果' },
      { role: 'user', text: '真实提问' },
    ],
  });
  assert.match(context, /用户：真实提问/);
  assert.equal(context.includes('你是助手'), false, 'system 不进这段（CLI 有自己的 system prompt）');
  assert.equal(context.includes('工具结果'), false);
});

test('上下文块：记忆最多 5 条、单条截断并加省略号；过预算的整条丢弃', () => {
  const memory = Array.from({ length: 9 }, (_, index) => ({ text: `记忆 ${index} ${'y'.repeat(900)}` }));
  const context = buildAcpConversationContext({ memory });
  const lines = context.split('\n').filter(line => line.startsWith('- '));
  assert.ok(lines.length <= 5, `记忆条数超上限：${lines.length}`);
  assert.match(lines[0], /…$/, '单条超长必须截断并标省略号');
  // 记忆按检索结果的相关性排序，所以保留的是**最前面**几条；超出上限的靠后的才丢。
  assert.equal(context.includes('记忆 5'), false, '超过 5 条之后的记忆不该出现');
});

// ── 记忆条目的可追溯性：短 id + 更新时间 ──────────────────────────────────
test('上下文块：每条记忆带 8 位短 id 与「更新于 YYYY-MM-DD」（updatedAt 优先，createdAt 兜底）', () => {
  const context = buildAcpConversationContext({
    memory: [
      {
        id: '8f14e45f-0f9e-4f1a-9c2b-3d4e5f607182', text: '用户偏好深色主题',
        source: 'user', updatedAt: '2026-11-01T09:30:00.000Z',
      },
      // 只有 createdAt（老数据没有 updatedAt）：日期必须退化到 createdAt，不能整段消失。
      { id: 'abcdef1234567890', text: '项目用 Node 24', createdAt: '2026-05-06T00:00:00.000Z' },
      // 什么都没有：正文照旧要带，id/日期各自省略，不许丢条目。
      { text: '没有 id 也没有时间的旧数据' },
    ],
  });
  assert.match(context, /- \[8f14e45f\] 更新于 2026-11-01 · 用户偏好深色主题（user）/,
    '短 id（前 8 位）与日期必须紧跟在破折号后面，模型据此调 memory_update');
  assert.match(context, /- \[abcdef12\] 更新于 2026-05-06 · 项目用 Node 24/,
    '没有 updatedAt 时用 createdAt');
  assert.match(context, /- 没有 id 也没有时间的旧数据/, 'id/时间缺失时不能丢掉正文');
  for (const match of context.matchAll(/- \[([^\]]+)\] 更新于/g)) {
    assert.equal(match[1].length, 8, `短 id 必须是 8 个字符：${match[1]}`);
  }
});

test('上下文块：记忆超预算时丢更旧的，保留更新的那几条', () => {
  const memory = [
    { id: 'aaaaaaaa-1111', text: `旧记忆 ${'x'.repeat(120)}`, updatedAt: '2025-01-01T00:00:00.000Z' },
    { id: 'bbbbbbbb-2222', text: `新记忆 ${'y'.repeat(120)}`, updatedAt: '2026-11-01T00:00:00.000Z' },
  ];
  // 预算刚好装得下一条 + 一点：新的留下，旧的整条丢弃（绝不截半条）。
  const context = buildAcpConversationContext({ memory, maxChars: 180 });
  assert.match(context, /新记忆/, '更新的那条必须留下');
  assert.equal(context.includes('旧记忆'), false, '超预算时丢的是更旧的那条');
  assert.ok(context.length <= 400, `上下文块超预算：${context.length}`);
});

test('上下文块：记忆按更新时间倒序装（同一批数据，新的先出现在块的上面）', () => {
  const context = buildAcpConversationContext({
    memory: [
      { id: 'old00000-1', text: '较早的记忆', updatedAt: '2025-03-01T00:00:00.000Z' },
      { id: 'new00000-2', text: '较新的记忆', updatedAt: '2026-09-01T00:00:00.000Z' },
    ],
  });
  assert.ok(context.indexOf('较新的记忆') < context.indexOf('较早的记忆'),
    '越新的记忆越靠前（越靠前越不会被预算丢掉）');
});
