import React, { useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Skeleton } from '@/app/components/Loading';
import { useElementSelection } from '@/app/components/ElementSelectionContext';
import { useIframeElementSelector } from './useIframeElementSelector';
import { getAuthToken, ensureAuthToken } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// In Electron use <webview> to escape iframe restrictions (popups, mic/camera, WebAuthn, cookied fetch); outside Electron fall back to iframe.
const isElectron = navigator.userAgent.includes('Electron');

export interface ViewPreviewHandle {
  reload: () => void;
}

interface Props {
  /** URL-based serving (multi-file support). Takes priority over frontendCode. */
  serveUrl?: string;
  /** Legacy: raw HTML string rendered via srcdoc. */
  frontendCode?: string;
  inputData: Record<string, any>;
  backendResult?: Record<string, any> | null;
  style?: React.CSSProperties;
  /** Forwarded per console.* call in the running app (webview path only; iframes have no equivalent channel). */
  onConsoleMessage?: (level: string, text: string) => void;
  /** Fires once the embedded app has actually painted, so cold-start placeholders don't unmount during the vite-ready to first-paint gap. */
  onContentLoad?: () => void;
}

function buildSrcdoc(
  frontendCode: string,
  inputData: Record<string, any>,
  backendResult: Record<string, any> | null,
): string {
  const inputJson = JSON.stringify(inputData);
  const resultJson = JSON.stringify(backendResult);

  const injection = `<script>
window.OUTPUT_INPUT = ${inputJson};
window.OUTPUT_BACKEND_RESULT = ${resultJson};
</script>`;

  if (frontendCode.includes('</head>')) {
    return frontendCode.replace('</head>', `${injection}\n</head>`);
  }
  if (frontendCode.includes('<body')) {
    return frontendCode.replace('<body', `${injection}\n<body`);
  }
  return `${injection}\n${frontendCode}`;
}

function encodeDataParam(inputData: Record<string, any>, backendResult: Record<string, any> | null): string {
  const payload = JSON.stringify({ i: inputData, r: backendResult });
  return btoa(unescape(encodeURIComponent(payload)));
}

const ViewPreview = forwardRef<ViewPreviewHandle, Props>(({
  serveUrl,
  frontendCode,
  inputData,
  backendResult = null,
  style,
  onConsoleMessage,
  onContentLoad,
}, ref) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<any>(null);
  const ctx = useElementSelection();
  // Bg matches host theme so the 60-90s vite-boot gap doesn't flash white on dark hosts.
  const _hostTokens = useClaudeTokens();
  const _hostBg = _hostTokens.bg.page;
  const [reloadKey, setReloadKey] = useState(0);
  // Track in state so the iframe URL rebuilds the moment the token IPC roundtrip resolves (else first render 401s with a JSON body).
  const [authToken, setAuthToken] = useState(() => getAuthToken());
  useEffect(() => {
    if (authToken) return;
    let cancelled = false;
    ensureAuthToken().then((tok) => {
      if (!cancelled && tok) setAuthToken(tok);
    });
    return () => { cancelled = true; };
  }, [authToken]);

  const iframeSrc = useMemo(() => {
    if (!serveUrl) return undefined;
    // Wait for the token; tokenless URL 401s and the iframe would render the JSON error body.
    if (!authToken) return undefined;
    const dataParam = encodeDataParam(inputData, backendResult);
    const sep = serveUrl.includes('?') ? '&' : '?';
    return `${serveUrl}${sep}_d=${encodeURIComponent(dataParam)}&_v=${reloadKey}&token=${encodeURIComponent(authToken)}`;
  }, [serveUrl, inputData, backendResult, reloadKey, authToken]);

  // When the window is hidden, swap URL-mode iframes to about:blank to kill HMR + rAF CPU; srcdoc apps stay put so user in-memory state isn't wiped.
  const [windowHidden, setWindowHidden] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );
  useEffect(() => {
    const onVis = () => setWindowHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const effectiveSrc = useMemo(() => {
    if (!iframeSrc) return iframeSrc;
    return windowHidden ? 'about:blank' : iframeSrc;
  }, [iframeSrc, windowHidden]);

  // "Restoring preview..." overlay covers the window-restore to iframe-reload gap; cleared by load or 5s safety.
  const [restoring, setRestoring] = useState(false);
  const wasHiddenRef = useRef(windowHidden);
  useEffect(() => {
    if (wasHiddenRef.current && !windowHidden && iframeSrc) {
      setRestoring(true);
      const t = window.setTimeout(() => setRestoring(false), 5000);
      wasHiddenRef.current = windowHidden;
      return () => window.clearTimeout(t);
    }
    wasHiddenRef.current = windowHidden;
    return undefined;
  }, [windowHidden, iframeSrc]);

  const handleNavigationLoad = useCallback(() => {
    // load fires for both about:blank pause and real URL; only the latter counts.
    if (!windowHidden) setRestoring(false);
    if (!windowHidden && onContentLoad) {
      onContentLoad();
    }
  }, [windowHidden, onContentLoad]);

  const srcdoc = useMemo(() => {
    if (serveUrl || !frontendCode) return undefined;
    return buildSrcdoc(frontendCode, inputData, backendResult);
  }, [serveUrl, frontendCode, inputData, backendResult]);

  // Webview only when we have a real serveUrl; data:text/html for srcdoc breaks same-origin in the Electron sandbox.
  const useWebview = isElectron && !!iframeSrc;

  // Webview's contentDocument is null from the host (separate renderer process); element selection skips it (known regression).
  useEffect(() => {
    if (useWebview) return;
    if (ctx && iframeRef.current) {
      ctx.iframeRef.current = iframeRef.current;
    }
  }, [ctx, frontendCode, serveUrl, useWebview]);

  // Selector hook no-ops in webview mode because iframeRef stays null.
  useIframeElementSelector(iframeRef);

  useImperativeHandle(ref, () => ({
    reload: () => {
      if (useWebview) {
        // Bumping reloadKey re-navigates via src change; also call reload() as belt-and-suspenders.
        setReloadKey(k => k + 1);
        webviewRef.current?.reload?.();
      } else if (serveUrl) {
        setReloadKey(k => k + 1);
      } else if (iframeRef.current && srcdoc) {
        iframeRef.current.srcdoc = '';
        requestAnimationFrame(() => {
          if (iframeRef.current) iframeRef.current.srcdoc = srcdoc;
        });
      }
    },
  }), [useWebview, serveUrl, srcdoc]);

  useEffect(() => {
    if (useWebview) return;
    if (iframeRef.current && srcdoc != null) {
      iframeRef.current.srcdoc = srcdoc;
    }
  }, [srcdoc, useWebview]);

  // Forward webview-console events (preload wraps console.*) to onConsoleMessage; iframe path has no equivalent.
  useEffect(() => {
    if (!useWebview || !onConsoleMessage) return;
    const wv = webviewRef.current;
    if (!wv) return;
    const handler = (e: any) => {
      if (e?.channel !== 'webview-console') return;
      const arg = Array.isArray(e.args) ? e.args[0] : undefined;
      if (!arg) return;
      onConsoleMessage(arg.level || 'log', arg.text || '');
    };
    wv.addEventListener?.('ipc-message', handler);
    return () => {
      try { wv.removeEventListener?.('ipc-message', handler); } catch (_e) {}
    };
  }, [useWebview, onConsoleMessage, iframeSrc]);

  // Webviews use did-finish-load instead of onLoad; did-fail-load retries with 500ms to 5s backoff (Vite may not have bound yet when frontend_url arrives).
  useEffect(() => {
    if (!useWebview) return;
    const wv = webviewRef.current;
    if (!wv) return;

    let retryTimer: number | null = null;
    let retryDelay = 500;
    const MAX_DELAY = 5000;
    const cancelRetry = () => {
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const onFinish = () => {
      retryDelay = 500;
      cancelRetry();
      handleNavigationLoad();
    };
    const onFail = (e: any) => {
      // Guard on isMainFrame (subresource 404s fire too) and ERR_ABORTED (user-cancel).
      if (e && e.isMainFrame === false) return;
      if (e && e.errorCode === -3) return;
      if (retryTimer != null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        try { wv.reload?.(); } catch (_) {}
        retryDelay = Math.min(retryDelay * 2, MAX_DELAY);
      }, retryDelay);
    };

    wv.addEventListener?.('did-finish-load', onFinish);
    wv.addEventListener?.('did-fail-load', onFail);
    return () => {
      cancelRetry();
      try {
        wv.removeEventListener?.('did-finish-load', onFinish);
        wv.removeEventListener?.('did-fail-load', onFail);
      } catch (_e) {}
    };
  }, [useWebview, handleNavigationLoad]);

  const hasContent = !!(serveUrl || frontendCode?.trim());

  if (!hasContent) {
    return (
      <Box
        sx={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          fontSize: '0.85rem',
          fontStyle: 'italic',
          ...style,
        }}
      >
        No preview available
      </Box>
    );
  }

  const selectActive = ctx?.selectMode ?? false;

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        position: 'relative',
        ...(selectActive && {
          '&::after': {
            content: '""',
            position: 'absolute',
            inset: 0,
            border: '2px solid #3b82f6',
            borderRadius: '2px',
            pointerEvents: 'none',
            animation: 'selectModePulse 2s ease-in-out infinite',
            zIndex: 1,
          },
          '@keyframes selectModePulse': {
            '0%, 100%': { borderColor: 'rgba(59, 130, 246, 0.6)' },
            '50%': { borderColor: 'rgba(59, 130, 246, 0.2)' },
          },
        }),
      }}
    >
      {useWebview ? (
        <webview
          ref={(el: any) => { webviewRef.current = el; }}
          // Stable key so src swaps in place (keeps prior pixels through reload).
          key="url-mode-webview"
          src={effectiveSrc}
          // Autoplay matches BrowserCard default; plugins/nodeintegration stay off.
          webpreferences="autoplayPolicy=no-user-gesture-required"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: _hostBg,
            ...style,
          }}
        />
      ) : (
        <iframe
          ref={iframeRef}
          // Key only changes on mode switch (URL vs srcdoc); reloadKey updates the src attribute in place to avoid blank-flash on reload.
          key={iframeSrc ? 'url-mode' : 'srcdoc'}
          src={effectiveSrc}
          onLoad={handleNavigationLoad}
          sandbox="allow-scripts allow-same-origin"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: _hostBg,
            ...style,
          }}
          title="App Preview"
        />
      )}
      {restoring && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            bgcolor: _hostBg,
            zIndex: 2,
            pointerEvents: 'none',
          }}
        >
          <Skeleton variant="card" width={140} height={14} delayMs={0} />
          <Typography sx={{ fontSize: '0.78rem', color: '#888', letterSpacing: '0.01em' }}>
            Restoring preview...
          </Typography>
        </Box>
      )}
    </Box>
  );
});

export default ViewPreview;
