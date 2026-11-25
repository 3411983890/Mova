/**
 * 负责：提供与 iOS 26 SF Symbols 风格一致的矢量图标集合（基于 react-native-svg）。
 */
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type IconProps = {
  size?: number;
  color?: string;
};

/** 顶栏左侧菜单双短线图标（ChatMova / CodeMova / MovaBot 统一） */
export const MenuLinesIcon: React.FC<IconProps> = ({ size = 20, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M4.5 9.2H19.5" stroke={color} strokeWidth={2} strokeLinecap="round" />
    <Path d="M4.5 14.8H14.5" stroke={color} strokeWidth={2} strokeLinecap="round" />
  </Svg>
);

export const EllipsisIcon: React.FC<IconProps> = ({ size = 20, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Circle cx={5.5} cy={12} r={1.65} fill={color} />
    <Circle cx={12} cy={12} r={1.65} fill={color} />
    <Circle cx={18.5} cy={12} r={1.65} fill={color} />
  </Svg>
);

export const PlusIcon: React.FC<IconProps> = ({ size = 22, color = '#F2F2F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M12 5.2V18.8M5.2 12H18.8" stroke={color} strokeWidth={2.05} strokeLinecap="round" />
  </Svg>
);

export const CloseIcon: React.FC<IconProps> = ({ size = 18, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5"
      stroke={color}
      strokeWidth={2.1}
      strokeLinecap="round"
    />
  </Svg>
);

export const VoiceWaveIcon: React.FC<IconProps> = ({ size = 18, color = '#FFFFFF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M4.5 10.5V13.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    <Path d="M8.3 7.5V16.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    <Path d="M12 4.8V19.2" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    <Path d="M15.7 7.5V16.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    <Path d="M19.5 10.5V13.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
  </Svg>
);

export const ArrowUpIcon: React.FC<IconProps> = ({ size = 18, color = '#FFFFFF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12 18.5V5.8M12 5.8L6.8 11M12 5.8L17.2 11"
      stroke={color}
      strokeWidth={2.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const DesktopCopyIcon: React.FC<IconProps> = ({ size = 17, color = '#8E8E93' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={9} y={9} width={11} height={11} rx={2.5} stroke={color} strokeWidth={1.75} />
    <Path
      d="M15 9V6.5C15 5.12 13.88 4 12.5 4H6.5C5.12 4 4 5.12 4 6.5V12.5C4 13.88 5.12 15 6.5 15H9"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
    />
  </Svg>
);

export const DesktopRegenerateIcon: React.FC<IconProps> = ({ size = 17, color = '#8E8E93' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M19.2 11.5A7.2 7.2 0 1 1 17 6.3L19.5 8.6"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M19.6 4.6V8.7H15.5"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const CheckIcon: React.FC<IconProps> = ({ size = 16, color = '#FFFFFF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M5 12.6L9.6 17.2L19 7.5"
      stroke={color}
      strokeWidth={2.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 16, color = '#8E8E93' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M6.5 9.2L12 14.8L17.5 9.2"
      stroke={color}
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ChevronRightIcon: React.FC<IconProps> = ({ size = 16, color = '#636366' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M9.5 6.5L15 12L9.5 17.5"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ChevronLeftIcon: React.FC<IconProps> = ({ size = 20, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M14.5 6L8.5 12L14.5 18"
      stroke={color}
      strokeWidth={2.15}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const SearchIcon: React.FC<IconProps> = ({ size = 19, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Circle cx={10.8} cy={10.8} r={6.3} stroke={color} strokeWidth={1.95} />
    <Path d="M15.6 15.6L19.8 19.8" stroke={color} strokeWidth={2.05} strokeLinecap="round" />
  </Svg>
);

export const ComposeSquareIcon: React.FC<IconProps> = ({ size = 19, color = '#FFFFFF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12.2 4.5H7C5.34 4.5 4 5.84 4 7.5V17C4 18.66 5.34 20 7 20H16.5C18.16 20 19.5 18.66 19.5 17V11.8"
      stroke={color}
      strokeWidth={1.9}
      strokeLinecap="round"
    />
    <Path
      d="M18.6 4.9C19.25 5.55 19.25 6.6 18.6 7.25L11.8 14.05L8.9 14.85L9.7 11.95L16.5 5.15C17.15 4.5 18.2 4.5 18.85 5.15"
      stroke={color}
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ModeChatIcon: React.FC<IconProps> = ({ size = 18, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M5.5 17.5L4 20L7.8 19C9.06 19.64 10.49 20 12 20C16.69 20 20.5 16.42 20.5 12C20.5 7.58 16.69 4 12 4C7.31 4 3.5 7.58 3.5 12C3.5 14.07 4.33 15.96 5.5 17.5Z"
      stroke={color}
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  </Svg>
);

export const ModeCodeIcon: React.FC<IconProps> = ({ size = 18, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M8.5 8L4.5 12L8.5 16M15.5 8L19.5 12L15.5 16M13.2 5.8L10.8 18.2"
      stroke={color}
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

export const ModeBotIcon: React.FC<IconProps> = ({ size = 18, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={4} y={4} width={6.8} height={6.8} rx={2} stroke={color} strokeWidth={1.8} />
    <Rect x={13.2} y={4} width={6.8} height={6.8} rx={2} stroke={color} strokeWidth={1.8} />
    <Rect x={4} y={13.2} width={6.8} height={6.8} rx={2} stroke={color} strokeWidth={1.8} />
    <Rect x={13.2} y={13.2} width={6.8} height={6.8} rx={2} stroke={color} strokeWidth={1.8} />
  </Svg>
);

export const HostLocalIcon: React.FC<IconProps> = ({ size = 19, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={3.5} y={5} width={17} height={11.5} rx={2.2} stroke={color} strokeWidth={1.8} />
    <Path d="M2 19H22" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
  </Svg>
);

export const HostCloudIcon: React.FC<IconProps> = ({ size = 20, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M7.5 18.2H17.2C19.41 18.2 21.2 16.41 21.2 14.2C21.2 12.16 19.67 10.48 17.7 10.24C17.15 7.42 14.66 5.3 11.68 5.3C8.32 5.3 5.6 8.02 5.6 11.38C5.6 11.58 5.61 11.77 5.63 11.96C4.02 12.46 2.85 13.96 2.85 15.73C2.85 17.09 3.96 18.2 5.32 18.2H7.5Z"
      stroke={color}
      strokeWidth={1.75}
      strokeLinejoin="round"
    />
  </Svg>
);

export const FolderIcon: React.FC<IconProps & { open?: boolean }> = ({
  size = 19,
  color = '#F2F2F7',
  open = false,
}) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d={
        open
          ? 'M3.5 7.2C3.5 6.1 4.4 5.2 5.5 5.2H9.3L11.2 7.2H18.5C19.6 7.2 20.5 8.1 20.5 9.2V10.5H5.2L3.5 17.5V7.2Z'
          : 'M3.5 7.2C3.5 6.1 4.4 5.2 5.5 5.2H9.3L11.2 7.2H18.5C19.6 7.2 20.5 8.1 20.5 9.2V16.8C20.5 17.9 19.6 18.8 18.5 18.8H5.5C4.4 18.8 3.5 17.9 3.5 16.8V7.2Z'
      }
      stroke={color}
      strokeWidth={1.75}
      strokeLinejoin="round"
    />
    {open && (
      <Path
        d="M5.2 10.5H20.8L18.9 17.6C18.68 18.31 18.02 18.8 17.28 18.8H4.6C3.78 18.8 3.2 18.02 3.42 17.22L5.2 10.5Z"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
      />
    )}
  </Svg>
);

export const MonitorIcon: React.FC<IconProps> = ({ size = 20, color = '#F5F5F7' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={3.5} y={4.5} width={17} height={12} rx={2.4} stroke={color} strokeWidth={1.85} />
    <Path d="M9 20H15M12 16.5V20" stroke={color} strokeWidth={1.85} strokeLinecap="round" />
  </Svg>
);

export const CameraIcon: React.FC<IconProps> = ({ size = 26, color = '#FFFFFF' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M4 8.5C4 7.4 4.9 6.5 6 6.5H8.1L9.4 4.6C9.7 4.2 10.2 4 10.7 4H13.3C13.8 4 14.3 4.2 14.6 4.6L15.9 6.5H18C19.1 6.5 20 7.4 20 8.5V17.5C20 18.6 19.1 19.5 18 19.5H6C4.9 19.5 4 18.6 4 17.5V8.5Z"
      stroke={color}
      strokeWidth={1.75}
      strokeLinejoin="round"
    />
    <Circle cx={12} cy={12.8} r={3.4} stroke={color} strokeWidth={1.75} />
  </Svg>
);
