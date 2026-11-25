import React from 'react';
import type { LiquidGlassConfig } from '../types';
import {
  ComposeSquareIcon,
  EllipsisRowIcon,
  MenuLinesIcon,
  PlusIcon,
  SearchMagnifierIcon,
  VoiceWaveIcon,
} from './IOSIcons';
import { IOSLiquidGlass } from './IOSLiquidGlass';

interface ComponentSpecBoardProps {
  glassConfig: LiquidGlassConfig;
}

const COLOR_TOKENS = [
  { name: 'System Background', hex: '#000000', desc: 'iOS 26 OLED 纯黑底层画布' },
  { name: 'Elevated Code Surface', hex: '#17171A', desc: 'Plain text 代码块容器底色' },
  { name: 'Liquid Glass Smoked', hex: 'rgba(38,38,43,0.56)', desc: 'Kyant Meniscus 折射烟熏玻璃层' },
  { name: 'iOS Accent Blue', hex: '#2B5BFF', desc: '主操作胶囊 / 实时语音按钮' },
  { name: 'Label Primary', hex: '#F5F5F7', desc: '正文与标题高对比文字' },
  { name: 'Label Secondary', hex: '#8E8E93', desc: '占位符 / 思考档位 / 辅助说明' },
];

const TYPE_SPECS = [
  { role: 'Sidebar Brand', spec: 'SF Pro Display · 24pt Semibold · -0.5px', sample: 'Mova' },
  { role: 'Nav Bar Headline', spec: 'SF Pro Text · 17pt Semibold · 22pt LH', sample: '工作' },
  { role: 'Conversation Body', spec: 'PingFang SC / SF Pro · 16.5pt Regular · 26.5pt LH', sample: '我在服务器本机分别通过两条新线路访问网页' },
  { role: 'Section Subheadline', spec: 'PingFang SC · 17pt Semibold · 24pt LH', sample: 'REALITY 高位端口' },
  { role: 'Code Block Mono', spec: 'SF Mono · 13.5pt Regular · 21pt LH', sample: 'vless://fb81f57d-4736-4805...' },
  { role: 'Model & Effort Meta', spec: 'SF Pro Text · 14.5pt Medium + 14pt Muted', sample: 'DeepSeek V4.1 高' },
];

export const ComponentSpecBoard: React.FC<ComponentSpecBoardProps> = ({ glassConfig }) => {
  return (
    <div className="spec-board">
      <div className="spec-board-header">
        <div>
          <span className="spec-eyebrow">APPLE HIG · iOS 26 DESIGN SYSTEM</span>
          <h3 className="spec-title">Mova Mobile 组件与液态玻璃规范</h3>
        </div>
        <span className="spec-engine-tag">Shader: Kyant0 / AndroidLiquidGlass (Backdrop SDF)</span>
      </div>

      {/* Section 1: Live Kyant Liquid Glass Optical Bench */}
      <div className="spec-section">
        <div className="spec-section-head">
          <span>01 · 液态玻璃光学测试台（可按压拖拽感受透镜折射与边缘双弧高光）</span>
          <small>
            refractionHeight {glassConfig.refractionHeight}pt · refractionAmount {glassConfig.refractionAmount}pt
          </small>
        </div>

        <div className="spec-optical-stage">
          {/* High-contrast geometric pattern + typography behind glass to showcase true meniscus lens bending */}
          <div className="spec-stage-backdrop" aria-hidden="true">
            <div className="spec-stage-stripes" />
            <span className="spec-stage-orb spec-stage-orb--1" />
            <span className="spec-stage-orb spec-stage-orb--2" />
            <span className="spec-stage-orb spec-stage-orb--3" />
            <div className="spec-stage-watermark">
              MOVA LIQUID GLASS · MENISCUS SDF REFRACTION · CHROMATIC DISPERSION
            </div>
          </div>

          <div className="spec-controls-row">
            <div className="spec-control-item">
              <IOSLiquidGlass width={44} height={44} cornerRadius={22} config={glassConfig} variant="bar" onClick={() => {}}>
                <MenuLinesIcon size={20} color="#FFFFFF" />
              </IOSLiquidGlass>
              <span>Nav Menu · 44pt</span>
            </div>

            <div className="spec-control-item">
              <IOSLiquidGlass width={44} height={44} cornerRadius={22} config={glassConfig} variant="bar" onClick={() => {}}>
                <EllipsisRowIcon size={19} color="#FFFFFF" />
              </IOSLiquidGlass>
              <span>More Island · 44pt</span>
            </div>

            <div className="spec-control-item">
              <IOSLiquidGlass width={44} height={44} cornerRadius={22} config={glassConfig} variant="bar" onClick={() => {}}>
                <SearchMagnifierIcon size={19} color="#FFFFFF" />
              </IOSLiquidGlass>
              <span>Search Island · 44pt</span>
            </div>

            <div className="spec-control-item">
              <IOSLiquidGlass
                width={118}
                height={48}
                cornerRadius={24}
                config={glassConfig}
                variant="blue"
                onClick={() => {}}
                contentClassName="mova-drawer-chat-pill"
              >
                <ComposeSquareIcon size={19} color="#FFFFFF" />
                <span>聊天</span>
              </IOSLiquidGlass>
              <span>Chat CTA · 118×48pt</span>
            </div>

            <div className="spec-control-item">
              <IOSLiquidGlass width={48} height={48} cornerRadius={24} config={glassConfig} variant="blue" onClick={() => {}}>
                <PlusIcon size={23} color="#FFFFFF" />
              </IOSLiquidGlass>
              <span>Bot Add · 48pt</span>
            </div>

            <div className="spec-control-item">
              <IOSLiquidGlass width={48} height={48} cornerRadius={24} config={glassConfig} variant="bar" onClick={() => {}}>
                <span className="mova-avatar-badge">雪</span>
              </IOSLiquidGlass>
              <span>Account Island · 48pt</span>
            </div>
          </div>

          {/* Unified Split Composer Specimen */}
          <div className="spec-composer-demo">
            <div className="spec-split-composer">
              <IOSLiquidGlass width={48} height={48} cornerRadius={24} config={glassConfig} variant="composer" onClick={() => {}}>
                <PlusIcon size={23} color="#F2F2F7" />
              </IOSLiquidGlass>
              <IOSLiquidGlass
                width={314}
                height={48}
                cornerRadius={24}
                config={glassConfig}
                variant="composer"
                onClick={() => {}}
                contentClassName="movabot-input-capsule"
              >
                <span className="mova-idle-placeholder">与 Mova 协作</span>
                <span className="mova-voice-circle-btn">
                  <VoiceWaveIcon size={18} color="#FFFFFF" />
                </span>
              </IOSLiquidGlass>
            </div>
            <span className="spec-caption">Split Composer · 48pt + 314×48pt · Single Voice Orb</span>
          </div>
        </div>
      </div>

      {/* Section 2: Color & Material Tokens + Safe Area Rules */}
      <div className="spec-two-col">
        <div className="spec-section">
          <div className="spec-section-head">
            <span>02 · 色彩与材质语义变量</span>
          </div>
          <div className="spec-token-grid">
            {COLOR_TOKENS.map((t) => (
              <div key={t.name} className="spec-token-card">
                <span className="spec-swatch" style={{ background: t.hex }} />
                <div>
                  <div className="spec-token-name">{t.name}</div>
                  <div className="spec-token-hex">{t.hex}</div>
                  <div className="spec-token-desc">{t.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="spec-section">
          <div className="spec-section-head">
            <span>03 · iOS 26 排版与安全区准则 (402 × 874 pt)</span>
          </div>
          <div className="spec-type-list">
            {TYPE_SPECS.map((item) => (
              <div key={item.role} className="spec-type-row">
                <div className="spec-type-meta">
                  <strong>{item.role}</strong>
                  <span>{item.spec}</span>
                </div>
                <div className="spec-type-sample">{item.sample}</div>
              </div>
            ))}
          </div>
          <div className="spec-hig-rules">
            <span>Safe Top: 54pt</span>
            <span>Tap Target: ≥44×44pt</span>
            <span>Page Margin: 16–20pt</span>
            <span>Keyboard: 296pt</span>
            <span>Home Inset: 34pt</span>
            <span>严禁 Glass-on-Glass 叠层</span>
          </div>
        </div>
      </div>
    </div>
  );
};
