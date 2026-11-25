/**
 * 负责：绘制 MovaBot 吉祥物头像与 MovaBot 聊天流中的 3D 铝壳键盘渲染预览图。
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient as SvgLinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import type { BotAvatarId } from '../features/design/mova-design-data';

const SingleMascotSvg: React.FC<{ id: Exclude<BotAvatarId, 'group-swarm'>; size: number }> = ({
  id,
  size,
}) => {
  switch (id) {
    case 'advisor':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Path
            d="M34.8 6.4C37.4 13.5 49.4 23.6 49.4 36.8C49.4 47.4 41.2 55.6 30.8 55.6C20.4 55.6 13.6 47.6 13.6 37.8C13.6 26.8 24.4 17.4 31.6 7.4C32.5 6 34.3 5.2 34.8 6.4Z"
            fill="#FF5C00"
          />
          <G transform="rotate(-11 30 38)">
            <Rect x={22.2} y={30.5} width={5.4} height={15.2} rx={2.7} fill="#FFFFFF" />
            <Rect x={31.2} y={29.4} width={5.4} height={15.2} rx={2.7} fill="#FFFFFF" />
          </G>
        </Svg>
      );
    case 'maker':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Path
            d="M33.2 8.4C36.8 14.8 48.2 24.6 48.2 36.8C48.2 46.8 40.2 54.4 30.6 54.4C20.8 54.4 14.4 46.8 14.4 37.6C14.4 27.6 24.4 17.8 30.2 8.8C31.1 7.4 32.6 7.3 33.2 8.4Z"
            fill="#8E562E"
          />
          <G transform="rotate(14 33 41)">
            <Rect x={26.5} y={35.5} width={4.2} height={10.2} rx={2.1} fill="#FFFFFF" />
            <Rect x={33.8} y={34.5} width={4.2} height={10.2} rx={2.1} fill="#FFFFFF" />
          </G>
        </Svg>
      );
    case 'scout':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Circle cx={32} cy={32} r={24.5} fill="#FF2B8D" />
          <G transform="rotate(-14 39 24)">
            <Rect x={34.2} y={18.8} width={3.6} height={7.4} rx={1.8} fill="#FFFFFF" />
            <Rect x={40.4} y={17.8} width={3.6} height={7.4} rx={1.8} fill="#FFFFFF" />
          </G>
        </Svg>
      );
    case 'copy':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Rect x={9} y={10} width={46} height={44} rx={13} fill="#934BFF" />
          <G transform="rotate(-10 40 24)">
            <Rect x={35.5} y={19.4} width={3.6} height={7.2} rx={1.8} fill="#FFFFFF" />
            <Rect x={41.6} y={18.6} width={3.6} height={7.2} rx={1.8} fill="#FFFFFF" />
          </G>
        </Svg>
      );
    case 'planner':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Path
            d="M27.6 13.8C29.6 10.3 34.6 10.3 36.6 13.8L53.8 43.8C55.8 47.3 53.3 51.6 49.3 51.6H14.9C10.9 51.6 8.4 47.3 10.4 43.8L27.6 13.8Z"
            fill="#1488FF"
          />
          <G transform="rotate(-12 36 30)">
            <Rect x={33.2} y={26.5} width={2.9} height={6.1} rx={1.45} fill="#FFFFFF" />
            <Rect x={37.9} y={25.8} width={2.9} height={6.1} rx={1.45} fill="#FFFFFF" />
          </G>
        </Svg>
      );
    case 'review':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Path
            d="M27.6 13.8C29.6 10.3 34.6 10.3 36.6 13.8L53.8 43.8C55.8 47.3 53.3 51.6 49.3 51.6H14.9C10.9 51.6 8.4 47.3 10.4 43.8L27.6 13.8Z"
            fill="#12C462"
          />
          <G transform="rotate(-12 36 30)">
            <Rect x={33.2} y={26.5} width={2.9} height={6.1} rx={1.45} fill="#FFFFFF" />
            <Rect x={37.9} y={25.8} width={2.9} height={6.1} rx={1.45} fill="#FFFFFF" />
          </G>
        </Svg>
      );
    case 'qa':
      return (
        <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
          <Ellipse cx={32} cy={33} rx={24.5} ry={21.5} fill="#8D4BFF" />
          <G transform="rotate(-12 40 26)">
            <Rect x={35.2} y={21.4} width={3.6} height={7.6} rx={1.8} fill="#FFFFFF" />
            <Rect x={41.4} y={20.4} width={3.6} height={7.6} rx={1.8} fill="#FFFFFF" />
          </G>
        </Svg>
      );
  }
};

export const BotMascotAvatar: React.FC<{
  id: BotAvatarId;
  size?: number;
  onlineDot?: boolean;
  dotBorderColor?: string;
}> = ({ id, size = 46, onlineDot = false, dotBorderColor = '#000000' }) => {
  const dotSize = Math.max(8, Math.round(size * 0.24));

  if (id === 'group-swarm') {
    const mini = Math.floor(size * 0.46);
    return (
      <View style={[styles.wrap, { width: size, height: size }]}>
        <View style={[styles.groupGrid, { width: size, height: size }]}>
          <SingleMascotSvg id="advisor" size={mini} />
          <SingleMascotSvg id="scout" size={mini} />
          <SingleMascotSvg id="maker" size={mini} />
          <SingleMascotSvg id="copy" size={mini} />
        </View>
        <View
          style={[
            styles.onlineDot,
            {
              width: Math.max(9, Math.round(size * 0.22)),
              height: Math.max(9, Math.round(size * 0.22)),
              borderRadius: 99,
              borderColor: dotBorderColor,
            },
          ]}
        />
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <SingleMascotSvg id={id} size={size} />
      {onlineDot && (
        <View
          style={[
            styles.onlineDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              borderColor: dotBorderColor,
              borderWidth: size >= 44 ? 2.2 : 1.6,
            },
          ]}
        />
      )}
    </View>
  );
};

export const KeyboardRenderShotOne: React.FC = () => (
  <Svg width="100%" height="100%" viewBox="0 0 280 142" fill="none">
    <Defs>
      <SvgLinearGradient id="aluSide1" x1="0" y1="0" x2="280" y2="90" gradientUnits="userSpaceOnUse">
        <Stop offset="0%" stopColor="#1B1C20" />
        <Stop offset="26%" stopColor="#D6D8DD" />
        <Stop offset="55%" stopColor="#6E7178" />
        <Stop offset="85%" stopColor="#B8BCC4" />
        <Stop offset="100%" stopColor="#1A1B1F" />
      </SvgLinearGradient>
      <SvgLinearGradient id="keyTop1" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
        <Stop offset="0%" stopColor="#FFFFFF" />
        <Stop offset="100%" stopColor="#D6D7DC" />
      </SvgLinearGradient>
    </Defs>
    <Rect width={280} height={142} fill="#060608" />
    <Path d="M4 102L262 72L276 86L18 124Z" fill="#0B0B0E" />
    <Path d="M8 94L254 64L270 76L20 112Z" fill="url(#aluSide1)" />
    <Path d="M12 91L250 61L264 68L22 100Z" fill="#2A2C32" />
    {[0, 1, 2, 3, 4, 5, 6].map((col) => {
      const x = 44 + col * 29;
      const y = 78 - col * 3.6;
      return (
        <G key={`r1-${col}`}>
          <Path
            d={`M${x} ${y} L${x + 24} ${y - 3} L${x + 27} ${y + 9} L${x + 3} ${y + 12} Z`}
            fill="url(#keyTop1)"
          />
          <Path
            d={`M${x + 3} ${y + 12} L${x + 27} ${y + 9} L${x + 27} ${y + 15} L${x + 3} ${y + 18} Z`}
            fill="#9A9CA4"
          />
        </G>
      );
    })}
    {[0, 1, 2, 3, 4, 5].map((col) => {
      const x = 62 + col * 29;
      const y = 63 - col * 3.5;
      return (
        <Path
          key={`r2-${col}`}
          d={`M${x} ${y} L${x + 24} ${y - 3} L${x + 27} ${y + 8} L${x + 3} ${y + 11} Z`}
          fill="#EAEBF0"
          opacity={0.94}
        />
      );
    })}
  </Svg>
);

export const KeyboardRenderShotTwo: React.FC = () => (
  <Svg width="100%" height="100%" viewBox="0 0 280 142" fill="none">
    <Defs>
      <SvgLinearGradient id="aluMacro" x1="0" y1="22" x2="0" y2="128" gradientUnits="userSpaceOnUse">
        <Stop offset="0%" stopColor="#F5F6F8" />
        <Stop offset="42%" stopColor="#ECEDF0" />
        <Stop offset="52%" stopColor="#B4B8C0" />
        <Stop offset="56%" stopColor="#3B3E44" />
        <Stop offset="62%" stopColor="#EEF0F3" />
        <Stop offset="88%" stopColor="#C8CCD4" />
        <Stop offset="100%" stopColor="#9498A0" />
      </SvgLinearGradient>
    </Defs>
    <Rect width={280} height={142} fill="#050507" />
    <Path d="M18 14L262 6L262 118L18 134Z" fill="url(#aluMacro)" />
    <Path d="M18 68L262 56" stroke="#2D3036" strokeWidth={2.5} opacity={0.75} />
    <Path d="M18 71L262 59" stroke="#FFFFFF" strokeWidth={1.4} opacity={0.85} />
  </Svg>
);

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignContent: 'space-between',
  },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    backgroundColor: '#30D158',
    borderWidth: 2,
  },
});
