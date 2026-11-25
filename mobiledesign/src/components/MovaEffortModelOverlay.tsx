import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EFFORT_CATALOG, MOVA_MODELS } from '../data/movaData';
import type { EffortLevelId, EffortStop, LiquidGlassConfig, MovaModelOption } from '../types';
import { CheckTinyIcon, ChevronDownIcon } from './IOSIcons';
import { IOSLiquidGlass } from './IOSLiquidGlass';

const STARS = Array.from({ length: 64 }, (_, i) => ({
  x: (i * 0.61803398875) % 1,
  y: (i * 0.754877666) % 1,
  size: 0.35 + (i % 5) * 0.13,
  speed: 0.3 + (i % 7) * 0.1,
}));

interface MovaEffortSliderProps {
  stops: EffortStop[];
  value: EffortLevelId;
  onChange: (next: EffortLevelId) => void;
}

/**
 * 1:1 port of Mova Desktop `EffortSlider` & `createEffortField` from
 * `vendor/leibox/DeepAgentComposerEngine.js` (lines 1465–1825)
 */
export const MovaEffortSlider: React.FC<MovaEffortSliderProps> = ({
  stops,
  value,
  onChange,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeIdx = Math.max(
    0,
    stops.findIndex((s) => s.value === value)
  );
  const maxIdx = Math.max(1, stops.length - 1);

  const [previewIdx, setPreviewIdx] = useState(activeIdx);
  const [dragging, setDragging] = useState(false);

  const targetRatioRef = useRef(activeIdx / maxIdx);
  const currentRatioRef = useRef(activeIdx / maxIdx);
  const dragStateRef = useRef<{
    pointerId: number;
    lastX: number;
    lastTime: number;
    body: number;
    lean: number;
    press: number;
    boost: number;
  }>({
    pointerId: -1,
    lastX: 0,
    lastTime: 0,
    body: 0,
    lean: 0,
    press: 1,
    boost: 1,
  });

  useEffect(() => {
    if (!dragging) {
      setPreviewIdx(activeIdx);
      targetRatioRef.current = activeIdx / maxIdx;
    }
  }, [activeIdx, maxIdx, dragging]);

  // 60fps Canvas Starfield + 7 Screen-Blended Wave Bands + Spring Jelly Thumb
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let phase = 0;
    let prevTs = performance.now();
    let width = 0;
    let height = 0;

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const frame = (ts: number) => {
      const dt = Math.min(Math.max((ts - prevTs) / 1000, 0), 0.05);
      prevTs = ts;

      const d = dragStateRef.current;
      // Smooth spring glide toward target ratio
      const lerpSpeed = d.pointerId !== -1 ? 26 : 12;
      currentRatioRef.current +=
        (targetRatioRef.current - currentRatioRef.current) * Math.min(1, dt * lerpSpeed);
      const ratio = Math.max(0, Math.min(1, currentRatioRef.current));

      // Elastic decay for jelly thumb deformation & wave motion boost
      d.body += (0 - d.body) * Math.min(1, dt * 8);
      d.lean += (0 - d.lean) * Math.min(1, dt * 8);
      d.boost += (1 - d.boost) * Math.min(1, dt * 4);
      const targetPress = d.pointerId !== -1 ? 0.96 : 1;
      d.press += (targetPress - d.press) * Math.min(1, dt * 16);

      root.style.setProperty('--effort-ratio', ratio.toFixed(4));
      root.style.setProperty('--effort-press', d.press.toFixed(4));
      root.style.setProperty('--effort-jelly-x', (1 + d.body).toFixed(4));
      root.style.setProperty('--effort-jelly-y', (1 - d.body * 0.3).toFixed(4));
      root.style.setProperty('--effort-jelly-offset', `${(-d.lean * 9).toFixed(2)}px`);
      root.style.setProperty('--effort-jelly-skew', `${(-d.lean * 12).toFixed(2)}deg`);
      root.style.setProperty('--effort-jelly-left', `${(50 + d.lean * 32).toFixed(1)}%`);
      root.style.setProperty('--effort-jelly-right', `${(50 - d.lean * 24).toFixed(1)}%`);

      if (width > 0 && height > 0) {
        phase += dt * (0.28 + ratio * 1.1) * Math.max(1, d.boost);
        const hue = 210 + ratio * ratio * 63;
        const fill = 32 + (width - 32) * ratio;

        ctx.clearRect(0, 0, width, height);

        const base = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0);
        base.addColorStop(0, '#30343a');
        base.addColorStop(0.28, `hsl(${hue - 12} 38% 47%)`);
        base.addColorStop(0.65, `hsl(${hue} 79% 70%)`);
        base.addColorStop(1, `hsl(${hue + 5} 88% 70%)`);
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, width, height);

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let band = 0; band < 7; band++) {
          ctx.beginPath();
          for (let x = 0; x <= width + 4; x += 4) {
            const y =
              height * (0.12 + band * 0.15) +
              Math.sin(x * 0.034 + phase + band * 1.8) * 5 +
              Math.sin(x * 0.079 - phase * 0.6 + band) * 2 -
              x * 0.035;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.lineWidth = 2 + (band % 3) * 2;
          ctx.strokeStyle = `hsla(${hue + band * 2} 90% 87% / ${0.07 + ratio * 0.03})`;
          ctx.stroke();
        }

        const glowX = fill * (0.6 + Math.sin(phase * 0.7) * 0.12);
        const glow = ctx.createRadialGradient(glowX, height * 0.7, 0, glowX, height * 0.7, 46);
        glow.addColorStop(0, `hsla(${hue - 12} 100% 88% / 0.35)`);
        glow.addColorStop(1, `hsla(${hue} 100% 80% / 0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);

        for (let i = 0; i < STARS.length; i++) {
          const star = STARS[i];
          const x = ((star.x + phase * star.speed * 0.08) % 1) * width;
          const y = ((((star.y - phase * star.speed * 0.04) % 1) + 1) % 1) * height;
          const fade = Math.min(1, x / 55);
          const twinkle = 0.45 + Math.sin(phase * 2 + i * 1.9) * 0.25;
          ctx.fillStyle = `rgba(255,255,255,${fade * twinkle * (0.4 + ratio * 0.6)})`;
          ctx.beginPath();
          ctx.ellipse(
            x,
            y,
            star.size * (1 + ratio * 0.5),
            star.size * 0.65,
            -0.45,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
        ctx.restore();

        const shade = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0);
        shade.addColorStop(0, 'rgba(36,39,44,0.8)');
        shade.addColorStop(0.45, 'rgba(36,39,44,0)');
        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, width, height);
      }

      rafId = window.requestAnimationFrame(frame);
    };

    rafId = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const ratioFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pad = 16;
    const usable = Math.max(1, rect.width - pad * 2);
    return Math.max(0, Math.min(1, (clientX - rect.left - pad) / usable));
  };

  const commitIndex = (idx: number) => {
    const clamped = Math.max(0, Math.min(maxIdx, Math.round(idx)));
    setPreviewIdx(clamped);
    targetRatioRef.current = clamped / maxIdx;
    const stop = stops[clamped];
    if (stop && stop.value !== value) {
      onChange(stop.value);
    }
  };

  const selectedIdx = Math.max(0, Math.min(maxIdx, Math.round(previewIdx)));

  return (
    <div
      ref={rootRef}
      className="mova-effort-root"
      data-dragging={dragging ? 'true' : undefined}
      data-maximum={selectedIdx === maxIdx ? 'true' : undefined}
    >
      <div
        ref={trackRef}
        className="mova-effort-track"
        role="slider"
        tabIndex={0}
        aria-label="思考强度"
        aria-valuemin={0}
        aria-valuemax={maxIdx}
        aria-valuenow={selectedIdx}
        aria-valuetext={stops[selectedIdx]?.label}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          const r = ratioFromClientX(e.clientX);
          targetRatioRef.current = r;
          setPreviewIdx(r * maxIdx);
          setDragging(true);
          dragStateRef.current.pointerId = e.pointerId;
          dragStateRef.current.lastX = e.clientX;
          dragStateRef.current.lastTime = e.timeStamp;
        }}
        onPointerMove={(e) => {
          if (dragStateRef.current.pointerId !== e.pointerId) return;
          const r = ratioFromClientX(e.clientX);
          targetRatioRef.current = r;
          setPreviewIdx(r * maxIdx);

          const dtMs = Math.max(8, e.timeStamp - dragStateRef.current.lastTime);
          const vel = (e.clientX - dragStateRef.current.lastX) / dtMs;
          const speed = Math.min(3.5, Math.abs(vel));
          const deform = Math.min(0.42, 0.045 + speed * 0.16);
          dragStateRef.current.body = deform;
          dragStateRef.current.lean = Math.sign(vel) * deform;
          dragStateRef.current.boost = 1 + Math.min(2.2, 0.55 + speed * 0.6);
          dragStateRef.current.lastX = e.clientX;
          dragStateRef.current.lastTime = e.timeStamp;
        }}
        onPointerUp={(e) => {
          if (dragStateRef.current.pointerId !== e.pointerId) return;
          dragStateRef.current.pointerId = -1;
          setDragging(false);
          const r = ratioFromClientX(e.clientX);
          commitIndex(r * maxIdx);
        }}
        onPointerCancel={() => {
          dragStateRef.current.pointerId = -1;
          setDragging(false);
          commitIndex(activeIdx);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            commitIndex(selectedIdx + 1);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            commitIndex(selectedIdx - 1);
          }
        }}
      >
        <div className="mova-effort-fill" aria-hidden="true">
          <canvas ref={canvasRef} />
        </div>
        <div className="mova-effort-dots" aria-hidden="true">
          {stops.map((s) => (
            <span key={s.value} />
          ))}
        </div>
        <span className="mova-effort-thumb" aria-hidden="true" />
      </div>

      <div
        className="mova-effort-stops"
        style={{ gridTemplateColumns: `repeat(${stops.length}, minmax(0, 1fr))` }}
      >
        {stops.map((stop, idx) => (
          <button
            key={stop.value}
            type="button"
            aria-pressed={idx === selectedIdx}
            onClick={(e) => {
              e.stopPropagation();
              commitIndex(idx);
            }}
          >
            {stop.short}
          </button>
        ))}
      </div>
    </div>
  );
};

interface MovaEffortModelOverlayProps {
  selectedModel: MovaModelOption;
  effort: EffortLevelId;
  glassConfig: LiquidGlassConfig;
  initialModelListOpen?: boolean;
  onSelectModel: (model: MovaModelOption) => void;
  onChangeEffort: (effort: EffortLevelId) => void;
  onClose: () => void;
}

/**
 * Centered Frosted-Band Model & Reasoning Effort Selector:
 * - Scales cleanly to the center of the iPhone screen
 * - Full-width frosted strip with vertical alpha fade (top & bottom transparent -> frosted center)
 * - Top: Clickable Model Name -> opens grouped Model Selection Popup (ChatGPT / Gemini / DeepSeek)
 * - Middle: Mova Desktop animated cosmic EffortSlider (Low / Med / High / XHi)
 */
export const MovaEffortModelOverlay: React.FC<MovaEffortModelOverlayProps> = ({
  selectedModel,
  effort,
  glassConfig,
  initialModelListOpen = false,
  onSelectModel,
  onChangeEffort,
  onClose,
}) => {
  const [pickerOpen, setPickerOpen] = useState(initialModelListOpen);

  useEffect(() => {
    setPickerOpen(initialModelListOpen);
  }, [initialModelListOpen]);

  const stops = useMemo(
    () => selectedModel.efforts.map((id) => EFFORT_CATALOG[id]),
    [selectedModel.efforts]
  );

  const groupedModels = useMemo(() => {
    const order: MovaModelOption['provider'][] = ['ChatGPT', 'Gemini', 'DeepSeek'];
    return order.map((provider) => ({
      provider,
      items: MOVA_MODELS.filter((m) => m.provider === provider),
    }));
  }, []);

  return (
    <div
      className="mova-center-model-overlay"
      onClick={() => {
        if (pickerOpen) {
          setPickerOpen(false);
        } else {
          onClose();
        }
      }}
    >
      {/* Full-width horizontal frosted glass band whose opacity gradually fades at top & bottom */}
      <div className="mova-frosted-band-shell" onClick={(e) => e.stopPropagation()}>
        <div className="mova-frosted-band-backdrop" aria-hidden="true" />

        <div className="mova-frosted-band-content">
          {/* Enlarged Centered Model Name (Click to pop open Model Picker) */}
          <button
            type="button"
            className={`mova-band-model-hero ${pickerOpen ? 'is-open' : ''}`}
            onClick={() => setPickerOpen((v) => !v)}
          >
            <strong>{selectedModel.name}</strong>
            <ChevronDownIcon
              size={18}
              color="rgba(235,235,245,0.68)"
              className="mova-band-chevron"
            />
          </button>

          {/* Mova Desktop Reasoning Effort Slider */}
          <MovaEffortSlider stops={stops} value={effort} onChange={onChangeEffort} />
        </div>
      </div>

      {/* Model Selection Popup (1:1 grouped providers from Mova Desktop Screenshot 2) */}
      {pickerOpen && (
        <div className="mova-model-picker-popup" onClick={(e) => e.stopPropagation()}>
          <IOSLiquidGlass
            width={286}
            height={392}
            cornerRadius={22}
            config={glassConfig}
            variant="menu"
            interactive={false}
            contentClassName="mova-model-popup-inner"
          >
            <button
              type="button"
              className="mova-model-popup-back"
              onClick={() => setPickerOpen(false)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14.5 6L8.5 12L14.5 18"
                  stroke="#A6A6AE"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>选择模型</span>
            </button>

            <div className="mova-model-popup-scroll">
              {groupedModels.map((group) => (
                <div key={group.provider} className="mova-model-popup-group">
                  <div className="mova-model-popup-group-title">{group.provider}</div>
                  {group.items.map((item) => {
                    const isSelected = item.id === selectedModel.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`mova-model-popup-item ${isSelected ? 'is-selected' : ''}`}
                        onClick={() => {
                          onSelectModel(item);
                          setPickerOpen(false);
                        }}
                      >
                        <span>{item.name}</span>
                        {isSelected && <CheckTinyIcon size={15} color="#FFFFFF" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </IOSLiquidGlass>
        </div>
      )}
    </div>
  );
};
