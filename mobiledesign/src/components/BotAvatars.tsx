import React from 'react';

export type BotAvatarId =
  | 'group-swarm'
  | 'advisor'
  | 'maker'
  | 'scout'
  | 'copy'
  | 'planner'
  | 'review'
  | 'qa';

interface BotMascotProps {
  id: BotAvatarId;
  size?: number;
  onlineDot?: boolean;
  dotBorderColor?: string;
}

/** Single droplet / geometric mascot SVG matching Image 1 & Image 2 */
export const BotMascotAvatar: React.FC<BotMascotProps> = ({
  id,
  size = 48,
  onlineDot = false,
  dotBorderColor = '#000000',
}) => {
  if (id === 'group-swarm') {
    const cell = Math.round(size * 0.45);
    return (
      <div
        className="bot-group-grid"
        style={{ width: `${size}px`, height: `${size}px` }}
        aria-hidden="true"
      >
        <BotMascotAvatar id="advisor" size={cell} />
        <BotMascotAvatar id="scout" size={cell} />
        <BotMascotAvatar id="maker" size={cell} />
        <div style={{ position: 'relative', width: cell, height: cell }}>
          <BotMascotAvatar id="copy" size={cell} />
          <span
            className="bot-online-badge"
            style={{
              width: Math.max(9, Math.round(size * 0.24)),
              height: Math.max(9, Math.round(size * 0.24)),
              borderColor: dotBorderColor,
              right: -2,
              bottom: -2,
            }}
          />
        </div>
      </div>
    );
  }

  const renderGraphic = () => {
    switch (id) {
      case 'advisor':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <path
              d="M35.2 6.5C36.6 5.1 39 5.8 39.5 7.7C42.8 19.6 53 27.6 53 40.2C53 50.8 43.9 58.5 32.5 58.5C21.1 58.5 12 50.5 12 39.4C12 26.8 24.4 17.3 35.2 6.5Z"
              fill="#FF6619"
            />
            <rect
              x="20.5"
              y="32"
              width="6.2"
              height="14.5"
              rx="3.1"
              transform="rotate(-12 20.5 32)"
              fill="#FFFFFF"
            />
            <rect
              x="31.2"
              y="30.2"
              width="6.2"
              height="14.5"
              rx="3.1"
              transform="rotate(-12 31.2 30.2)"
              fill="#FFFFFF"
            />
          </svg>
        );

      case 'maker':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <path
              d="M31.5 7.5C32.8 6 35.1 6.2 36.1 7.9C42.4 18.8 52 27.8 52 39.8C52 50.2 43.3 58 32 58C20.7 58 12 50.2 12 39.8C12 28.2 22.8 17.8 31.5 7.5Z"
              fill="#85583A"
            />
            <rect
              x="26.5"
              y="36"
              width="4.8"
              height="10.5"
              rx="2.4"
              transform="rotate(16 26.5 36)"
              fill="#FFFFFF"
            />
            <rect
              x="35.2"
              y="38"
              width="4.8"
              height="10.5"
              rx="2.4"
              transform="rotate(16 35.2 38)"
              fill="#FFFFFF"
            />
          </svg>
        );

      case 'scout':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="26" fill="#FF2E88" />
            <rect
              x="33"
              y="19"
              width="4.6"
              height="9.2"
              rx="2.3"
              transform="rotate(-16 33 19)"
              fill="#FFFFFF"
            />
            <rect
              x="41.5"
              y="17.5"
              width="4.6"
              height="9.2"
              rx="2.3"
              transform="rotate(-16 41.5 17.5)"
              fill="#FFFFFF"
            />
          </svg>
        );

      case 'copy':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <rect x="7" y="7" width="50" height="50" rx="16" fill="#8C44FF" />
            <rect
              x="34"
              y="18.5"
              width="4.6"
              height="9.5"
              rx="2.3"
              transform="rotate(-14 34 18.5)"
              fill="#FFFFFF"
            />
            <rect
              x="42.5"
              y="17"
              width="4.6"
              height="9.5"
              rx="2.3"
              transform="rotate(-14 42.5 17)"
              fill="#FFFFFF"
            />
          </svg>
        );

      case 'planner':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <path
              d="M26.8 11.5C29.1 7.4 34.9 7.4 37.2 11.5L55.4 44.2C57.6 48.2 54.7 53 50.2 53H13.8C9.3 53 6.4 48.2 8.6 44.2L26.8 11.5Z"
              fill="#0A84FF"
            />
            <rect
              x="30.5"
              y="26"
              width="4.2"
              height="8.8"
              rx="2.1"
              transform="rotate(-10 30.5 26)"
              fill="#FFFFFF"
            />
            <rect
              x="37.8"
              y="25.2"
              width="4.2"
              height="8.8"
              rx="2.1"
              transform="rotate(-10 37.8 25.2)"
              fill="#FFFFFF"
            />
          </svg>
        );

      case 'review':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <path
              d="M26.8 11.5C29.1 7.4 34.9 7.4 37.2 11.5L55.4 44.2C57.6 48.2 54.7 53 50.2 53H13.8C9.3 53 6.4 48.2 8.6 44.2L26.8 11.5Z"
              fill="#12C466"
            />
            <rect
              x="30.5"
              y="26"
              width="4.2"
              height="8.8"
              rx="2.1"
              transform="rotate(-14 30.5 26)"
              fill="#FFFFFF"
            />
            <rect
              x="37.8"
              y="25"
              width="4.2"
              height="8.8"
              rx="2.1"
              transform="rotate(-14 37.8 25)"
              fill="#FFFFFF"
            />
          </svg>
        );

      case 'qa':
        return (
          <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
            <ellipse
              cx="32"
              cy="33"
              rx="26"
              ry="22"
              transform="rotate(-14 32 33)"
              fill="#8B4DFF"
            />
            <rect
              x="34"
              y="20"
              width="4.4"
              height="9"
              rx="2.2"
              transform="rotate(-16 34 20)"
              fill="#FFFFFF"
            />
            <rect
              x="42"
              y="18.5"
              width="4.4"
              height="9"
              rx="2.2"
              transform="rotate(-16 42 18.5)"
              fill="#FFFFFF"
            />
          </svg>
        );
    }
  };

  const dotSize = size >= 72 ? 20 : size >= 44 ? 13 : 9;

  return (
    <div
      className="bot-mascot-wrap"
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      {renderGraphic()}
      {onlineDot && (
        <span
          className="bot-online-badge"
          style={{
            width: `${dotSize}px`,
            height: `${dotSize}px`,
            borderColor: dotBorderColor,
            borderWidth: size >= 72 ? '3.5px' : '2.2px',
          }}
        />
      )}
    </div>
  );
};

/** Studio 3D Render Preview 1: Low-angle perspective of silver aluminum chassis + white keycaps on black stage */
export const KeyboardRenderShotOne: React.FC = () => (
  <svg viewBox="0 0 480 280" className="bot-render-svg" aria-label="Maker 键盘渲染镜头 1">
    <defs>
      <linearGradient id="aluFront" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#8E9299" />
        <stop offset="14%" stopColor="#ECEFF4" />
        <stop offset="50%" stopColor="#D6DAE0" />
        <stop offset="86%" stopColor="#F5F7FA" />
        <stop offset="100%" stopColor="#7A7E85" />
      </linearGradient>
      <linearGradient id="aluLip" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#FFFFFF" />
        <stop offset="100%" stopColor="#9CA1AA" />
      </linearGradient>
      <linearGradient id="keyTop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#FFFFFF" />
        <stop offset="100%" stopColor="#EAECEF" />
      </linearGradient>
    </defs>
    <rect width="480" height="280" fill="#040405" />
    {/* Perspective Outer Aluminum Tray */}
    <polygon points="118,98 362,98 468,218 12,218" fill="#B8BDC6" />
    <polygon points="124,101 356,101 452,212 28,212" fill="#23252A" />
    {/* Sculpted White Keycap Rows in Perspective */}
    <polygon points="130,94 350,94 438,206 42,206" fill="url(#keyTop)" />
    {/* Perspective Key Grid Lines */}
    <g stroke="#D4D7DD" strokeWidth="1.4" opacity="0.85">
      <line x1="66" y1="184" x2="414" y2="184" />
      <line x1="86" y1="162" x2="394" y2="162" />
      <line x1="102" y1="142" x2="378" y2="142" />
      <line x1="116" y1="124" x2="364" y2="124" />
      <line x1="126" y1="108" x2="354" y2="108" />
      <line x1="162" y1="94" x2="118" y2="206" />
      <line x1="202" y1="94" x2="182" y2="206" />
      <line x1="240" y1="94" x2="240" y2="206" />
      <line x1="278" y1="94" x2="298" y2="206" />
      <line x1="318" y1="94" x2="362" y2="206" />
    </g>
    {/* Chamfered Anodized Aluminum Front Bezel */}
    <rect x="12" y="213" width="456" height="7" rx="2" fill="url(#aluLip)" />
    <path d="M12 218 H468 L458 250 C455 255 449 258 441 258 H39 C31 258 25 255 22 250 Z" fill="url(#aluFront)" />
    <line x1="20" y1="221" x2="460" y2="221" stroke="#52565E" strokeWidth="1.5" />
  </svg>
);

/** Studio 3D Render Preview 2: Macro close-up of curved brushed aluminum side profile */
export const KeyboardRenderShotTwo: React.FC = () => (
  <svg viewBox="0 0 480 280" className="bot-render-svg" aria-label="Maker 键盘渲染镜头 2">
    <defs>
      <linearGradient id="macroBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#F5F7FA" />
        <stop offset="28%" stopColor="#FFFFFF" />
        <stop offset="72%" stopColor="#D7DCE2" />
        <stop offset="94%" stopColor="#A9B0B9" />
        <stop offset="100%" stopColor="#7C828B" />
      </linearGradient>
      <linearGradient id="chromeRim" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#9DA3AE" />
        <stop offset="45%" stopColor="#FFFFFF" />
        <stop offset="70%" stopColor="#656A73" />
        <stop offset="100%" stopColor="#E6E9EF" />
      </linearGradient>
    </defs>
    <rect width="480" height="280" fill="#050506" />
    {/* Soft White Keycap Top Plane */}
    <polygon points="0,8 480,2 480,68 0,82" fill="#ECEDEF" />
    {/* Specular Chrome Chamfer Strip */}
    <polygon points="0,78 480,60 480,74 0,92" fill="url(#chromeRim)" />
    <line x1="0" y1="84" x2="480" y2="66" stroke="#3B3E45" strokeWidth="2.2" />
    {/* Sculpted Curved Aluminum Side Profile */}
    <polygon points="0,90 480,72 480,204 0,242" fill="url(#macroBody)" />
  </svg>
);
