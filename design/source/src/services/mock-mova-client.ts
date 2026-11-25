import type { ChatRequest, MovaClient, ReplyEvent } from './mova-client';

function wait(signal: AbortSignal, ms = 260): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/* 演示脚本：一条回复里跑遍前端现有的所有展示能力。
   顺序 = 思考 → 联网搜索 → 运行命令 → 写代码（工具行）→ 读取图片 → 正文（Markdown）→ 第二轮思考 → 正文续写。 */
const SOURCES = [
  { title: 'Mova 设置页设计规范 · 内容列与 66% 边界', url: 'https://github.com/mova/design/blob/main/settings.md', site: 'github' },
  { title: 'Keyline Icons — 圆角图标库', url: 'https://keyline.design', site: 'notion' },
  { title: 'Phosphor Icons 使用说明', url: 'https://phosphoricons.com', site: 'reddit' },
];

const ANSWER_HEAD = [
  '## 你好 👋',
  '',
  '我是 Mova 里的**模拟回复**通道。下面这条回复把前端现有的展示能力一次跑完，方便你直接检查 UI：',
  '',
  '- 思考过程（可展开，带展开动画与摘要）',
  '- 联网搜索 `AnySearch` · 带来源站点图标',
  '- 运行命令 · 终端卡片 + 复制按钮',
  '- 写代码 · 工具行 + 代码块复制',
  '- 读取图片 · 缩略图卡片',
  '- Markdown：标题、表格、引用、列表、链接、行内代码',
].join('\n');

const ANSWER_TABLE = [
  '### 当前设置的几项关键约定',
  '',
  '| 项目 | 数值 | 出处 |',
  '| --- | --- | --- |',
  '| 内容列 | `min(718px, 100% - 48px)` | 设置页规范 3.1 |',
  '| 行内文字边界 | `66%` | 设置页规范 3.3 |',
  '| 强调色 | `#3795f5` / `#2f6bd8` | 设置页规范 4.4 |',
  '',
  '> 引用块示例：背景只用 `#181818` 与 `#161616` 两档，绿、青色调已全部去掉；强调色只保留蓝色。',
  '',
  '```ts',
  'export function columnWidth(panel: number) {',
  '  return Math.min(718, panel - 48);',
  '}',
  '```',
  '',
  '- [x] 无彩色背景',
  '- [x] 蓝色强调',
  '- [ ] 浅色主题（待设计）',
  '',
  '参考：[Keyline Icons](https://keyline.design) · [Phosphor Icons](https://phosphoricons.com)',
].join('\n');

const ANSWER_TAIL = [
  '以上**全部是本地模拟内容**，没有调用真实模型，也不会写入任何数据。',
  '',
  '想继续检查的话，可以：① 点开上面的「思考」「运行命令」「读取图片」；② 点来源展开网站列表；③ 复制命令或代码；④ 在输入框里点停止，看中断态。',
].join('\n');

const DEMO: { delay: number; event: ReplyEvent }[] = [
  { delay: 220, event: { type: 'thinking', id: '1:think', round: 1, text: '用户只发了「你好」，没有具体任务。这种情况下不该急着给结论，先确认自己能做什么，并把可以展示的执行过程走一遍：搜索、运行命令、写代码、读图。' } },
  { delay: 180, event: { type: 'thinking', id: '1:think-2', round: 1, text: '这条回复的目的其实是「让设计稿可检查」，所以正文要覆盖标题、表格、引用、列表、代码块和链接，顺序上先过程后结论。' } },
  { delay: 200, event: { type: 'search', id: 'search:1', query: 'Mova 设置页 内容列 66% 行内边界', status: 'running' } },
  { delay: 700, event: { type: 'search', id: 'search:1', query: 'Mova 设置页 内容列 66% 行内边界', status: 'done', sources: SOURCES } },
  { delay: 240, event: { type: 'command', id: 'cmd:1', title: '核对设置页样式与构建', cwd: 'mova/design', status: 'done', commands: ['node qa/audit-tokens.mjs', 'npm.cmd run build'], output: ['settings ranges: no literal colours left', 'applied 78/78 blocks', '✓ built in 3.86s'] } },
  { delay: 220, event: { type: 'tool', id: 'tool:1', icon: 'run', label: '写入文件 · src/features/chat/demo-reply.ts', meta: '演示 · 不会真的落盘' } },
  { delay: 240, event: { type: 'tool', id: 'tool:2', icon: 'read', label: '读取文件 · source/Mova设置页设计规范.md', meta: '1 份规范' } },
  { delay: 240, event: { type: 'image', id: 'image:1', name: 'assets/settings-reference.png', src: './assets/settings-reference.png' } },
  { delay: 200, event: { type: 'text', id: '1:ack', text: '收到，我先核对一遍当前的界面规范，再给你一条可以直接检查的示例。' } },
  { delay: 260, event: { type: 'thinking', id: '2:think', round: 2, text: '规范已经确认：内容列 718px、行内文字 66%、强调色只有蓝色。接下来把结论整理成表格，并附一个可复制的代码块。' } },
  { delay: 200, event: { type: 'search', id: 'search:2', query: 'WCAG 2.2 非文本对比 3:1 控件边界', status: 'running' } },
  { delay: 620, event: { type: 'search', id: 'search:2', query: 'WCAG 2.2 非文本对比 3:1 控件边界', status: 'done', sources: [
    { title: 'WCAG 2.2 · 1.4.11 Non-text Contrast', url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html', site: 'notion' },
    { title: 'MDN · color contrast', url: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility/Understanding_WCAG/Perceivable/Color_contrast', site: 'github' },
  ] } },
  { delay: 220, event: { type: 'text', id: '2:answer', text: ANSWER_HEAD } },
  { delay: 220, event: { type: 'text', id: '2:answer', text: '\n\n' + ANSWER_TABLE } },
  { delay: 200, event: { type: 'text', id: '2:answer', text: '\n\n' + ANSWER_TAIL } },
  // 模型请求开始时由后端发送 memory-used：这里用示例数据演示「参考了哪些记忆」
  { delay: 260, event: { type: 'memory-used', id: 'memory:1', memories: [
    { id: 'm-1', text: '这个项目统一使用中文说明，提交前先运行 npm.cmd run build 与 typecheck。', kind: '项目约定', updatedAt: '2026-11-10 18:20', conversationTitle: '设置页内容列调整', conversationId: 'demo', messageId: 'm1' },
    { id: 'm-2', text: '偏好：回复先给结论，再给要点；界面背景只用纯黑灰，强调色统一为蓝色。', kind: '用户偏好', updatedAt: '2026-11-08 14:32', conversationTitle: '背景去色讨论', conversationId: 'demo', messageId: 'm2' },
    { id: 'm-3', text: '记忆与存储页的搜索范围增加「全部项目」，但它只用于用户主动检索。', kind: '项目决定', updatedAt: '2026-11-10 21:05', conversationTitle: '服务版记忆设置', conversationId: 'demo', messageId: 'm3', status: 'disabled' },
  ] } },
  // 回复末尾由模型主动提问：底部输入栏会被问答卡片接管（规范 5.8）
  { delay: 300, event: { type: 'ask', id: 'ask:1', question: '接下来先做哪一块？', detail: '选一项我就直接开工；也可以自己写一句，或点「跳过」先把这次提问收起来。', options: [
    { value: 'ask-card', label: '问答卡片', description: 'AI 提问时接管底部输入栏的这块面板' },
    { value: 'memory', label: '记忆与存储', description: '继续打磨设置页的状态行与分组' },
    { value: 'approval', label: '审批流程', description: '写入与命令确认用的内联审批栏' },
  ], allowCustom: true, placeholder: '比如：先把多选和简答的样式补齐' } },
];

const isHello = (request: ChatRequest) => {
  const last = [...request.messages].reverse().find(message => message.role === 'user');
  return /^你好[!！。.~～\s]*$/.test((last?.text ?? '').trim());
};

export const mockMovaClient: MovaClient = {
  source: 'mock',
  async *streamReply(request, signal) {
    if (isHello(request)) {
      yield { type: 'thinking', id: '0:plan', round: 0, text: '准备一条覆盖全部展示能力的演示回复。' } as ReplyEvent;
      await wait(signal, 200);
      for (const step of DEMO) {
        await wait(signal, step.delay);
        signal.throwIfAborted();
        yield step.event;
      }
      return;
    }
    const chunks = [
      '已收到你的消息。', '这是一条在本地生成的示例回复，', '没有调用 AI 模型。\n\n',
      request.mode === 'CodeMova' ? '这次演示不会读取或修改项目文件。' : '你可以继续发送消息，体验多轮聊天。',
      '生成期间，', '点击输入框里的停止按钮', '可以中断回复。', '已显示的内容', '会随会话保存在本地。',
    ];
    for (const chunk of chunks) {
      await wait(signal);
      signal.throwIfAborted();
      yield chunk;
    }
  },
};
