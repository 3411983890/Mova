// Rounded Keyline icons shared by the static shell and dynamically-created rows.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Archive, ArrowLeft, ArrowRight, ArrowUpRight, Bell, Bin, Box, Brain, Camera, ChartLine, Check, ChevronDown, CirclePlus, Cloud,
  Contacts, Copy, CursorClick, File, FileCode, FileImage, FileText, Folder, FolderOpen, FolderPlus, Gauge, Ghost, Globe, Key, Laptop, List, Message, MessageDot, MessageSquarePlus, Minus,
  MoreHorizontal, NotebookPen, PanelLeft, PanelRight, Pause, Pin, Play, Plug, Plus, RefreshCw, Search, Settings, ShieldCheck, Square,
  Puzzle, Target, Undo, X, Zap,
} from '@keyline-icons/react';
import { House as HouseFill } from '@keyline-icons/react/fill';

const icons = {
  'arrow-left': ArrowLeft, 'arrow-right': ArrowRight, 'arrow-up-right': ArrowUpRight,
  'sidebar-simple': PanelLeft, 'panel-left': PanelLeft, 'panel-right': PanelRight,
  refresh: RefreshCw, 'arrow-clockwise': RefreshCw, globe: Globe, copy: Copy,
  minus: Minus, square: Square, x: X, house: HouseFill,
  'chat-circle-dots': MessageDot, 'address-book': Contacts, aperture: Camera,
  'dots-three': MoreHorizontal, 'caret-down': ChevronDown, check: Check,
  bell: Bell, 'magnifying-glass': Search, 'note-pencil': NotebookPen,
  'folder-plus': FolderPlus, 'folder-simple': Folder, folder: Folder, 'folder-open': FolderOpen, brain: Brain,
  laptop: Laptop, cloud: Cloud, 'chat-circle': Message, 'arrow-u-up-left': Undo,
  archive: Archive, puzzle: Puzzle, plugs: Plug,
  gear: Settings, gauge: Gauge, 'chart-line': ChartLine, cube: Box, plus: Plus, trash: Bin,
  pin: Pin, list: List, 'message-plus': MessageSquarePlus, 'circle-plus': CirclePlus,
  'shield-check': ShieldCheck, key: Key, lightning: Zap, zap: Zap,
  // 右侧面板「选择页面元素」按钮（方案 §3.2）：闪电换成光标点选。
  'cursor-click': CursorClick,
  // 右侧文件视图：位置图标与目录行图标（方案 §3.3 / §3.7）。
  file: File, 'file-text': FileText, 'file-code': FileCode, 'file-image': FileImage,
  // 「⋯」左侧目标 / 计划：入口图标、暂停与继续、目标区。
  target: Target, pause: Pause, play: Play,
  // 「⋯」右侧临时聊天入口：不保存、不读取记忆的「隐身」会话。
  ghost: Ghost,
};
const cache = new Map();

/** Registered names, so tests can prove the shell only uses mapped icons. */
export const iconNames = Object.freeze(Object.keys(icons));

export function icon(name) {
  const component = icons[name];
  if (!component) throw new Error(`Unknown icon: ${name}`);
  if (!cache.has(name)) {
    const wrapper = document.createElement('i');
    wrapper.className = 'keyline-icon';
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.innerHTML = renderToStaticMarkup(React.createElement(component, { size: '1em', 'aria-hidden': true }));
    cache.set(name, wrapper);
  }
  return cache.get(name).cloneNode(true);
}
/**
 * One unmapped icon must not abort the whole boot: the shell, the settings
 * listeners and the workspace restore all run after this call.
 */
export function replaceStaticIcons(root = document) {
  root.querySelectorAll('i.ph, i.ph-fill').forEach(element => {
    const name = [...element.classList].find(className => className.startsWith('ph-') && className !== 'ph-fill')?.slice(3);
    if (!name) return;
    try {
      const replacement = icon(name);
      // Keep the host's own classes (positioning, colour) and attributes: the
      // shell styles icons through classes like .project-name-folder-icon.
      if (replacement.classList?.add) {
        for (const className of element.classList ?? []) {
          if (className === 'ph' || className === 'ph-fill' || className === `ph-${name}`) continue;
          replacement.classList.add(className);
        }
      }
      for (const { name: attribute, value } of element.attributes ?? []) {
        if (attribute === 'class' || replacement.hasAttribute?.(attribute)) continue;
        replacement.setAttribute(attribute, value);
      }
      element.replaceWith(replacement);
    } catch (error) {
      console.warn(`[icons] ${error.message}`);
    }
  });
}
