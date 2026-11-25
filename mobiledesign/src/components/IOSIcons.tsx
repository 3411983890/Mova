import React from 'react';

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
  filled?: boolean;
}

/** Screenshot 1/2/3 top-left staggered two-line menu icon */
export const MenuLinesIcon: React.FC<IconProps> = ({ size = 20, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M5 9.25H19" stroke={color} strokeWidth="2" strokeLinecap="round" />
    <path d="M5 15.25H14.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** iOS 26 Square & Pencil compose icon */
export const ComposeSquareIcon: React.FC<IconProps> = ({ size = 20, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path
      d="M11.5 4.5H6.8C5.2536 4.5 4 5.7536 4 7.3V17.2C4 18.7464 5.2536 20 6.8 20H16.7C18.2464 20 19.5 18.7464 19.5 17.2V12.5"
      stroke={color}
      strokeWidth="1.85"
      strokeLinecap="round"
    />
    <path
      d="M17.65 3.65C18.34 2.96 19.46 2.96 20.15 3.65C20.84 4.34 20.84 5.46 20.15 6.15L12.1 14.2L8.8 15L9.6 11.7L17.65 3.65Z"
      stroke={color}
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const EllipsisRowIcon: React.FC<IconProps> = ({ size = 20, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <circle cx="6" cy="12" r="1.55" fill={color} />
    <circle cx="12" cy="12" r="1.55" fill={color} />
    <circle cx="18" cy="12" r="1.55" fill={color} />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ size = 22, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M12 5.25V18.75M5.25 12H18.75" stroke={color} strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

/** Authentic Apple SF Symbol `mic` (capsule + U-cradle + vertical stem, no horizontal foot) */
export const MicOutlineIcon: React.FC<IconProps> = ({ size = 22, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="8.8" y="2.8" width="6.4" height="11.2" rx="3.2" stroke={color} strokeWidth="1.95" />
    <path
      d="M5.4 10.8V11.3C5.4 14.95 8.35 17.9 12 17.9C15.65 17.9 18.6 14.95 18.6 11.3V10.8"
      stroke={color}
      strokeWidth="1.95"
      strokeLinecap="round"
    />
    <path d="M12 17.9V21.2" stroke={color} strokeWidth="1.95" strokeLinecap="round" />
  </svg>
);

export const VoiceWaveIcon: React.FC<IconProps> = ({ size = 18, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M4.5 10.2V13.8" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
    <path d="M8.25 7.2V16.8" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
    <path d="M12 4.5V19.5" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
    <path d="M15.75 7.8V16.2" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
    <path d="M19.5 10.2V13.8" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
  </svg>
);

export const ArrowUpSendIcon: React.FC<IconProps> = ({ size = 18, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M12 19V5.5M12 5.5L6.5 11M12 5.5L17.5 11" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CopySheetsIcon: React.FC<IconProps> = ({ size = 17, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.6" stroke={color} strokeWidth="1.75" />
    <path d="M15.5 8.5V6.6C15.5 5.16 14.34 4 12.9 4H6.6C5.16 4 4 5.16 4 6.6V12.9C4 14.34 5.16 15.5 6.6 15.5H8.5" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

export const CheckTinyIcon: React.FC<IconProps> = ({ size = 17, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M5 12.5L9.5 17L19 7.5" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Combined Thumbs Up/Down feedback glyph seen in Screenshot 1 & 2 */
export const ThumbsFeedbackIcon: React.FC<IconProps> = ({ size = 19, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path
      d="M5.5 10.5L8.2 5.4C8.5 4.8 9.4 5 9.4 5.7V9H12.6C13.4 9 14 9.7 13.8 10.5L12.9 14.3C12.7 14.9 12.2 15.3 11.6 15.3H5.5V10.5Z"
      stroke={color}
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M3.2 10.5H5.5V15.3H3.2V10.5Z" stroke={color} strokeWidth="1.65" strokeLinejoin="round" />
    <path
      d="M18.5 13.5L15.8 18.6C15.5 19.2 14.6 19 14.6 18.3V15H13"
      stroke={color}
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M18.5 9.2H20.8V14H18.5V9.2Z" stroke={color} strokeWidth="1.65" strokeLinejoin="round" />
  </svg>
);

export const SpeakerWaveIcon: React.FC<IconProps> = ({ size = 18, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M11 5.5L6.5 9H3.8C3.36 9 3 9.36 3 9.8V14.2C3 14.64 3.36 15 3.8 15H6.5L11 18.5V5.5Z" stroke={color} strokeWidth="1.7" strokeLinejoin="round" />
    <path d="M15.2 9.2C16.3 10.7 16.3 13.3 15.2 14.8" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    <path d="M18.3 6.8C20.3 9.8 20.3 14.2 18.3 17.2" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

export const ShareTrayIcon: React.FC<IconProps> = ({ size = 18, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M12 3.8V14.5M12 3.8L8.2 7.6M12 3.8L15.8 7.6" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 12.8V18.2C5 19.2 5.8 20 6.8 20H17.2C18.2 20 19 19.2 19 18.2V12.8" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

export const SearchMagnifierIcon: React.FC<IconProps> = ({ size = 20, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <circle cx="10.8" cy="10.8" r="6.6" stroke={color} strokeWidth="1.95" />
    <path d="M15.8 15.8L20.2 20.2" stroke={color} strokeWidth="1.95" strokeLinecap="round" />
  </svg>
);

export const SidebarClockIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth="1.85" />
    <path d="M12 7.5V12.2L14.8 14.2" stroke={color} strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SidebarLibraryIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="4" y="4.5" width="3.8" height="15" rx="1" stroke={color} strokeWidth="1.75" />
    <rect x="9.5" y="4.5" width="3.8" height="15" rx="1" stroke={color} strokeWidth="1.75" />
    <path d="M15.4 5.1L18.9 4.5L20.8 19.1L17.3 19.7L15.4 5.1Z" stroke={color} strokeWidth="1.75" strokeLinejoin="round" />
  </svg>
);

export const SidebarMemorySlidersIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M4 8.5H10.5M14.8 8.5H20" stroke={color} strokeWidth="1.85" strokeLinecap="round" />
    <circle cx="12.6" cy="8.5" r="2.1" stroke={color} strokeWidth="1.85" />
    <path d="M4 15.5H8.8M13.2 15.5H20" stroke={color} strokeWidth="1.85" strokeLinecap="round" />
    <circle cx="11" cy="15.5" r="2.1" stroke={color} strokeWidth="1.85" />
  </svg>
);

/** Scalloped cloud terminal badge icon matching Codex in Screenshot 3 */
export const SidebarCodeMovaIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path
      d="M12 3.2C13.4 3.2 14.6 3.9 15.3 5C16.6 4.9 17.9 5.6 18.5 6.8C19.7 7.5 20.4 8.9 20.1 10.3C20.8 11.4 20.8 12.8 20.1 13.9C20.4 15.3 19.7 16.7 18.5 17.4C17.9 18.6 16.6 19.3 15.3 19.2C14.6 20.3 13.4 21 12 21C10.6 21 9.4 20.3 8.7 19.2C7.4 19.3 6.1 18.6 5.5 17.4C4.3 16.7 3.6 15.3 3.9 13.9C3.2 12.8 3.2 11.4 3.9 10.3C3.6 8.9 4.3 7.5 5.5 6.8C6.1 5.6 7.4 4.9 8.7 5C9.4 3.9 10.6 3.2 12 3.2Z"
      stroke={color}
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="M9.4 10.2L11.6 12L9.4 13.8M12.6 14H15" stroke={color} strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SidebarMovaBotGridIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <circle cx="8" cy="8" r="3" stroke={color} strokeWidth="1.8" />
    <circle cx="16" cy="8" r="3" stroke={color} strokeWidth="1.8" />
    <circle cx="8" cy="16" r="3" stroke={color} strokeWidth="1.8" />
    <circle cx="16" cy="16" r="3" stroke={color} strokeWidth="1.8" />
  </svg>
);

export const GlobeKeyboardIcon: React.FC<IconProps> = ({ size = 23, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.65" />
    <ellipse cx="12" cy="12" rx="4.2" ry="9" stroke={color} strokeWidth="1.55" />
    <path d="M3.4 9.2H20.6M3.4 14.8H20.6M12 3V21" stroke={color} strokeWidth="1.45" />
  </svg>
);

export const ShiftKeyIcon: React.FC<IconProps> = ({ size = 19, color = 'currentColor', filled = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'}>
    <path
      d="M12 4.5L4.2 12.6H8.6V19H15.4V12.6H19.8L12 4.5Z"
      stroke={color}
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
  </svg>
);

export const BackspaceKeyIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M9.2 6H19.2C20.2 6 21 6.8 21 7.8V16.2C21 17.2 20.2 18 19.2 18H9.2L3.5 12L9.2 6Z"
      stroke={color}
      strokeWidth="1.65"
      strokeLinejoin="round"
    />
    <path d="M12.2 9.8L16.6 14.2M16.6 9.8L12.2 14.2" stroke={color} strokeWidth="1.65" strokeLinecap="round" />
  </svg>
);

export const ReturnArrowIcon: React.FC<IconProps> = ({ size = 19, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M18.5 6.5V12.2C18.5 13.5 17.4 14.5 16.1 14.5H6M6 14.5L9.8 10.7M6 14.5L9.8 18.3" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const EmojiSmileIcon: React.FC<IconProps> = ({ size = 21, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="8.8" fill={color} fillOpacity="0.88" />
    <circle cx="9.2" cy="10.2" r="1.2" fill="#1C1C1E" />
    <circle cx="14.8" cy="10.2" r="1.2" fill="#1C1C1E" />
    <path d="M8.6 13.8C9.4 15.5 11 16.3 12 16.3C13 16.3 14.6 15.5 15.4 13.8" stroke="#1C1C1E" strokeWidth="1.65" strokeLinecap="round" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size = 15, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M6.5 9.5L12 15L17.5 9.5" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ChevronRightIcon: React.FC<IconProps> = ({ size = 15, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path d="M9.5 6.5L15 12L9.5 17.5" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ModeChatBubbleIcon: React.FC<IconProps> = ({ size = 19, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path
      d="M12 4C7.03 4 3 7.36 3 11.5C3 13.43 3.88 15.19 5.33 16.52L4.3 19.7L7.92 18.42C9.17 18.8 10.55 19 12 19C16.97 19 21 15.64 21 11.5C21 7.36 16.97 4 12 4Z"
      stroke={color}
      strokeWidth="1.75"
      strokeLinejoin="round"
    />
  </svg>
);

export const FolderProjectIcon: React.FC<IconProps & { open?: boolean }> = ({
  size = 19,
  color = 'currentColor',
  open = false,
  className,
}) =>
  open ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M3.5 8.2V6.8C3.5 5.7 4.4 4.8 5.5 4.8H9.4C10 4.8 10.6 5.1 11 5.6L12.1 7H18.5C19.6 7 20.5 7.9 20.5 9V10"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M3.2 11.2C3.4 10.4 4.1 9.8 5 9.8H19.4C20.5 9.8 21.3 10.8 21 11.9L19.6 17.6C19.4 18.4 18.7 19 17.8 19H5.2C4.1 19 3.3 18 3.5 16.9L3.2 11.2Z"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M3.5 7C3.5 5.9 4.4 5 5.5 5H9.5C10.1 5 10.7 5.3 11.1 5.8L12.2 7.2H18.5C19.6 7.2 20.5 8.1 20.5 9.2V17C20.5 18.1 19.6 19 18.5 19H5.5C4.4 19 3.5 18.1 3.5 17V7Z"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );

export const HostLocalIcon: React.FC<IconProps> = ({ size = 15, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3.5" y="5" width="17" height="11.5" rx="2" stroke={color} strokeWidth="1.8" />
    <path d="M2 19H22" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export const HostCloudIcon: React.FC<IconProps> = ({ size = 15, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <path
      d="M7 18.5H17.2C19.58 18.5 21.5 16.58 21.5 14.2C21.5 12.02 19.88 10.22 17.77 9.94C17.08 6.82 14.31 4.5 11 4.5C7.13 4.5 4 7.63 4 11.5C4 11.77 4.02 12.03 4.05 12.29C2.85 12.92 2.05 14.18 2.05 15.63C2.05 17.22 3.33 18.5 4.92 18.5H7Z"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** 1:1 from Mova Desktop src/features/chat/chat-transcript.tsx (IconCopy & IconRegenerate) */
export const DesktopCopyIcon: React.FC<IconProps> = ({ size = 17, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect x="5.5" y="5.5" width="7" height="8" rx="1.6" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10.5 5.5V4.2A1.7 1.7 0 0 0 8.8 2.5H4.7A1.7 1.7 0 0 0 3 4.2v6.1a1.7 1.7 0 0 0 1.7 1.7h.8" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const DesktopRegenerateIcon: React.FC<IconProps> = ({ size = 17, color = 'currentColor', className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.6-3.7" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13 3v3.2h-3.2" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
