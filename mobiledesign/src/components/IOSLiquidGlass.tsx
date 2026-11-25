import React, { useId, useMemo, useRef, useState } from 'react';
import type { LiquidGlassConfig } from '../types';
import { getKyantHighlightMap, getKyantLensMap } from '../utils/kyantLiquidGlass';

export type GlassVariant = 'bar' | 'composer' | 'menu' | 'blue' | 'subtle';

interface IOSLiquidGlassProps {
  width: number;
  height: number;
  cornerRadius: number;
  config: LiquidGlassConfig;
  variant?: GlassVariant;
  interactive?: boolean;
  className?: string;
  contentClassName?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  title?: string;
  children: React.ReactNode;
}

/**
 * Kyant0/AndroidLiquidGlass (`com.kyant.backdrop`) React/SVG Runtime Shader port:
 * - Exact RoundedRect SDF meniscus lens (`sdRoundedRect` + `circleMap` + `gradSdRoundedRect`)
 * - Spectral chromatic dispersion along lens rim
 * - SDF-gradient directional rim highlight (`Highlight.Default` / `Highlight.Ambient`)
 * - `LiquidButton.kt` + `InteractiveHighlight.kt` press bloom (`1 + 4/height`), `tanh` spring drag & additive pointer glow
 */
export const IOSLiquidGlass: React.FC<IOSLiquidGlassProps> = ({
  width,
  height,
  cornerRadius,
  config,
  variant = 'bar',
  interactive,
  className = '',
  contentClassName = '',
  onClick,
  title,
  children,
}) => {
  const rawId = useId();
  const filterId = useMemo(() => `kyant-lens-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [rawId]);
  const hostRef = useRef<HTMLDivElement>(null);

  const isInteractive = interactive ?? Boolean(onClick);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pointerPos, setPointerPos] = useState({ x: width * 0.5, y: height * 0.5 });
  const [dragDelta, setDragDelta] = useState({ x: 0, y: 0 });
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);

  const lensMap = useMemo(
    () =>
      getKyantLensMap(
        width,
        height,
        cornerRadius,
        Math.min(config.refractionHeight, Math.min(width, height) * 0.45),
        config.refractionAmount,
        config.depthEffect
      ),
    [width, height, cornerRadius, config.refractionHeight, config.refractionAmount, config.depthEffect]
  );

  const highlightUrl = useMemo(
    () => getKyantHighlightMap(width, height, cornerRadius, config.highlightStyle, config.highlightAngle),
    [width, height, cornerRadius, config.highlightStyle, config.highlightAngle]
  );

  // Ported from Kyant0 LiquidButton.kt layerBlock (tanh translation + press bloom scale)
  const minDim = Math.min(width, height);
  const maxDim = Math.max(width, height);
  const tx = isInteractive ? minDim * Math.tanh((0.05 * dragDelta.x) / minDim) : 0;
  const ty = isInteractive ? minDim * Math.tanh((0.05 * dragDelta.y) / minDim) : 0;
  const baseScale = isInteractive && pressed ? 1 + Math.min(0.07, 3.6 / height) : 1;
  const stretchX =
    isInteractive && pressed
      ? baseScale + (3.2 / height) * Math.abs(dragDelta.x / maxDim) * Math.min(1, width / height)
      : baseScale;
  const stretchY =
    isInteractive && pressed
      ? baseScale + (3.2 / height) * Math.abs(dragDelta.y / maxDim) * Math.min(1, height / width)
      : baseScale;

  const dispR = lensMap.scale * (1 + config.chromaticAberration * 0.16);
  const dispG = lensMap.scale;
  const dispB = lensMap.scale * Math.max(0.4, 1 - config.chromaticAberration * 0.16);

  const updatePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hostRef.current) return;
    const rect = hostRef.current.getBoundingClientRect();
    const scaleRatioX = rect.width > 0 ? width / rect.width : 1;
    const scaleRatioY = rect.height > 0 ? height / rect.height : 1;
    const localX = (e.clientX - rect.left) * scaleRatioX;
    const localY = (e.clientY - rect.top) * scaleRatioY;
    setPointerPos({
      x: Math.max(0, Math.min(width, localX)),
      y: Math.max(0, Math.min(height, localY)),
    });
    if (dragOrigin.current) {
      setDragDelta({
        x: (e.clientX - dragOrigin.current.x) * scaleRatioX,
        y: (e.clientY - dragOrigin.current.y) * scaleRatioY,
      });
    }
  };

  return (
    <div
      ref={hostRef}
      className={`kyant-lg-host kyant-lg-host--${variant} ${isInteractive ? 'is-interactive' : ''} ${className}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        borderRadius: `${cornerRadius}px`,
        transform: `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${stretchX.toFixed(4)}, ${stretchY.toFixed(4)})`,
      }}
      title={title}
      onClick={onClick}
      onPointerEnter={(e) => {
        setHovered(true);
        updatePointer(e);
      }}
      onPointerMove={updatePointer}
      onPointerLeave={() => {
        setHovered(false);
        setPressed(false);
        dragOrigin.current = null;
        setDragDelta({ x: 0, y: 0 });
      }}
      onPointerDown={(e) => {
        if (!isInteractive) return;
        setPressed(true);
        dragOrigin.current = { x: e.clientX, y: e.clientY };
        updatePointer(e);
      }}
      onPointerUp={() => {
        setPressed(false);
        dragOrigin.current = null;
        setDragDelta({ x: 0, y: 0 });
      }}
    >
      {/* Hidden SVG Runtime Filter matching Kyant0 RoundedRectRefractionWithDispersion */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0 }}
        aria-hidden="true"
      >
        <defs>
          <filter
            id={filterId}
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            filterUnits="objectBoundingBox"
            primitiveUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={lensMap.dataUrl}
              x="0"
              y="0"
              width={width}
              height={height}
              preserveAspectRatio="none"
              result="KYANT_MAP"
            />
            {config.chromaticAberration > 0.02 ? (
              <>
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="KYANT_MAP"
                  scale={dispR}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="DISP_R"
                />
                <feColorMatrix
                  in="DISP_R"
                  type="matrix"
                  values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="CH_R"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="KYANT_MAP"
                  scale={dispG}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="DISP_G"
                />
                <feColorMatrix
                  in="DISP_G"
                  type="matrix"
                  values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                  result="CH_G"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="KYANT_MAP"
                  scale={dispB}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="DISP_B"
                />
                <feColorMatrix
                  in="DISP_B"
                  type="matrix"
                  values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                  result="CH_B"
                />
                <feBlend in="CH_R" in2="CH_G" mode="screen" result="CH_RG" />
                <feBlend in="CH_RG" in2="CH_B" mode="screen" result="REFRACTED" />
              </>
            ) : (
              <feDisplacementMap
                in="SourceGraphic"
                in2="KYANT_MAP"
                scale={dispG}
                xChannelSelector="R"
                yChannelSelector="G"
                result="REFRACTED"
              />
            )}
          </filter>
        </defs>
      </svg>

      {/* Layer 1: Backdrop Blur + Vibrancy + Meniscus Lens Refraction */}
      <span
        className="kyant-lg-backdrop"
        style={{
          borderRadius: `${cornerRadius}px`,
          backdropFilter: `url(#${filterId}) blur(${
            variant === 'menu' ? Math.max(20, config.blurRadius * 2.5) : config.blurRadius
          }px) saturate(${config.vibrancy}%) brightness(1.06)`,
          WebkitBackdropFilter: `blur(${
            variant === 'menu' ? Math.max(20, config.blurRadius * 2.5) : config.blurRadius
          }px) saturate(${config.vibrancy}%) brightness(1.06)`,
        }}
      />

      {/* Layer 2: Surface Material Tint (iOS 26 Dark Smoked / Kyant Hue+Alpha Blue Tint) */}
      <span
        className={`kyant-lg-tint kyant-lg-tint--${variant}`}
        style={{ borderRadius: `${cornerRadius}px` }}
      />

      {/* Layer 3: Kyant InteractiveHighlight.kt Additive Radial Pointer Glow */}
      {isInteractive && (
        <span
          className="kyant-lg-interactive-glow"
          style={{
            borderRadius: `${cornerRadius}px`,
            opacity: pressed ? 0.95 : hovered ? 0.45 : 0,
            background: `radial-gradient(${minDim * 1.45}px circle at ${pointerPos.x}px ${pointerPos.y}px, rgba(255,255,255,${pressed ? 0.22 : 0.11}) 0%, rgba(255,255,255,0.04) 48%, rgba(255,255,255,0) 100%)`,
          }}
        />
      )}

      {/* Layer 4: Kyant HighlightStyle.Default / Ambient SDF-Gradient Rim Gleam */}
      <img
        src={highlightUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="kyant-lg-rim"
        style={{
          borderRadius: `${cornerRadius}px`,
          opacity: variant === 'composer' ? config.highlightAlpha * 0.58 : config.highlightAlpha * 0.82,
        }}
      />

      {/* Layer 5: Crisp Foreground Content */}
      <div className={`kyant-lg-content ${contentClassName}`}>{children}</div>
    </div>
  );
};
