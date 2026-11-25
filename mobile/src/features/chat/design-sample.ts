/**
 * 负责：提供与 Figma 对话示例一致的行动计划演示数据。
 * 不负责：将示例冒充真实模型回复或思考用时。
 * 被谁调用：chat-state 初始状态。
 */
export const DESIGN_SAMPLE = {
  question: '帮我把今天的想法整理一下，\n做一份清晰的行动计划。',
  introduction: '当然。先让零散的想法有个落点，再把它们变成可以开始的小事。',
  heading: '让想法，变成下一步',
  steps: [
    { title: '找到今天最重要的事', description: '先选一个最想推进的目标。' },
    { title: '把目标拆成小步骤', description: '每一步，都具体到可以马上开始。' },
    { title: '留出一段专注时间', description: '先专注 25 分钟，再回顾和调整。' },
  ],
  closing: '把你零散的想法发给我，\n我们一起整理成清晰的行动清单。',
};
