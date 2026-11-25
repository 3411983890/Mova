import type { DesktopModel, DesktopProjects } from '../services/desktop-model-client';

declare global {
type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

interface DesktopWindow {
  act: (action: WindowAction) => Promise<void>;
  clipboard: { writeText(text: string): Promise<boolean> };
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  model: DesktopModel;
  projects: DesktopProjects;
}

interface Window {
  movaDesktop?: DesktopWindow;
}
}
