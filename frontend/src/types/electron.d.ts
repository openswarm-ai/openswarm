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
    getAppVersion: () => Promise<string>;
    checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>;
    downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
    installUpdate: () => Promise<void>;
    onUpdateAvailable: (cb: (info: OpenSwarmUpdateInfo) => void) => () => void;
    onUpdateNotAvailable: (cb: (info: OpenSwarmUpdateInfo) => void) => () => void;
    onDownloadProgress: (cb: (progress: OpenSwarmDownloadProgress) => void) => () => void;
    onUpdateDownloaded: (cb: (info: OpenSwarmUpdateInfo) => void) => () => void;
    onUpdateError: (cb: (message: string) => void) => () => void;
  }

  interface Window {
    __OPENSWARM_PORT__: number;
    openswarm: OpenSwarmAPI;
  }
}
