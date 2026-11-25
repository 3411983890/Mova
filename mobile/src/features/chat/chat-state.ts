/**
 * 负责：定义演示会话数据和不可变状态变更。
 * 不负责：请求模型、保存磁盘数据或执行桌面工具。
 * 被谁调用：mobile-provider 和 chat-state 单测。
 */
import { DESIGN_SAMPLE } from './design-sample.ts';

export const MAX_MESSAGE_LENGTH = 8000;

export type Message = { id: string; role: 'user' | 'assistant'; text: string; plan?: {
  heading: string; steps: { title: string; description: string }[]; closing: string;
} };
export type Conversation = { id: string; title: string; messages: Message[]; updatedAt: number };
export type ChatState = { conversations: Conversation[] };

/** 创建明确标识为演示的欢迎会话。 */
export function createInitialState(): ChatState {
  return { conversations: [{
    id: 'welcome', title: '整理今天的想法', updatedAt: 0,
    messages: [
      { id: 'sample-question', role: 'user', text: DESIGN_SAMPLE.question },
      { id: 'sample-reply', role: 'assistant', text: DESIGN_SAMPLE.introduction,
        plan: { heading: DESIGN_SAMPLE.heading, steps: DESIGN_SAMPLE.steps, closing: DESIGN_SAMPLE.closing } },
    ],
  }] };
}

/** 加入一个空会话，已有 ID 不重复创建。 */
export function createConversation(state: ChatState, id: string, now: number): ChatState {
  if (!id || state.conversations.some(item => item.id === id)) return state;
  return { conversations: [{ id, title: '新对话', messages: [], updatedAt: now }, ...state.conversations] };
}

/** 输入不合法、演示关闭或会话不存在时拒绝发送，不写入任何消息。 */
export function sendDemoMessage(
  state: ChatState, conversationId: string, input: string, messageId: string, now: number, enabled: boolean,
): ChatState {
  const text = input.trim();
  if (!enabled || !text || text.length > MAX_MESSAGE_LENGTH || !messageId) return state;
  const target = state.conversations.find(item => item.id === conversationId);
  if (!target || target.messages.some(item => item.id === messageId)) return state;
  const updated: Conversation = {
    ...target, title: target.messages.some(item => item.role === 'user') ? target.title : text.slice(0, 24),
    updatedAt: now,
    messages: [...target.messages,
      { id: messageId, role: 'user', text },
      { id: `${messageId}-demo`, role: 'assistant', text:
        '这是一条本地演示回复。你的消息已显示在当前对话中。\n\n连接 Mova 服务后，这里将显示真实的模型回复。目前内容只保留在本次运行中，重新加载后会重置。' },
    ],
  };
  return { conversations: [updated, ...state.conversations.filter(item => item.id !== conversationId)] };
}

/** 删除指定会话，其他会话保持不变。 */
export function deleteConversation(state: ChatState, id: string): ChatState {
  return { conversations: state.conversations.filter(item => item.id !== id) };
}
