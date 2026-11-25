/**
 * 负责：呈现 ChatMova / CodeMova 对话流消息与 Mova 桌面端同款 AI 底部操作栏（复制 + 重新生成 + 星期时间）。
 */
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { hapticLight } from '../../components/haptics';
import { CheckIcon, DesktopCopyIcon, DesktopRegenerateIcon } from '../../components/ios-icons';
import { formatMovaWeekdayTime, MOVA_CODE_BLOCKS } from '../design/mova-design-data';
import type { Message } from './chat-state';
import type { ReplyActions } from './use-reply-actions';

type ChatMessageProps = {
  message: Message;
  actions: ReplyActions;
  onRegenerate?: () => void;
};

export default function ChatMessage({ message, actions, onRegenerate }: ChatMessageProps) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text selectable style={styles.userText}>
            {message.text}
          </Text>
        </View>
      </View>
    );
  }

  const isCopied = actions.copiedId === message.id;

  return (
    <View style={styles.response}>
      <Text selectable style={styles.body}>
        {message.text}
      </Text>

      {message.plan && (
        <>
          <Text selectable style={styles.heading}>
            {message.plan.heading}
          </Text>
          <View style={styles.steps}>
            {message.plan.steps.map((step, index) => (
              <View key={step.title} style={styles.step}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{index + 1}</Text>
                </View>
                <View style={styles.stepContent}>
                  <Text selectable style={styles.stepTitle}>
                    {step.title}
                  </Text>
                  <Text selectable style={styles.stepDesc}>
                    {step.description}
                  </Text>
                </View>
              </View>
            ))}
          </View>
          <Text selectable style={styles.body}>
            {message.plan.closing}
          </Text>
        </>
      )}

      {/* Mova Desktop Original Footer: Copy + Regenerate + Weekday Time */}
      <View style={styles.desktopFooter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="复制回复"
          style={styles.footerBtn}
          onPress={() => {
            hapticLight();
            void actions.copy(message);
          }}
        >
          {isCopied ? (
            <CheckIcon size={16} color="#30D158" />
          ) : (
            <DesktopCopyIcon size={17} color="#8E8E93" />
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重新生成"
          style={styles.footerBtn}
          onPress={() => {
            hapticLight();
            onRegenerate?.();
          }}
        >
          <DesktopRegenerateIcon size={17} color="#8E8E93" />
        </Pressable>

        <Text style={styles.footerTime}>{formatMovaWeekdayTime()}</Text>
      </View>
    </View>
  );
}

/** 展示与设计稿完全一致的 REALITY / TUIC 代码卡片首屏演示流 */
export const DefaultShowcaseStream: React.FC<{
  onToast: (msg: string) => void;
}> = ({ onToast }) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyText = async (id: string, text: string) => {
    hapticLight();
    try {
      await Clipboard.setStringAsync(text);
    } catch {
      // Ignore clipboard failures on restricted environments
    }
    setCopiedId(id);
    onToast('已复制到剪贴板');
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600);
  };

  return (
    <View style={styles.showcase}>
      <Text style={[styles.body, { color: 'rgba(245, 245, 247, 0.78)' }]}>
        已就绪，两条新线路都已启动，Linux 云端服务已放行对应的 IPv4 端口；原来的 443
        网关保留，可以随时切回。
      </Text>

      <Text style={styles.body}>
        我在服务器本机分别通过两条新线路访问网页，均返回成功；
        <Text style={styles.bodyStrong}>
          手机移动网络下是否可连接、速度是否提升，还需要你实际测试。
        </Text>
      </Text>

      <Text style={styles.body}>
        复制下面的链接，在 Shadowrocket 或 Mova 节点页中从剪贴板导入。
      </Text>

      {MOVA_CODE_BLOCKS.map((block) => {
        const isCopied = copiedId === block.id;
        return (
          <View key={block.id} style={styles.codeSection}>
            <Text style={styles.codeHeading}>{block.heading}</Text>
            <View style={styles.codeCard}>
              <View style={styles.codeCardHead}>
                <Text style={styles.codeLang}>{block.languageLabel}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`复制 ${block.heading}`}
                  style={styles.codeCopyBtn}
                  onPress={() => void copyText(block.id, block.code)}
                >
                  {isCopied ? (
                    <CheckIcon size={16} color="#30D158" />
                  ) : (
                    <DesktopCopyIcon size={16} color="#D1D1D6" />
                  )}
                </Pressable>
              </View>
              <Text selectable style={styles.codePre}>
                {block.code}
              </Text>
            </View>
          </View>
        );
      })}

      <Text style={styles.body}>
        先用移动流量分别测试这两条线路，再和原来的 REALITY 对比下载速度。TUIC 与 Hysteria2
        一样使用 UDP，如果运营商对 UDP 有限制，它仍可能无法连接。链接包含连接凭据，请不要公开分享。
      </Text>

      {/* Mova Desktop Original Footer */}
      <View style={styles.desktopFooter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="复制回复"
          style={styles.footerBtn}
          onPress={() => void copyText('showcase-full', '已复制完整线路测试回复')}
        >
          {copiedId === 'showcase-full' ? (
            <CheckIcon size={16} color="#30D158" />
          ) : (
            <DesktopCopyIcon size={17} color="#8E8E93" />
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重新生成"
          style={styles.footerBtn}
          onPress={() => {
            hapticLight();
            onToast('正在重新生成回复（保留旧尝试）');
          }}
        >
          <DesktopRegenerateIcon size={17} color="#8E8E93" />
        </Pressable>

        <Text style={styles.footerTime}>星期一 07:43</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  showcase: {
    gap: 16,
  },
  userRow: {
    alignItems: 'flex-end',
    marginVertical: 4,
  },
  userBubble: {
    maxWidth: '84%',
    borderRadius: 22,
    backgroundColor: '#2B2C32',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  userText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#FFFFFF',
  },
  response: {
    gap: 14,
  },
  body: {
    fontSize: 16.5,
    lineHeight: 27,
    color: '#F5F5F7',
    letterSpacing: -0.1,
  },
  bodyStrong: {
    fontWeight: '600',
    color: '#FFFFFF',
  },
  heading: {
    fontSize: 18.5,
    fontWeight: '600',
    color: '#F5F5F7',
    lineHeight: 26,
  },
  steps: {
    gap: 12,
  },
  step: {
    flexDirection: 'row',
    gap: 12,
  },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#1C1C1E',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  stepNumText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
  },
  stepContent: {
    flex: 1,
    gap: 3,
  },
  stepTitle: {
    fontSize: 15.5,
    fontWeight: '500',
    color: '#F5F5F7',
  },
  stepDesc: {
    fontSize: 14,
    lineHeight: 21,
    color: '#8E8E93',
  },
  codeSection: {
    gap: 10,
    marginTop: 2,
  },
  codeHeading: {
    fontSize: 17,
    fontWeight: '600',
    color: '#F5F5F7',
  },
  codeCard: {
    borderRadius: 18,
    backgroundColor: '#17171A',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.09)',
    overflow: 'hidden',
  },
  codeCardHead: {
    height: 38,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.06)',
  },
  codeLang: {
    fontSize: 12.5,
    color: '#8E8E93',
  },
  codeCopyBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codePre: {
    padding: 14,
    fontSize: 13,
    lineHeight: 20,
    color: '#E5E5EA',
    fontFamily: 'Menlo',
  },
  desktopFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: -2,
  },
  footerBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerTime: {
    marginLeft: 4,
    fontSize: 13.5,
    color: '#7E7E85',
    letterSpacing: -0.1,
  },
});
