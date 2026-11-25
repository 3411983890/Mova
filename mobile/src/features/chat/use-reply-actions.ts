/**
 * 负责：处理回复的本机复制、朗读、分享和运行内反馈状态。
 * 不负责：向服务器提交反馈或启用语音对话。
 * 被谁调用：chat-workspace 和 chat-message。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Speech from 'expo-speech';
import type { Message } from './chat-state';

/** 将结构化计划转换为可复制、分享和朗读的完整正文。 */
export function getMessageText(message: Message): string {
  if (!message.plan) return message.text;
  return [message.text, message.plan.heading,
    ...message.plan.steps.map((step, index) => `${index + 1}. ${step.title}\n${step.description}`),
    message.plan.closing].join('\n\n');
}

/** 一个工作区共享朗读状态，切换会话或离开时停止系统朗读。 */
export function useReplyActions(conversationId?: string) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const reading = useRef<string | null>(null);
  const operation = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    operation.current++;
    reading.current = null;
    clearTimeout(copyTimer.current);
    void Speech.stop().catch(error => console.warn('停止朗读失败', error));
  }, [conversationId]);
  const copy = async (message: Message) => {
    try {
      await Clipboard.setStringAsync(getMessageText(message));
      setCopiedId(message.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 2000);
    } catch { Alert.alert('无法复制', '请长按回复正文选择并复制。'); }
  };
  const speak = async (message: Message) => {
    const stopOnly = reading.current === message.id;
    const currentOperation = ++operation.current;
    try {
      await Speech.stop();
      if (operation.current !== currentOperation) return;
      reading.current = stopOnly ? null : message.id;
      setReadingId(reading.current);
      if (stopOnly) return;
      const finish = () => {
        if (operation.current !== currentOperation) return;
        reading.current = null;
        setReadingId(null);
      };
      Speech.speak(getMessageText(message), { language: 'zh-CN', onDone: finish, onStopped: finish,
        onError: () => { finish(); Alert.alert('无法朗读', '请检查系统语音设置后重试。'); } });
    } catch { reading.current = null; setReadingId(null); Alert.alert('无法朗读', '请稍后重试。'); }
  };
  const share = async (message: Message) => {
    try { await Share.share({ message: getMessageText(message) }); }
    catch { Alert.alert('无法分享', '请稍后重试，或先复制回复。'); }
  };
  const like = (id: string) => setLikedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  return { copiedId, readingId, likedIds, copy, speak, share, like };
}
export type ReplyActions = ReturnType<typeof useReplyActions>;
