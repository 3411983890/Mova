// Sample transcript shown for the built-in demo chats only. Kept apart from
// app.js because it is static copy: no state, no DOM, no side effects.

const ANSWER_INTRO = '我会把之前讨论的产品定位、技术架构和分阶段开发计划整理成一份 Markdown 文档，放在 Mova 项目文件夹里。';
const ANSWER_OUTRO = '项目里已经有一版可运行的界面原型，我会把它作为现状写进方案，并明确哪些是真实功能、哪些仍是演示。点击思考过程中的「来源」可展开查看参考网站详情。';

const PRICING_SOURCES = [
  { id: 'src-reddit', site: 'reddit', title: 'Tailwind UI 与构建自己的 UI：成本对比', url: 'https://www.reddit.com/r/reactjs/' },
  { id: 'src-linkedin', site: 'linkedin', title: '我们在 6 周内交付了我们的设计系统', url: 'https://www.linkedin.com/company/figma/' },
  { id: 'src-github', site: 'github', title: 'shadcn/ui — 注册表模型解释', url: 'https://ui.shadcn.com/docs/registry' },
  { id: 'src-figma', site: 'figma', title: '设计变量实用指南', url: 'https://help.figma.com/hc/en-us/articles/15339657135383' },
  { id: 'src-notion', site: 'notion', title: '我们如何为组件库定价', url: 'https://www.notion.so/blog/design-system' },
];

const ARCH_SOURCES = [
  { id: 'arch-github', site: 'github', title: 'radix-ui/primitives — 无障碍组件架构设计', url: 'https://github.com/radix-ui/primitives' },
  { id: 'arch-figma', site: 'figma', title: 'Design Tokens 跨端同步与变量分层规范', url: 'https://www.figma.com/design-systems/' },
  { id: 'arch-notion', site: 'notion', title: 'Notion 工程团队前端架构与状态管理笔记', url: 'https://www.notion.so/blog/topic/tech' },
  { id: 'arch-reddit', site: 'reddit', title: 'r/reactjs — 值得团队付费的 React 组件库讨论', url: 'https://www.reddit.com/r/reactjs/top/' },
];

const ACTIVITY_ITEMS = [
  {
    type: 'thought',
    summary: 'The new main view looks right: "模型 DeepSeek V4.1 Flash ›", divider, "Reasoning effort Medium", slider without labels.',
    paragraphs: [
      'The new main view looks right: "模型 DeepSeek V4.1 Flash ›", divider, "Reasoning effort Medium", slider without labels.',
      'Now test the model selection view: click the 模型 row → should switch to the models list, expand upward with animation.',
      'Let me write a test that clicks `.mova-row-button`, waits, and screenshots.',
      'Also verify: after choosing another model, returns to main.',
      'Let me test.',
    ],
  },
  {
    type: 'command',
    title: '验证模型选择视图切换',
    cwd: "Mova @'",
    commands: [
      "const fs = require('fs');",
      "fs.writeFileSync('qa/model-test2.js', `const root = document.querySelector('#composer [data-deep-agent-original]').shadowRoot;",
      "const trigger = [...root.querySelectorAll('button')].find(b => (b.textContent || '').includes('deepseek-chat'));",
      'trigger.click();',
      'await new Promise(r => setTimeout(r, 700));',
      "const before = Math.round(root.querySelector('.morph-menu-",
    ],
    output: [
      'script: {"before":123,"after":117,"view":"models","models":["deepseek-chat","deepseek-reasoner"]}',
      'saved model-picker.png',
    ],
  },
  {
    type: 'image',
    path: 'model-picker.png',
    src: './assets/model-picker.png',
  },
  { icon: 'bulb', label: '搜索团队在组件库中实际支付的费用', sources: PRICING_SOURCES },
  { icon: 'x', label: '搜索 X 为 component library OR design system pricing' },
  { icon: 'reddit', label: '在 Reddit 上搜索 r/reactjs worth paying for', sources: ARCH_SOURCES },
  { icon: 'bulb', label: '阅读最强三线程' },
];

/** Fresh copy per chat so later mutations cannot leak between demo entries. */
export function createDemoConversation() {
  return [
    {
      text: '帮我调研主流组件库与设计系统的团队实际付费方案，并结合 Mova 原型整理成方案文档',
      thinking: {
        status: 'done',
        segments: [
          { kind: 'text', text: ANSWER_INTRO },
          {
            id: 'demo-search-activity',
            kind: 'activity',
            icon: 'search',
            summary: '跑了 3 次搜索 · 已运行命令已读取聊天',
            items: ACTIVITY_ITEMS.map(item => ({ ...item })),
          },
          { kind: 'text', text: ANSWER_OUTRO },
        ],
      },
    },
  ];
}
