export {};

// One entry in the dictation model catalog, as the main process reports it.
export interface VoiceModel {
  id: string;
  label: string;
  note: string;
  sizeMb: number;
  installed: boolean;
}

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

  // A finished-run notification handed to the OS by the Electron main process.
  interface OpenSwarmNotifyRequest {
    title: string;
    body?: string;
    deepLink?: string;
    runId?: string;
    workflowId?: string;
    actions?: Array<{ text: string; outcome: 'open' | 'ack' | 'rerun' | 'edit' }>;
  }

  interface OpenSwarmNotifyAction {
    outcome: 'open' | 'ack' | 'rerun' | 'edit';
    runId?: string;
    workflowId?: string;
    deepLink?: string;
  }

  interface OpenSwarmAPI {
    getBackendPort: () => number;
    getWebviewPreloadPath: () => string;
    getAppVersion: () => Promise<string>;
    setWindowButtonsVisible?: (visible: boolean) => Promise<void>;
    setWindowBackground?: (color: string) => Promise<void>;
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
    onCloseShortcut?: (cb: () => void) => () => void;
    onNewTabShortcut?: (cb: () => void) => () => void;
    onBrowserShortcut?: (cb: (payload: { action: string; webContentsId: number }) => void) => () => void;
    openExternal: (url: string) => Promise<void>;
    harvestUsage?: (provider: string) => Promise<{ ok: boolean; total: number; titles: string[]; memories: string[] } | null>;
    hardReset?: () => Promise<void>;
    clearBrowserData?: () => Promise<{ ok: boolean }>;
    voiceWarmup?: () => Promise<{ ok: boolean; error?: string }>;
    voiceStatus?: () => Promise<{ downloading: boolean; id: string | null; pct: number; error: string | null }>;
    voiceModels?: () => Promise<{ models: VoiceModel[]; selected: string }>;
    voiceSetModel?: (id: string) => Promise<{ ok: boolean; ready: boolean }>;
    voiceTranscribe?: (wav: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
    voiceInject?: (text: string) => Promise<{ ok: boolean; pasted?: boolean; error?: string }>;
    voiceStreamStart?: () => Promise<{ ok: boolean; error?: string }>;
    voiceStreamChunk?: (pcm: ArrayBuffer) => void;
    voiceStreamStop?: () => Promise<{ ok: boolean; text?: string; degraded?: boolean; error?: string }>;
    voiceStreamCancel?: () => void;
    onVoicePartial?: (cb: (p: { committed: string; tentative: string; seq: number }) => void) => () => void;
    onVoiceToggle?: (cb: () => void) => () => void;
    voiceHoldCapable?: () => Promise<boolean>;
    voiceRequestHoldPermission?: () => Promise<boolean>;
    onAuthUrl?: (cb: (url: string) => void) => () => void;
    onOauthClaim?: (cb: (url: string) => void) => () => void;
    notify?: (payload: OpenSwarmNotifyRequest) => Promise<boolean>;
    onNotificationAction?: (cb: (payload: OpenSwarmNotifyAction) => void) => () => void;
    revealPath?: (filePath: string) => Promise<{ ok: boolean }>;
    onDockShortcut?: (cb: (index: number) => void) => () => void;
    setOverlayEnabled?: (enabled: boolean) => Promise<{ ok: boolean }>;
    showOverlay?: () => Promise<{ ok: boolean }>;
    onOverlaySubmit?: (cb: (text: string) => void) => () => void;
  }

  interface Window {
    __OPENSWARM_PORT__: number;
    openswarm: OpenSwarmAPI;
  }
}
