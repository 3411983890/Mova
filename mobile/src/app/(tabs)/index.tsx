/**
 * 负责：将应用主入口交给新的聊天工作区。
 * 不负责：复制会话状态或构造底部标签导航。
 * 被谁调用：Expo Router 主路由。
 */
export { default } from '../../features/chat/chat-workspace';
