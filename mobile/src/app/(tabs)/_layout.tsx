/**
 * 负责：保持原有主路由分组，使用聊天内的侧栏导航。
 * 不负责：创建底部标签栏或管理消息。
 * 被谁调用：根页面栈。
 */
import { Slot } from 'expo-router';
export default function MainLayout() { return <Slot />; }
