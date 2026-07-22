export {};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          preload?: string;
          partition?: string;
          allowpopups?: string;
          nodeintegration?: string;
          webpreferences?: string;
          useragent?: string;
        },
        HTMLElement
      >;
    }
  }

  interface OpenSwarmUpdateInfo {
    version: string;
    releaseDate?: string;
    releaseNotes?: string | Array<{ version: string; note: string }>;
  }

  interface OpenSwarmDownloadProgress {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  }

  interface OpenSwarmAPI {
    getBackendPort: () => number;
    getWebviewPreloadPath: () => string;
    getAppVersion: () => Promise<string>;
    setWindowButtonsVisible?: (visible: boolean) => Promise<void>;
    getBuildInfo: () => Promise<{ sha: string; shortSha: string; builtAt: string | null; channel: string }>;
    getUpdateStatus: () => Promise<{ status: string; info: any; error: string | null }>;
    getCrashRecoveryInfo?: () => Promise<{ ts: number; parent_pid: number; uptime_ms: number } | null>;
    checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>;
    downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
    installUpdate: () => Promise<void>;
    onUpdateAvailable: (cb: (info: OpenSwarmUpdateInfo) => void) => () => void;
    onUpdateNotAvailable: (cb: (info: OpenSwarmUpdateInfo) => void) => () => void;
    onDownloadProgress: (cb: (progress: OpenSwarmDownloadProgress) => void) => () => void;
    onUpdateDownloaded: (cb: (info: OpenSwarmUpdateInfo) => void) => () => void;
    onUpdateError: (cb: (message: string) => void) => () => void;
    onWebviewNewWindow: (cb: (url: string, webContentsId: number, disposition?: string) => void) => () => void;
    onReloadShortcut?: (cb: () => void) => () => void;
    onBrowserShortcut?: (cb: (payload: { action: string; webContentsId: number }) => void) => () => void;
    openExternal: (url: string) => Promise<void>;
    harvestUsage?: (provider: string) => Promise<{ ok: boolean; total: number; titles: string[]; memories: string[] } | null>;
    hardReset?: () => Promise<void>;
    clearBrowserData?: () => Promise<{ ok: boolean }>;
    voiceWarmup?: () => Promise<{ ok: boolean; error?: string }>;
    voiceTranscribe?: (wav: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
    voiceInject?: (text: string) => Promise<{ ok: boolean; pasted?: boolean; error?: string }>;
    onVoiceToggle?: (cb: () => void) => () => void;
    onAuthUrl?: (cb: (url: string) => void) => () => void;
    onOauthClaim?: (cb: (url: string) => void) => () => void;
  }

  interface Window {
    __OPENSWARM_PORT__: number;
    openswarm: OpenSwarmAPI;
  }
}
