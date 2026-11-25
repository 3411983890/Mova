import React, { useEffect, useRef, useState } from 'react';
import { MOVABOT_THREADS } from '../data/movaData';
import type { BotThreadItem, LiquidGlassConfig } from '../types';
import {
  BotMascotAvatar,
  KeyboardRenderShotOne,
  KeyboardRenderShotTwo,
} from './BotAvatars';
import {
  ArrowUpSendIcon,
  MenuLinesIcon,
  PlusIcon,
  SearchMagnifierIcon,
  VoiceWaveIcon,
} from './IOSIcons';
import { IOSLiquidGlass } from './IOSLiquidGlass';

interface MovaBotHomeViewProps {
  glassConfig: LiquidGlassConfig;
  onOpenDrawer: () => void;
  onSelectThread: (thread: BotThreadItem) => void;
  onToast: (msg: string) => void;
}

export const MovaBotHomeView: React.FC<MovaBotHomeViewProps> = ({
  glassConfig,
  onOpenDrawer,
  onSelectThread,
  onToast,
}) => {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const threads = MOVABOT_THREADS.filter(
    (t) => !q || t.title.toLowerCase().includes(q) || t.preview.toLowerCase().includes(q)
  );

  return (
    <div className="movabot-home-view">
      {/* Top Floating Liquid Glass Header (Menu icon matching ChatMova + Search & Plus) */}
      <div className="mova-top-fade-mask" aria-hidden="true" />
      <header className="movabot-top-bar">
        <IOSLiquidGlass
          width={44}
          height={44}
          cornerRadius={22}
          config={glassConfig}
          variant="bar"
          onClick={onOpenDrawer}
          title="打开 MovaBot 通讯录侧栏"
        >
          <MenuLinesIcon size={20} color="#F5F5F7" />
        </IOSLiquidGlass>

        <h1 className="mova-nav-title">MovaBot</h1>

        <div className="movabot-top-actions">
          <IOSLiquidGlass
            width={44}
            height={44}
            cornerRadius={22}
            config={glassConfig}
            variant="bar"
            onClick={() => setSearching((v) => !v)}
            title="搜索 Bot 会话"
          >
            <SearchMagnifierIcon size={19} color="#F5F5F7" />
          </IOSLiquidGlass>

          <IOSLiquidGlass
            width={44}
            height={44}
            cornerRadius={22}
            config={glassConfig}
            variant="bar"
            onClick={() => onToast('新建多 Bot 协作群聊或雇佣新角色')}
            title="新建 Bot 或群聊"
          >
            <PlusIcon size={22} color="#F5F5F7" />
          </IOSLiquidGlass>
        </div>
      </header>

      <div className="movabot-home-scroll">
        {searching && (
          <div className="movabot-search-bar">
            <SearchMagnifierIcon size={15} color="#8E8E93" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索智能体或协作记录..."
              autoFocus
            />
            {query && (
              <button type="button" onClick={() => setQuery('')}>
                清除
              </button>
            )}
          </div>
        )}

        {/* Bot & Swarm Thread List (Hero removed) */}
        <div className="movabot-thread-list">
          {threads.map((item) => (
            <button
              key={item.id}
              type="button"
              className="movabot-thread-row"
              onClick={() => onSelectThread(item)}
            >
              <div className="movabot-thread-avatar">
                <BotMascotAvatar
                  id={item.avatarId}
                  size={48}
                  onlineDot={item.onlineDot}
                  dotBorderColor="#000000"
                />
              </div>

              <div className="movabot-thread-body">
                <div className="movabot-thread-top">
                  <span className="movabot-thread-title">{item.title}</span>
                  <span className="movabot-thread-time">{item.time}</span>
                </div>

                <div className="movabot-thread-bottom">
                  <span
                    className={`movabot-thread-preview ${item.waitingAmber ? 'is-amber' : ''}`}
                  >
                    {item.preview}
                  </span>
                  {item.unreadBlueDot && <span className="movabot-dot movabot-dot--blue" />}
                  {item.waitingAmber && <span className="movabot-dot movabot-dot--amber" />}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

interface MovaBotChatViewProps {
  thread: BotThreadItem;
  glassConfig: LiquidGlassConfig;
  resetSeed: number;
  onBack: () => void;
  onOpenMediaPicker: () => void;
  onToast: (msg: string) => void;
}

interface ExtraTurn {
  id: string;
  userText: string;
  botReply: string;
}

export const MovaBotChatView: React.FC<MovaBotChatViewProps> = ({
  thread,
  glassConfig,
  resetSeed,
  onBack,
  onOpenMediaPicker,
  onToast,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [extraTurns, setExtraTurns] = useState<ExtraTurn[]>([]);

  useEffect(() => {
    setDraft('');
    setExtraTurns([]);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 36;
      }
    });
  }, [thread.id, resetSeed]);

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setExtraTurns((prev) => [
      ...prev,
      {
        id: `${Date.now()}`,
        userText: trimmed,
        botReply: `收到。我这就同步给 Maker 和 Review，等第 6 镜渲染出片立刻推给你看。`,
      },
    ]);
    setDraft('');
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }
    });
  };

  const pillWidth = Math.max(122, Math.min(168, 70 + thread.headerName.length * 9));

  return (
    <div className="movabot-chat-view">
      {/* Top Progressive Scroll Blur & Floating Liquid Glass Islands (Image 2) */}
      <div className="mova-top-fade-mask" aria-hidden="true" />
      <header className="movabot-chat-header">
        <div className="movabot-chat-header-left">
          <IOSLiquidGlass
            width={44}
            height={44}
            cornerRadius={22}
            config={glassConfig}
            variant="bar"
            onClick={onBack}
            title="返回 MovaBot 列表"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M14.5 6L8.5 12L14.5 18"
                stroke="#F5F5F7"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </IOSLiquidGlass>

          <IOSLiquidGlass
            width={pillWidth}
            height={44}
            cornerRadius={22}
            config={glassConfig}
            variant="bar"
            onClick={() => onToast(`${thread.headerName} · 运行于 Mova Linux 云电脑`)}
            contentClassName="movabot-identity-pill"
          >
            <BotMascotAvatar
              id={thread.headerAvatarId}
              size={25}
              onlineDot
              dotBorderColor="#232327"
            />
            <span className="movabot-identity-name">{thread.headerName}</span>
          </IOSLiquidGlass>
        </div>

        {/* Top-Right Cloud Desktop / Workspace Monitor Button (Image 2) */}
        <IOSLiquidGlass
          width={44}
          height={44}
          cornerRadius={22}
          config={glassConfig}
          variant="bar"
          onClick={() => onToast('查看云电脑实时桌面与渲染队列')}
          title="查看云电脑工作台"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect
              x="3.5"
              y="4.5"
              width="17"
              height="12"
              rx="2.4"
              stroke="#F5F5F7"
              strokeWidth="1.85"
            />
            <path
              d="M9 20H15M12 16.5V20"
              stroke="#F5F5F7"
              strokeWidth="1.85"
              strokeLinecap="round"
            />
          </svg>
        </IOSLiquidGlass>
      </header>

      {/* Scrollable Bot Conversation Stream (Image 2) */}
      <div ref={scrollRef} className="movabot-chat-scroll">
        <div className="movabot-bubble movabot-bubble--bot movabot-bubble--peek">
          不改大框架，先锁风格，建模出片给 Maker，配乐另做，齐了 Review 看。
        </div>

        <div className="movabot-delegation-row">
          <span>Messaged</span>
          <BotMascotAvatar id="maker" size={16} />
          <strong>Maker</strong>
        </div>

        <div className="movabot-bubble movabot-bubble--bot">
          Maker 建键盘、出运动镜头。配乐等他片子到了再另叫，不跟建模捆一个人身上。我过风格，不碰
          Blender。
        </div>

        <div className="movabot-timestamp">Today 01:50</div>

        <div className="movabot-bubble movabot-bubble--user">怎么样了</div>

        <div className="movabot-bubble movabot-bubble--bot movabot-bubble--compact">
          我去看 Maker 做到哪了。
        </div>

        <div className="movabot-bubble movabot-bubble--bot">
          Maker 在渲。模型有了，黑场、同一把铝壳白键。前三镜成片了，正在渲第 4 镜，一共 6
          镜。配乐还没叫。
        </div>

        {/* Two Stacked 3D Render Preview Frames (Image 2) */}
        <div className="movabot-media-stack">
          <div
            className="movabot-media-card"
            onClick={() => onToast('预览第 1 镜：黑场铝壳白键低机位透视 (1920×1080)')}
          >
            <KeyboardRenderShotOne />
          </div>
          <div
            className="movabot-media-card"
            onClick={() => onToast('预览第 3 镜：阳极氧化铝倒角微距特写 (1920×1080)')}
          >
            <KeyboardRenderShotTwo />
          </div>
        </div>

        <div className="movabot-sender-signoff">
          <BotMascotAvatar id={thread.headerAvatarId} size={26} />
        </div>

        {extraTurns.map((turn) => (
          <React.Fragment key={turn.id}>
            <div className="movabot-bubble movabot-bubble--user">{turn.userText}</div>
            <div className="movabot-bubble movabot-bubble--bot">{turn.botReply}</div>
            <div className="movabot-sender-signoff">
              <BotMascotAvatar id={thread.headerAvatarId} size={26} />
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* Bottom Fade & Split Composer (Image 2 Layout + Image 3 Right Voice Cluster!) */}
      <div className="mova-bottom-fade-mask" aria-hidden="true" />
      <div className="movabot-composer-bar">
        <IOSLiquidGlass
          width={48}
          height={48}
          cornerRadius={24}
          config={glassConfig}
          variant="composer"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMediaPicker();
          }}
          title="选择照片或拍照"
        >
          <PlusIcon size={23} color="#F2F2F7" />
        </IOSLiquidGlass>

        <IOSLiquidGlass
          width={314}
          height={48}
          cornerRadius={24}
          config={glassConfig}
          variant="composer"
          interactive={false}
          contentClassName="movabot-input-capsule"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
            placeholder={`Ask ${thread.headerName}`}
            className="movabot-text-input"
          />

          <div className="movabot-voice-cluster">
            <button
              type="button"
              className="mova-voice-circle-btn"
              onClick={draft.trim() ? handleSend : () => onToast(`与 ${thread.headerName} 实时通话`)}
              aria-label={draft.trim() ? '发送' : '实时语音'}
            >
              {draft.trim() ? (
                <ArrowUpSendIcon size={18} color="#FFFFFF" />
              ) : (
                <VoiceWaveIcon size={18} color="#FFFFFF" />
              )}
            </button>
          </div>
        </IOSLiquidGlass>
      </div>
    </div>
  );
};
