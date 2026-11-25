// Rounded Keyline icons shared by the static shell and dynamically-created rows.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Archive, ArrowLeft, ArrowRight, ArrowUpRight, Bell, Bin, Box, Brain, Camera, ChartLine, Check, ChevronDown, CirclePlus, Cloud,
  Contacts, Copy, Folder, FolderOpen, FolderPlus, Gauge, Globe, House, Laptop, List, Message,
  MessageDot, MessageSquarePlus, Minus, MoreHorizontal, NotebookPen, PanelLeft, PanelRight, Pin, Plus, RefreshCw, Search,
  Settings, ShieldCheck, Square, Puzzle, Undo, X, Zap, Target, Pause, Play,
} from '@keyline-icons/react';
import { House as HouseFill } from '@keyline-icons/react/fill';

const icons = {
  'arrow-left': ArrowLeft, 'arrow-right': ArrowRight, 'arrow-up-right': ArrowUpRight,
  'sidebar-simple': PanelLeft, 'panel-left': PanelLeft, 'panel-right': PanelRight, refresh: RefreshCw, globe: Globe, copy: Copy,
  minus: Minus, square: Square, x: X, house: HouseFill,
  'chat-circle-dots': MessageDot, 'address-book': Contacts, aperture: Camera,
  'dots-three': MoreHorizontal, 'caret-down': ChevronDown, check: Check,
  bell: Bell, 'magnifying-glass': Search, 'note-pencil': NotebookPen,
  'folder-plus': FolderPlus, 'folder-simple': Folder, folder: Folder, 'folder-open': FolderOpen, brain: Brain,
  laptop: Laptop, cloud: Cloud, 'chat-circle': Message, 'arrow-u-up-left': Undo,
  archive: Archive, puzzle: Puzzle,
  gear: Settings, gauge: Gauge, 'chart-line': ChartLine, cube: Box, plus: Plus, trash: Bin,
  pin: Pin, list: List, 'message-plus': MessageSquarePlus, 'circle-plus': CirclePlus,
  'shield-check': ShieldCheck, zap: Zap, target: Target, pause: Pause, play: Play,
};
const cache = new Map();
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
export function replaceStaticIcons(root = document) {
  root.querySelectorAll('i.ph, i.ph-fill').forEach(element => {
    const name = [...element.classList].find(className => className.startsWith('ph-') && className !== 'ph-fill')?.slice(3);
    if (!name) return;
    const replacement = icon(name);
    for (const className of element.classList) replacement.classList.add(className);
    element.replaceWith(replacement);
  });
}
