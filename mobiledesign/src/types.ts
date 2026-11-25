import type { BotAvatarId } from './components/BotAvatars';

export type KyantHighlightStyle = 'default' | 'ambient' | 'plain';

export type MovaAppMode = 'ChatMova' | 'CodeMova' | 'MovaBot';
export type CodeHostScope = 'local' | 'cloud';

/**
 * Optical & material parameters ported 1:1 from Kyant0/AndroidLiquidGlass (`com.kyant.backdrop`)
 */
export interface LiquidGlassConfig {
  refractionHeight: number;
  refractionAmount: number;
  blurRadius: number;
  vibrancy: number;
  chromaticAberration: number;
  depthEffect: number;
  highlightStyle: KyantHighlightStyle;
  highlightAngle: number;
  highlightAlpha: number;
  ambientGlow: boolean;
}

export interface CodeBlockItem {
  id: string;
  heading: string;
  languageLabel: string;
  code: string;
}

export type EffortLevelId = 'low' | 'medium' | 'high' | 'xhigh';

export interface EffortStop {
  value: EffortLevelId;
  label: string;
  short: string;
}

export interface MovaModelOption {
  id: string;
  provider: 'ChatGPT' | 'Gemini' | 'DeepSeek';
  name: string;
  defaultEffort: EffortLevelId;
  efforts: EffortLevelId[];
}

export interface ConversationItem {
  id: string;
  title: string;
  activeDot?: boolean;
  questionBadge?: boolean;
  previewPrompt?: string;
}

export interface CodeProjectFolder {
  id: string;
  name: string;
  pathHint: string;
  host: CodeHostScope;
  chats: ConversationItem[];
}

export interface BotThreadItem {
  id: string;
  avatarId: BotAvatarId;
  headerAvatarId: BotAvatarId;
  headerName: string;
  title: string;
  preview: string;
  time: string;
  onlineDot?: boolean;
  unreadBlueDot?: boolean;
  waitingAmber?: boolean;
}

export interface BotContactProfile {
  id: string;
  avatarId: Exclude<BotAvatarId, 'group-swarm'>;
  name: string;
  indexLetter: string;
  roleTitle: string;
  tag: string;
  builtin?: boolean;
  online?: boolean;
  bio: string;
  model: string;
  effort: string;
  tone: string;
  collabRole: string;
  browserPolicy: string;
  quietHours: string;
  defaultMuted?: boolean;
  webSearch?: boolean;
  memoryEnabled?: boolean;
  canDelegate?: boolean;
}

export type ScreenPreset =
  | 'chat'
  | 'keyboard'
  | 'drawer'
  | 'settings'
  | 'bot-list'
  | 'bot-chat'
  | 'bot-contacts'
  | 'bot-settings';
