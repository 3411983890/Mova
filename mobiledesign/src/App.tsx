import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Hand,
  Maximize2,
  MousePointer2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ComponentSpecBoard } from './components/ComponentSpecBoard';
import { MovaPhoneScreen } from './components/MovaPhoneScreen';
import { DEFAULT_GLASS_CONFIG } from './data/movaData';
import type { KyantHighlightStyle, LiquidGlassConfig } from './types';

interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

interface ArtboardRect {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ARTBOARDS: Record<string, ArtboardRect> = {
  chatRow: { id: 'chatRow', label: 'ChatMova 组', x: 0, y: 0, w: 1888, h: 1030 },
  botRow: { id: 'botRow', label: 'MovaBot 组', x: 0, y: 1090, w: 1888, h: 1030 },
  all8: { id: 'all8', label: '八屏全景', x: 0, y: 0, w: 1888, h: 2120 },
  s4: { id: 's4', label: '04 系统设置', x: 1470, y: 96, w: 418, h: 930 },
  s7: { id: 's7', label: '07 通讯录', x: 980, y: 1186, w: 418, h: 930 },
  s8: { id: 's8', label: '08 Bot 设置', x: 1470, y: 1186, w: 418, h: 930 },
  spec: { id: 'spec', label: '09 规范', x: 0, y: 2210, w: 1398, h: 860 },
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.4;

export const App: React.FC = () => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<CameraState>({ x: 90, y: 64, zoom: 0.78 });
  const [isAnimatingCam, setIsAnimatingCam] = useState(false);
  const [activeTarget, setActiveTarget] = useState<string>('botRow');
  const [toolMode, setToolMode] = useState<'interact' | 'pan'>('interact');
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ cx: number; cy: number; ox: number; oy: number } | null>(null);

  const [glassConfig, setGlassConfig] = useState<LiquidGlassConfig>(DEFAULT_GLASS_CONFIG);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [resetSeed, setResetSeed] = useState(0);

  const frameRect = useCallback((rect: ArtboardRect, animate = true) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const padX = 88;
    const padTop = 86;
    const padBottom = 86;
    const availW = Math.max(240, vw - padX * 2);
    const availH = Math.max(240, vh - padTop - padBottom);
    const zoom = Math.max(MIN_ZOOM, Math.min(1.18, Math.min(availW / rect.w, availH / rect.h)));
    const x = (vw - rect.w * zoom) * 0.5 - rect.x * zoom;
    const y = padTop + (availH - rect.h * zoom) * 0.5 - rect.y * zoom;

    if (animate) {
      setIsAnimatingCam(true);
      window.setTimeout(() => setIsAnimatingCam(false), 340);
    }
    setActiveTarget(rect.id);
    setCamera({ x, y, zoom });
  }, []);

  useEffect(() => {
    frameRect(ARTBOARDS.botRow, false);
  }, [frameRect]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setSpacePressed(true);
      } else if (e.key === 'h' || e.key === 'H') {
        setToolMode('pan');
      } else if (e.key === 'v' || e.key === 'V') {
        setToolMode('interact');
      } else if (e.key === '0') {
        frameRect(ARTBOARDS.all8, true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [frameRect]);

  const zoomAtPoint = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const px = clientX !== undefined ? clientX - rect.left : rect.width * 0.5;
    const py = clientY !== undefined ? clientY - rect.top : rect.height * 0.5;

    setCamera((prev) => {
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * factor));
      const worldX = (px - prev.x) / prev.zoom;
      const worldY = (py - prev.y) / prev.zoom;
      return {
        zoom: nextZoom,
        x: px - worldX * nextZoom,
        y: py - worldY * nextZoom,
      };
    });
  }, []);

  const canForcePan = toolMode === 'pan' || spacePressed;

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onNativeWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      const insideScrollableUI = Boolean(
        target?.closest('.mova-iphone-frame, .kyant-inspector-panel')
      );
      if (insideScrollableUI && !e.ctrlKey && !e.metaKey && !canForcePan) {
        return;
      }
      e.preventDefault();
      const zoomFactor = Math.exp(-e.deltaY * 0.0014);
      zoomAtPoint(zoomFactor, e.clientX, e.clientY);
    };
    vp.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onNativeWheel);
  }, [zoomAtPoint, canForcePan]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const insideNode = Boolean(target.closest('.canvas-interactive-node'));
    const insideHud = Boolean(target.closest('.canvas-hud'));
    if (insideHud) return;

    if (e.button === 1 || canForcePan || (e.button === 0 && !insideNode)) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { cx: e.clientX, cy: e.clientY, ox: camera.x, oy: camera.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning || !panStart.current) return;
    const dx = e.clientX - panStart.current.cx;
    const dy = e.clientY - panStart.current.cy;
    setCamera((prev) => ({
      ...prev,
      x: panStart.current!.ox + dx,
      y: panStart.current!.oy + dy,
    }));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    setIsPanning(false);
    panStart.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore if already released
    }
  };

  const gridSize = Math.max(12, 24 * camera.zoom);

  return (
    <div
      ref={viewportRef}
      className={`infinite-canvas-viewport ${canForcePan ? 'is-hand-mode' : ''} ${isPanning ? 'is-panning' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
    >
      {/* ==================== TOP FLOATING STUDIO HUD ==================== */}
      <header className="canvas-hud canvas-hud--top">
        <div className="hud-brand-pill">
          <span className="hud-brand-dot" />
          <strong>Mova Mobile</strong>
          <span className="hud-brand-sep">/</span>
          <span className="hud-brand-sub">iOS 26 · Kyant Liquid Glass</span>
        </div>

        <nav className="hud-nav-tabs" aria-label="画框快速定位">
          {Object.values(ARTBOARDS).map((ab) => (
            <button
              key={ab.id}
              type="button"
              className={`hud-tab-btn ${activeTarget === ab.id ? 'is-active' : ''}`}
              onClick={() => frameRect(ab, true)}
            >
              {ab.label}
            </button>
          ))}
        </nav>

        <div className="hud-right-actions">
          <button
            type="button"
            className={`hud-action-pill ${glassConfig.ambientGlow ? 'is-active' : ''}`}
            onClick={() =>
              setGlassConfig((prev) => ({ ...prev, ambientGlow: !prev.ambientGlow }))
            }
            title="开启环境色斑以更直观测试纯黑屏幕上的玻璃透镜折射"
          >
            <Sparkles size={15} />
            <span>折射底光</span>
          </button>

          <button
            type="button"
            className={`hud-action-pill ${inspectorOpen ? 'is-active' : ''}`}
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <SlidersHorizontal size={15} />
            <span>液态玻璃参数</span>
          </button>
        </div>
      </header>

      {/* ==================== KYANT LIQUID GLASS PARAMETER INSPECTOR ==================== */}
      {inspectorOpen && (
        <aside className="canvas-hud kyant-inspector-panel" onWheel={(e) => e.stopPropagation()}>
          <div className="inspector-head">
            <div>
              <strong>Kyant Backdrop 光学参数</strong>
              <span>实时驱动全局 SDF 透镜与高光着色器</span>
            </div>
            <button
              type="button"
              className="inspector-reset-link"
              onClick={() => setGlassConfig(DEFAULT_GLASS_CONFIG)}
            >
              恢复默认
            </button>
          </div>

          <label className="inspector-row">
            <div className="inspector-label-line">
              <span>弯月面厚度 (refractionHeight)</span>
              <code>{glassConfig.refractionHeight} pt</code>
            </div>
            <input
              type="range"
              min={4}
              max={24}
              step={1}
              value={glassConfig.refractionHeight}
              onChange={(e) =>
                setGlassConfig((p) => ({ ...p, refractionHeight: Number(e.target.value) }))
              }
            />
          </label>

          <label className="inspector-row">
            <div className="inspector-label-line">
              <span>边缘折射位移 (refractionAmount)</span>
              <code>{glassConfig.refractionAmount} pt</code>
            </div>
            <input
              type="range"
              min={0}
              max={48}
              step={1}
              value={glassConfig.refractionAmount}
              onChange={(e) =>
                setGlassConfig((p) => ({ ...p, refractionAmount: Number(e.target.value) }))
              }
            />
          </label>

          <label className="inspector-row">
            <div className="inspector-label-line">
              <span>磨砂模糊半径 (blurRadius)</span>
              <code>{glassConfig.blurRadius} px</code>
            </div>
            <input
              type="range"
              min={0}
              max={22}
              step={0.5}
              value={glassConfig.blurRadius}
              onChange={(e) =>
                setGlassConfig((p) => ({ ...p, blurRadius: Number(e.target.value) }))
              }
            />
          </label>

          <label className="inspector-row">
            <div className="inspector-label-line">
              <span>鲜艳度增益 (vibrancy)</span>
              <code>{glassConfig.vibrancy}%</code>
            </div>
            <input
              type="range"
              min={100}
              max={240}
              step={5}
              value={glassConfig.vibrancy}
              onChange={(e) =>
                setGlassConfig((p) => ({ ...p, vibrancy: Number(e.target.value) }))
              }
            />
          </label>

          <label className="inspector-row">
            <div className="inspector-label-line">
              <span>光谱色散 (chromaticAberration)</span>
              <code>{glassConfig.chromaticAberration.toFixed(2)}</code>
            </div>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={glassConfig.chromaticAberration}
              onChange={(e) =>
                setGlassConfig((p) => ({ ...p, chromaticAberration: Number(e.target.value) }))
              }
            />
          </label>

          <label className="inspector-row">
            <div className="inspector-label-line">
              <span>边缘高光入射角 (angle)</span>
              <code>{glassConfig.highlightAngle}°</code>
            </div>
            <input
              type="range"
              min={0}
              max={180}
              step={5}
              value={glassConfig.highlightAngle}
              onChange={(e) =>
                setGlassConfig((p) => ({ ...p, highlightAngle: Number(e.target.value) }))
              }
            />
          </label>

          <div className="inspector-mode-group">
            <span>高光模式 (HighlightStyle)</span>
            <div className="inspector-segmented">
              {(['default', 'ambient', 'plain'] as KyantHighlightStyle[]).map((st) => (
                <button
                  key={st}
                  type="button"
                  className={glassConfig.highlightStyle === st ? 'is-active' : ''}
                  onClick={() => setGlassConfig((p) => ({ ...p, highlightStyle: st }))}
                >
                  {st === 'default' ? 'Default 双弧' : st === 'ambient' ? 'Ambient 单侧' : 'Plain 均匀'}
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}

      {/* ==================== BOTTOM FLOATING CANVAS TOOLBAR ==================== */}
      <footer className="canvas-hud canvas-hud--bottom">
        <div className="hud-tool-switcher">
          <button
            type="button"
            className={`hud-icon-btn ${toolMode === 'interact' && !spacePressed ? 'is-active' : ''}`}
            onClick={() => setToolMode('interact')}
            title="交互模式 (V)：可在手机内滚动、输入、点开抽屉和复制代码"
          >
            <MousePointer2 size={16} />
            <span>操作 (V)</span>
          </button>
          <button
            type="button"
            className={`hud-icon-btn ${toolMode === 'pan' || spacePressed ? 'is-active' : ''}`}
            onClick={() => setToolMode('pan')}
            title="抓手平移模式 (H / 按住空格拖拽)"
          >
            <Hand size={16} />
            <span>抓手 (H)</span>
          </button>
        </div>

        <div className="hud-divider" />

        <div className="hud-zoom-controls">
          <button type="button" className="hud-round-btn" onClick={() => zoomAtPoint(1 / 1.2)} title="缩小">
            <ZoomOut size={15} />
          </button>
          <button
            type="button"
            className="hud-zoom-readout"
            onClick={() => setCamera((p) => ({ ...p, zoom: 1 }))}
            title="点击设为 100% 像素比例"
          >
            {Math.round(camera.zoom * 100)}%
          </button>
          <button type="button" className="hud-round-btn" onClick={() => zoomAtPoint(1.2)} title="放大">
            <ZoomIn size={15} />
          </button>
          <button
            type="button"
            className="hud-round-btn"
            onClick={() => frameRect(ARTBOARDS.all8, true)}
            title="适应八屏全景 (0)"
          >
            <Maximize2 size={15} />
          </button>
        </div>

        <div className="hud-divider" />

        <button
          type="button"
          className="hud-reset-btn"
          onClick={() => setResetSeed((s) => s + 1)}
          title="将三台手机恢复到参考图初始定格状态"
        >
          <RotateCcw size={14} />
          <span>重置画框状态</span>
        </button>
      </footer>

      {/* ==================== INFINITE WORLD STAGE ==================== */}
      <div
        className={`infinite-world-stage ${isAnimatingCam ? 'is-animating' : ''}`}
        style={{
          transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})`,
        }}
      >
        {/* Row 1 Section Header: ChatMova & System Settings */}
        <div className="world-board-header" style={{ left: 0, top: 0, width: 1888 }}>
          <div className="world-board-title-row">
            <h2>Mova Mobile · ChatMova 与系统设置</h2>
            <span className="world-board-meta">
              iPhone 16 Pro (402 × 874 pt) · iOS 26 HIG · Kyant0 Backdrop Liquid Glass
            </span>
          </div>
          <p>
            纯黑 OLED 画布 · 统一分体式输入栏（单蓝色声波球）· 顶栏精简单「⋯」按钮 · 点击侧栏个人头像直达系统设置页
          </p>
        </div>

        {/* Artboard 01: Main Conversation & Split Composer */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 0, top: 96, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">01</span>
            <strong>对话流 · 分体式输入栏与单「⋯」顶栏</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="chat" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 02: Focused Two-Row Composer & iOS 26 Keyboard */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 490, top: 96, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">02</span>
            <strong>聚焦输入 · 双层工具栏与 iOS 26 键盘</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="keyboard" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 03: Navigation Sidebar Drawer */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 980, top: 96, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">03</span>
            <strong>侧边抽屉 · 三模式切换与项目文件夹</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="drawer" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 04: System Settings Page (Image 6) */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 1470, top: 96, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">04</span>
            <strong>系统设置 · 账号、保管库、Bot 权限与设备</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="settings" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Row 2 Section Header: MovaBot Full Flow */}
        <div className="world-board-header" style={{ left: 0, top: 1090, width: 1888 }}>
          <div className="world-board-title-row">
            <h2>MovaBot · 多智能体聊天、通讯录侧栏与单 Bot 设置</h2>
            <span className="world-board-meta">OLED Dark · iOS 26 Grouped Cards · Kyant Liquid Glass</span>
          </div>
          <p>
            左上角统一菜单图标打开 Bot 通讯录侧栏；点击通讯录任意 Bot 或左下角蓝色「+」进入 Bot 设置页，点击头像进入系统设置
          </p>
        </div>

        {/* Artboard 05: MovaBot Main List View (No huge hero, unified Menu icon) */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 0, top: 1186, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">05</span>
            <strong>MovaBot 主视图 · 统一菜单顶栏与消息列表</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="bot-list" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 06: MovaBot Conversation Detail View */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 490, top: 1186, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">06</span>
            <strong>MovaBot 聊天页 · 派单出片与单声波输入栏</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="bot-chat" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 07: MovaBot Contacts Sidebar + Blue "+" Circle */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 980, top: 1186, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">07</span>
            <strong>MovaBot 通讯录侧栏 · 蓝色「+」与头像入口</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="bot-contacts" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 08: Individual Bot Settings Page */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 1470, top: 1186, width: 418 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">08</span>
            <strong>单个 Bot 设置页 · 人设、模型能力与免打扰</strong>
            <span className="artboard-dim">402 × 874</span>
          </div>
          <MovaPhoneScreen preset="bot-settings" resetSeed={resetSeed} glassConfig={glassConfig} />
        </div>

        {/* Artboard 09: iOS 26 Liquid Glass Component & Typography Spec Sheet */}
        <div
          className={`world-artboard canvas-interactive-node ${canForcePan ? 'pan-passthrough' : ''}`}
          style={{ left: 0, top: 2210, width: 1398 }}
        >
          <div className="artboard-caption">
            <span className="artboard-index">09</span>
            <strong>基础组件规范 · Kyant 透镜光学测试台与 iOS 26 排版变量</strong>
            <span className="artboard-dim">Design System</span>
          </div>
          <ComponentSpecBoard glassConfig={glassConfig} />
        </div>
      </div>
    </div>
  );
};
