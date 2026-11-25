import React, { useState } from 'react';
import type { LiquidGlassConfig } from '../types';
import { CheckTinyIcon, EllipsisRowIcon } from './IOSIcons';
import { IOSLiquidGlass } from './IOSLiquidGlass';

interface PhotoTileData {
  id: string;
  label: string;
  render: () => React.ReactNode;
}

/** High-craft SVG/gradient gallery thumbnails matching editorial iOS camera roll aesthetics */
const GALLERY_TILES: PhotoTileData[] = [
  {
    id: 'photo-ui-shot',
    label: 'Mova 界面截图',
    render: () => (
      <div className="tile-art tile-art--uishot">
        <div className="tile-ui-bar" />
        <div className="tile-ui-card">
          <span />
          <span />
          <span />
        </div>
        <div className="tile-ui-pill" />
      </div>
    ),
  },
  {
    id: 'photo-poster-red',
    label: '活动海报 11.27',
    render: () => (
      <div className="tile-art tile-art--crimson">
        <span className="tile-crimson-head">MOVA NIGHT</span>
        <div className="tile-crimson-sil" />
        <div className="tile-crimson-foot">
          <strong>11.27</strong>
          <small>9pm–3am</small>
        </div>
      </div>
    ),
  },
  {
    id: 'photo-typo-light',
    label: '字体排版稿',
    render: () => (
      <div className="tile-art tile-art--ivory">
        <strong>11.27</strong>
        <span>9pm–3am</span>
      </div>
    ),
  },
  {
    id: 'photo-warm-lounge',
    label: '暖光插画',
    render: () => (
      <div className="tile-art tile-art--lounge">
        <div className="tile-lounge-lamp" />
        <div className="tile-lounge-glow" />
        <div className="tile-lounge-table" />
      </div>
    ),
  },
  {
    id: 'photo-sunset',
    label: '落日海岸',
    render: () => (
      <div className="tile-art tile-art--sunset">
        <span className="tile-sun-disc" />
        <span className="tile-sun-horizon" />
      </div>
    ),
  },
  {
    id: 'photo-neon-city',
    label: '城市夜景',
    render: () => (
      <div className="tile-art tile-art--city">
        <div className="tile-city-towers">
          <i style={{ height: '58%' }} />
          <i style={{ height: '82%' }} />
          <i style={{ height: '46%' }} />
          <i style={{ height: '74%' }} />
          <i style={{ height: '52%' }} />
        </div>
      </div>
    ),
  },
  {
    id: 'photo-keyboard-3d',
    label: '铝壳白键渲染',
    render: () => (
      <div className="tile-art tile-art--kb3d">
        <div className="tile-kb-deck" />
        <div className="tile-kb-bezel" />
      </div>
    ),
  },
  {
    id: 'photo-qr-card',
    label: '共享配对码',
    render: () => (
      <div className="tile-art tile-art--qr">
        <svg viewBox="0 0 64 64" width="66%" height="66%" fill="none">
          <rect x="6" y="6" width="18" height="18" rx="3" stroke="#E5E5EA" strokeWidth="3.5" />
          <rect x="12" y="12" width="6" height="6" fill="#E5E5EA" />
          <rect x="40" y="6" width="18" height="18" rx="3" stroke="#E5E5EA" strokeWidth="3.5" />
          <rect x="46" y="12" width="6" height="6" fill="#E5E5EA" />
          <rect x="6" y="40" width="18" height="18" rx="3" stroke="#E5E5EA" strokeWidth="3.5" />
          <rect x="12" y="46" width="6" height="6" fill="#E5E5EA" />
          <rect x="30" y="10" width="5" height="5" fill="#E5E5EA" />
          <rect x="30" y="20" width="5" height="5" fill="#E5E5EA" />
          <rect x="10" y="30" width="5" height="5" fill="#E5E5EA" />
          <rect x="20" y="30" width="10" height="5" fill="#E5E5EA" />
          <rect x="36" y="30" width="8" height="8" rx="2" fill="#3262FF" />
          <rect x="48" y="30" width="10" height="5" fill="#E5E5EA" />
          <rect x="30" y="42" width="6" height="14" fill="#E5E5EA" />
          <rect x="42" y="42" width="14" height="5" fill="#E5E5EA" />
          <rect x="46" y="51" width="10" height="5" fill="#E5E5EA" />
        </svg>
      </div>
    ),
  },
  {
    id: 'photo-alpine',
    label: '雪山晨雾',
    render: () => (
      <div className="tile-art tile-art--alpine">
        <svg viewBox="0 0 120 120" width="100%" height="100%" preserveAspectRatio="none">
          <defs>
            <linearGradient id="alpSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1e3a5f" />
              <stop offset="100%" stopColor="#6fa0c7" />
            </linearGradient>
          </defs>
          <rect width="120" height="120" fill="url(#alpSky)" />
          <polygon points="0,120 38,54 78,120" fill="#2a3e54" />
          <polygon points="34,120 82,42 120,120" fill="#1b2b3d" />
          <polygon points="82,42 71,61 81,57 90,63" fill="#e8f1f8" />
        </svg>
      </div>
    ),
  },
  {
    id: 'photo-glass-orb',
    label: '液态玻璃材质',
    render: () => (
      <div className="tile-art tile-art--glassorb">
        <span className="tile-orb-ring" />
      </div>
    ),
  },
  {
    id: 'photo-minimal-desk',
    label: '桌面工作区',
    render: () => (
      <div className="tile-art tile-art--desk">
        <div className="tile-desk-screen" />
        <div className="tile-desk-base" />
      </div>
    ),
  },
];

/** Realistic Studio Camera Viewfinder Backdrop */
const CameraViewfinderScene: React.FC<{ zoomLabel: string; frontCamera: boolean }> = ({
  zoomLabel,
  frontCamera,
}) => (
  <div className={`ios-cam-scene ${frontCamera ? 'is-front' : ''}`}>
    <div className="ios-cam-lens-bg" />
    <div className="ios-cam-desk-surface" />
    <div className="ios-cam-highlight-arc" />
    {/* Subtle Rule-of-Thirds Grid */}
    <div className="ios-cam-grid" aria-hidden="true">
      <span className="cam-grid-v cam-grid-v--1" />
      <span className="cam-grid-v cam-grid-v--2" />
      <span className="cam-grid-h cam-grid-h--1" />
      <span className="cam-grid-h cam-grid-h--2" />
    </div>
    {/* Subtle iOS Auto-Focus Reticle */}
    <div className="ios-cam-reticle" aria-hidden="true" />
    <div className="ios-cam-zoom-badge">{zoomLabel}</div>
  </div>
);

interface IOSPhotoCameraSheetProps {
  glassConfig: LiquidGlassConfig;
  mode: 'photos' | 'camera';
  onModeChange: (next: 'photos' | 'camera') => void;
  onClose: () => void;
  onAttachPhoto: (label: string) => void;
  onToast: (msg: string) => void;
}

export const IOSPhotoCameraSheet: React.FC<IOSPhotoCameraSheetProps> = ({
  glassConfig,
  mode,
  onModeChange,
  onClose,
  onAttachPhoto,
  onToast,
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [shutterFlash, setShutterFlash] = useState(false);
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const [zoomStep, setZoomStep] = useState<'0.5×' | '1×' | '2×'>('1×');
  const [frontCamera, setFrontCamera] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(0, 4)
    );
  };

  const handleCapture = () => {
    setShutterFlash(true);
    window.setTimeout(() => {
      setShutterFlash(false);
      onAttachPhoto('相机实时拍摄照片');
      onClose();
    }, 240);
  };

  return (
    <div className="ios-media-overlay" onClick={onClose}>
      <div
        className={`ios-media-sheet ${mode === 'camera' ? 'is-camera' : 'is-photos'}`}
        onClick={(e) => {
          e.stopPropagation();
          setCamMenuOpen(false);
        }}
      >
        {mode === 'photos' ? (
          /* ==================== IMAGE 1: PHOTO PICKER GRID SHEET ==================== */
          <>
            <div className="ios-photo-grid-scroll">
              <div className="ios-photo-grid">
                {/* Tile 1: Live Camera Tile (Click -> Morphs to Image 2 Camera Sheet) */}
                <button
                  type="button"
                  className="ios-photo-tile ios-photo-tile--camera"
                  onClick={() => onModeChange('camera')}
                  aria-label="打开相机拍照"
                >
                  <div className="ios-cam-tile-preview">
                    <div className="ios-cam-tile-blur" />
                    <div className="ios-cam-tile-badge">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M4 8.5C4 7.4 4.9 6.5 6 6.5H8.1L9.4 4.6C9.7 4.2 10.2 4 10.7 4H13.3C13.8 4 14.3 4.2 14.6 4.6L15.9 6.5H18C19.1 6.5 20 7.4 20 8.5V17.5C20 18.6 19.1 19.5 18 19.5H6C4.9 19.5 4 18.6 4 17.5V8.5Z"
                          stroke="#FFFFFF"
                          strokeWidth="1.75"
                          strokeLinejoin="round"
                        />
                        <circle cx="12" cy="12.8" r="3.4" stroke="#FFFFFF" strokeWidth="1.75" />
                      </svg>
                      <span>相机</span>
                    </div>
                  </div>
                </button>

                {/* Tiles 2..12: Photo Library Grid */}
                {GALLERY_TILES.map((tile) => {
                  const selIdx = selectedIds.indexOf(tile.id);
                  const isSelected = selIdx !== -1;
                  return (
                    <button
                      key={tile.id}
                      type="button"
                      className={`ios-photo-tile ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => toggleSelect(tile.id)}
                      aria-label={tile.label}
                    >
                      {tile.render()}
                      {isSelected && (
                        <span className="ios-photo-check-badge">
                          <CheckTinyIcon size={12} color="#FFFFFF" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Bottom Floating Liquid Glass Controls (Image 1: "<" Left + "所有照片" Right) */}
            <div className="ios-media-sheet-bar">
              <IOSLiquidGlass
                width={44}
                height={44}
                cornerRadius={22}
                config={glassConfig}
                variant="bar"
                onClick={onClose}
                title="关闭相册"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M14.5 6L8.5 12L14.5 18"
                    stroke="#FFFFFF"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </IOSLiquidGlass>

              {selectedIds.length > 0 ? (
                <IOSLiquidGlass
                  width={110}
                  height={42}
                  cornerRadius={21}
                  config={glassConfig}
                  variant="blue"
                  onClick={() => {
                    onAttachPhoto(`已添加 ${selectedIds.length} 张相册图片`);
                    setSelectedIds([]);
                    onClose();
                  }}
                  contentClassName="ios-media-pill-label"
                >
                  <span>添加 ({selectedIds.length})</span>
                </IOSLiquidGlass>
              ) : (
                <IOSLiquidGlass
                  width={106}
                  height={42}
                  cornerRadius={21}
                  config={glassConfig}
                  variant="bar"
                  onClick={() => onToast('正在浏览系统相册 · 所有照片')}
                  contentClassName="ios-media-pill-label"
                >
                  <span>所有照片</span>
                </IOSLiquidGlass>
              )}
            </div>
          </>
        ) : (
          /* ==================== IMAGE 2: LIVE CAMERA SHEET ==================== */
          <>
            <CameraViewfinderScene zoomLabel={zoomStep} frontCamera={frontCamera} />

            {shutterFlash && <div className="ios-cam-flash" aria-hidden="true" />}

            {/* Optional Camera More Menu */}
            {camMenuOpen && (
              <div className="ios-cam-more-popover" onClick={(e) => e.stopPropagation()}>
                <IOSLiquidGlass
                  width={176}
                  height={128}
                  cornerRadius={20}
                  config={glassConfig}
                  variant="menu"
                  interactive={false}
                  contentClassName="mova-popover-list"
                >
                  <button
                    type="button"
                    onClick={() => {
                      const next = zoomStep === '1×' ? '2×' : zoomStep === '2×' ? '0.5×' : '1×';
                      setZoomStep(next);
                      setCamMenuOpen(false);
                    }}
                  >
                    <span>切换焦距</span>
                    <small>{zoomStep}</small>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFrontCamera((v) => !v);
                      setCamMenuOpen(false);
                      onToast(frontCamera ? '已切回后置主摄' : '已切换至前置镜头');
                    }}
                  >
                    <span>翻转镜头</span>
                    <small>{frontCamera ? '前置' : '后置'}</small>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCamMenuOpen(false);
                      onToast('已开启文档与代码扫描模式');
                    }}
                  >
                    <span>扫描文稿</span>
                    <small>OCR</small>
                  </button>
                </IOSLiquidGlass>
              </div>
            )}

            {/* Bottom Floating Camera Controls (Image 2: "<" Left · White Ring Shutter Center · "⋯" + Blue Dot Right) */}
            <div className="ios-media-sheet-bar ios-media-sheet-bar--camera">
              <IOSLiquidGlass
                width={44}
                height={44}
                cornerRadius={22}
                config={glassConfig}
                variant="bar"
                onClick={() => onModeChange('photos')}
                title="返回相册选择"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M14.5 6L8.5 12L14.5 18"
                    stroke="#FFFFFF"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </IOSLiquidGlass>

              <button
                type="button"
                className="ios-cam-shutter-btn"
                onClick={handleCapture}
                aria-label="拍摄照片"
              >
                <span className="ios-cam-shutter-inner" />
              </button>

              <div className="ios-cam-more-wrap">
                <IOSLiquidGlass
                  width={44}
                  height={44}
                  cornerRadius={22}
                  config={glassConfig}
                  variant="bar"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCamMenuOpen((v) => !v);
                  }}
                  title="相机选项"
                >
                  <EllipsisRowIcon size={19} color="#FFFFFF" />
                </IOSLiquidGlass>
                <span className="ios-cam-more-dot" aria-hidden="true" />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
