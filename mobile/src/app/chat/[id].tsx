/**
 * 负责：兼容已有会话链接，将选中会话交给共享工作区。
 * 不负责：维护第二份聊天界面或数据。
 * 被谁调用：Expo Router 的 chat/[id] 深链接。
 */
import { useLocalSearchParams } from 'expo-router';
import ChatWorkspace from '../../features/chat/chat-workspace';
export default function ChatRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatWorkspace requestedId={id} />;
}
