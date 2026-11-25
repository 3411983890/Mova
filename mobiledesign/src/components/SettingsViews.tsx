import React, { useEffect, useRef, useState } from 'react';
import type { BotContactProfile, LiquidGlassConfig } from '../types';
import { BotMascotAvatar } from './BotAvatars';
import { ChevronRightIcon, ModeChatBubbleIcon } from './IOSIcons';
import { IOSLiquidGlass } from './IOSLiquidGlass';

/* Native iOS 26 Pill Switch matching Image 6 geometry */
const IOS26Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={`ios26-switch ${checked ? 'is-on' : ''}`}
    onClick={(e) => {
      e.stopPropagation();
      onChange(!checked);
    }}
  >
    <span className="ios26-switch-knob" />
  </button>
);

interface SystemSettingsViewProps {
  glassConfig: LiquidGlassConfig;
  resetSeed: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

/**
 * System Settings Page faithfully modeled after Image 6 (iOS 26 Dark Inset Grouped List)
 */
export const SystemSettingsView: React.FC<SystemSettingsViewProps> = ({
  glassConfig,
  resetSeed,
  onClose,
  onToast,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoTimezone, setAutoTimezone] = useState(true);
  const [notificationsOn, setNotificationsOn] = useState(false);

  useEffect(() => {
    setAutoTimezone(true);
    setNotificationsOn(false);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    });
  }, [resetSeed]);

  return (
    <div className="ios-settings-screen">
      {/* Top progressive scroll fade & floating × Liquid Glass button */}
      <div className="ios-settings-top-fade" aria-hidden="true" />
      <header className="ios-settings-header">
        <IOSLiquidGlass
          width={44}
          height={44}
          cornerRadius={22}
          config={glassConfig}
          variant="bar"
          onClick={onClose}
          title="关闭设置"
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <path
              d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5"
              stroke="#F5F5F7"
              strokeWidth="2.1"
              strokeLinecap="round"
            />
          </svg>
        </IOSLiquidGlass>
        <span className="ios-settings-nav-title">设置</span>
      </header>

      <div ref={scrollRef} className="ios-settings-scroll">
        {/* Account, Usage & Vault Card */}
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row ios-settings-row--profile"
            onClick={() => onToast('Apple ID 账号已绑定云端设备钥匙串')}
          >
            <span className="ios-settings-avatar">雪</span>
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">雪瑞瑞瑞</span>
              <span className="ios-settings-row-sub">nwn2762dtp@privaterelay.appleid.com</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('本周期 Token 用量：3,842 · 额度占用 0%')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">用量</span>
            </div>
            <span className="ios-settings-row-value">0%</span>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('隐私保管库已使用 AES-256-GCM 加密锁定')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">保管库</span>
              <span className="ios-settings-row-sub">
                Mova Bot 可以使用的登录信息、卡片和联系信息
              </span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>
        </div>

        {/* Connected Apps Card */}
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('已连接 3 个工具：联网检索、日历与 MCP 插件')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">连接应用</span>
              <span className="ios-settings-row-sub">搜索插件</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>
        </div>

        {/* Bot Section */}
        <div className="ios-settings-section-label">Bot</div>
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('审批级别：请求批准（修改文件与命令每次确认）')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">权限</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">自动设置时区</span>
              <span className="ios-settings-row-sub">Bot 的电脑跟随此设备的时区。</span>
            </div>
            <IOS26Toggle
              checked={autoTimezone}
              onChange={(val) => {
                setAutoTimezone(val);
                onToast(val ? '已开启自动同步设备时区' : '已切换为手动时区');
              }}
              label="自动设置时区"
            />
          </div>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">时区</span>
            </div>
            <span className="ios-settings-row-value">Asia/Shanghai</span>
          </div>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('Linux 云电脑在线 · PostgreSQL + Chromium 就绪')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">Bot 电脑</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('已配对 2 台设备：Windows 桌面端 · iPhone 16 Pro')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">管理你的设备</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('支持从本地备份或 pgvector 索引导入长期记忆')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">导入记忆</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>
        </div>

        {/* Notifications Card */}
        <div className="ios-settings-card">
          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">通知</span>
            </div>
            <IOS26Toggle
              checked={notificationsOn}
              onChange={(val) => {
                setNotificationsOn(val);
                onToast(val ? '已开启 APNs 任务完成与审批通知' : '已关闭推送通知');
              }}
              label="通知"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

interface BotSettingsViewProps {
  bot: BotContactProfile;
  glassConfig: LiquidGlassConfig;
  isCreatingNew?: boolean;
  onBack: () => void;
  onStartChat: (bot: BotContactProfile) => void;
  onToast: (msg: string) => void;
}

/**
 * Individual Bot Settings Page (entered from MovaBot Contacts Sidebar)
 * Follows exact same iOS 26 Dark Inset Grouped Card language as Image 6
 */
export const BotSettingsView: React.FC<BotSettingsViewProps> = ({
  bot,
  glassConfig,
  isCreatingNew = false,
  onBack,
  onStartChat,
  onToast,
}) => {
  const [webSearch, setWebSearch] = useState(Boolean(bot.webSearch));
  const [memoryOn, setMemoryOn] = useState(Boolean(bot.memoryEnabled));
  const [canDelegate, setCanDelegate] = useState(Boolean(bot.canDelegate));
  const [muted, setMuted] = useState(Boolean(bot.defaultMuted));
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setWebSearch(Boolean(bot.webSearch));
    setMemoryOn(Boolean(bot.memoryEnabled));
    setCanDelegate(Boolean(bot.canDelegate));
    setMuted(Boolean(bot.defaultMuted));
    setPaused(false);
  }, [bot.id]);

  return (
    <div className="ios-settings-screen">
      <div className="ios-settings-top-fade" aria-hidden="true" />
      <header className="ios-settings-header ios-settings-header--split">
        <IOSLiquidGlass
          width={44}
          height={44}
          cornerRadius={22}
          config={glassConfig}
          variant="bar"
          onClick={onBack}
          title="返回通讯录"
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

        <span className="ios-settings-nav-title">
          {isCreatingNew ? '新建 Bot' : 'Bot 设置'}
        </span>

        <IOSLiquidGlass
          width={44}
          height={44}
          cornerRadius={22}
          config={glassConfig}
          variant="bar"
          onClick={() => onStartChat(bot)}
          title={`给 ${bot.name} 发消息`}
        >
          <ModeChatBubbleIcon size={19} color="#F5F5F7" />
        </IOSLiquidGlass>
      </header>

      <div className="ios-settings-scroll ios-settings-scroll--bot">
        {/* Centered Bot Hero */}
        <div className="bot-settings-hero">
          <BotMascotAvatar
            id={bot.avatarId}
            size={74}
            onlineDot={bot.online && !paused}
            dotBorderColor="#000000"
          />
          <h2 className="bot-settings-name">{isCreatingNew ? '新伙伴' : bot.name}</h2>
          <p className="bot-settings-role">{bot.roleTitle}</p>
          <div className="bot-settings-chips">
            <span>{bot.tag}</span>
            {bot.builtin && <span>内置</span>}
            <span>{paused ? '已暂停' : bot.online ? '云端在线' : '待命'}</span>
          </div>
        </div>

        {/* Persona & Profile */}
        <div className="ios-settings-section-label">基础资料与人设</div>
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast('可编辑 Bot 名称、简介与开场白')}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">角色简介</span>
              <span className="ios-settings-row-sub">{bot.bio}</span>
            </div>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast(`说话语气：${bot.tone}`)}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">说话风格</span>
            </div>
            <span className="ios-settings-row-value">{bot.tone.split(' · ')[0]}</span>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast(`群聊分工：${bot.collabRole}`)}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">群聊分工</span>
            </div>
            <span className="ios-settings-row-value">{bot.collabRole.split('（')[0]}</span>
            <ChevronRightIcon size={16} color="#636366" />
          </button>
        </div>

        {/* Model & Capabilities */}
        <div className="ios-settings-section-label">模型与能力</div>
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast(`当前模型：${bot.model} · 思考强度 ${bot.effort}`)}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">驱动模型</span>
            </div>
            <span className="ios-settings-row-value">
              {bot.model} · {bot.effort}
            </span>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">联网检索</span>
              <span className="ios-settings-row-sub">允许调用多源 RRF 搜索与引用校验</span>
            </div>
            <IOS26Toggle
              checked={webSearch}
              onChange={(v) => {
                setWebSearch(v);
                onToast(v ? `${bot.name} 已启用联网检索` : `${bot.name} 已关闭联网检索`);
              }}
              label="联网检索"
            />
          </div>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">独立长期记忆</span>
              <span className="ios-settings-row-sub">跨会话隔离记忆块，不越权共享</span>
            </div>
            <IOS26Toggle
              checked={memoryOn}
              onChange={(v) => {
                setMemoryOn(v);
                onToast(v ? '已开启独立长期记忆' : '已关闭独立长期记忆');
              }}
              label="独立长期记忆"
            />
          </div>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">跨 Bot 任务委派</span>
              <span className="ios-settings-row-sub">允许在共同群内 @ 其他角色协作</span>
            </div>
            <IOS26Toggle
              checked={canDelegate}
              onChange={(v) => {
                setCanDelegate(v);
                onToast(v ? '允许委派子任务' : '仅响应自身任务');
              }}
              label="跨 Bot 任务委派"
            />
          </div>
        </div>

        {/* Permissions & Quiet Hours */}
        <div className="ios-settings-section-label">执行与提醒</div>
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row"
            onClick={() => onToast(`云浏览器策略：${bot.browserPolicy}`)}
          >
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">云浏览器权限</span>
            </div>
            <span className="ios-settings-row-value">{bot.browserPolicy}</span>
            <ChevronRightIcon size={16} color="#636366" />
          </button>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">静默时段</span>
              <span className="ios-settings-row-sub">此期间不主动发送非紧急消息</span>
            </div>
            <span className="ios-settings-row-value">{bot.quietHours}</span>
          </div>

          <div className="ios-settings-sep" />

          <div className="ios-settings-row">
            <div className="ios-settings-row-main">
              <span className="ios-settings-row-title">消息免打扰</span>
            </div>
            <IOS26Toggle
              checked={muted}
              onChange={(v) => {
                setMuted(v);
                onToast(v ? `${bot.name} 已设为免打扰` : `${bot.name} 已恢复提醒`);
              }}
              label="消息免打扰"
            />
          </div>
        </div>

        {/* Lifecycle Danger Actions */}
        <div className="ios-settings-card">
          <button
            type="button"
            className="ios-settings-row ios-settings-row--center"
            onClick={() => {
              setPaused((v) => !v);
              onToast(paused ? `${bot.name} 已恢复运行` : `${bot.name} 已暂停后台任务`);
            }}
          >
            <span className="ios-settings-action-blue">
              {paused ? '恢复运行此 Bot' : '暂停此 Bot'}
            </span>
          </button>

          <div className="ios-settings-sep" />

          <button
            type="button"
            className="ios-settings-row ios-settings-row--center"
            onClick={() => onToast('删除前将预览关联群聊、定时任务与记忆影响')}
          >
            <span className="ios-settings-action-danger">删除 Bot</span>
          </button>
        </div>
      </div>
    </div>
  );
};
