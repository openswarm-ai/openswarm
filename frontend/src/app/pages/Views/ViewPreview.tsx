import React, { useRef, useEffect, useMemo, forwardRef, useImperativeHandle, useState } from 'react';
import Box from '@mui/material/Box';
import { useElementSelection } from '@/app/pages/_shared/element_selection/useElementSelection';
import { useIframeElementSelector } from './useIframeElementSelector';

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
}, ref) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ctx = useElementSelection();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (ctx && iframeRef.current) {
      ctx.iframeRef.current = iframeRef.current;
    }
  }, [ctx, frontendCode, serveUrl]);

  useIframeElementSelector(iframeRef);

  const iframeSrc = useMemo(() => {
    if (!serveUrl) return undefined;
    const dataParam = encodeDataParam(inputData, backendResult);
    const sep = serveUrl.includes('?') ? '&' : '?';
    return `${serveUrl}${sep}_d=${encodeURIComponent(dataParam)}&_v=${reloadKey}`;
  }, [serveUrl, inputData, backendResult, reloadKey]);

  const srcdoc = useMemo(() => {
    if (serveUrl || !frontendCode) return undefined;
    return buildSrcdoc(frontendCode, inputData, backendResult);
  }, [serveUrl, frontendCode, inputData, backendResult]);

  useImperativeHandle(ref, () => ({
    reload: () => {
      if (serveUrl) {
        setReloadKey(k => k + 1);
      } else if (iframeRef.current && srcdoc) {
        iframeRef.current.srcdoc = '';
        requestAnimationFrame(() => {
          if (iframeRef.current) iframeRef.current.srcdoc = srcdoc;
        });
      }
    },
  }), [serveUrl, srcdoc]);

  useEffect(() => {
    if (iframeRef.current && srcdoc != null) {
      iframeRef.current.srcdoc = srcdoc;
    }
  }, [srcdoc]);

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
      <iframe
        ref={iframeRef}
        key={iframeSrc ? `url-${reloadKey}` : 'srcdoc'}
        src={iframeSrc}
        sandbox="allow-scripts allow-same-origin"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          background: '#fff',
          ...style,
        }}
        title="App Preview"
      />
    </Box>
  );
});

export default ViewPreview;
