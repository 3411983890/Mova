import type {
  DesktopApprovals, DesktopChangesClient, DesktopFilesClient, DesktopModel, DesktopPermissions, DesktopProjects,
} from '../services/desktop-model-client';

declare global {
type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

interface DesktopWindow {
  act: (action: WindowAction) => Promise<void>;
  clipboard: { writeText(text: string): Promise<boolean> };
  cloud?: {
    probe(address: string): Promise<{ ok: true; protocolVersion: number; capabilities?: string[] } | { ok: false; code: string; message: string }>;
    device(action: string, address: string, input?: object): Promise<{ ok: true; value: unknown } | { ok: false; message: string; status?: number; code?: string }>;
  };
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  model: DesktopModel;
  projects: DesktopProjects;
  permissions?: DesktopPermissions;
  approvals?: DesktopApprovals;
  changes?: DesktopChangesClient;
  files?: DesktopFilesClient;
  bots?: Record<string, (...args: any[]) => any>;
  miniApps?: Record<string, (...args: any[]) => any>;
}

interface Window {
  movaDesktop?: DesktopWindow;
}
}
