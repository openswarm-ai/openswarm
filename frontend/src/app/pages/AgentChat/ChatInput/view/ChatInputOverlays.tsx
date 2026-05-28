import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Modal from '@mui/material/Modal';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import CloseIcon from '@mui/icons-material/Close';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { formatTokenCount } from '../helpers';

interface Props {
  c: ClaudeTokens;
  lightboxSrc: string | null;
  setLightboxSrc: (src: string | null) => void;
  oversizeQueue: Array<{ path: string; name: string; tokens: number }>;
  summarizingPath: string | null;
  summarizeOversize: (path: string) => void;
  detachOversize: (path: string) => void;
  currentModelCtx: number;
  summarizeError: string | null;
  setSummarizeError: (v: string | null) => void;
}

export const ChatInputOverlays: React.FC<Props> = ({
  c, lightboxSrc, setLightboxSrc, oversizeQueue, summarizingPath, summarizeOversize,
  detachOversize, currentModelCtx, summarizeError, setSummarizeError,
}) => {
  return (
    <>
      <Modal
        open={!!lightboxSrc}
        onClose={() => setLightboxSrc(null)}
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Box
          onClick={() => setLightboxSrc(null)}
          sx={{ position: 'relative', outline: 'none', maxWidth: '90vw', maxHeight: '90vh' }}
        >
          <IconButton
            onClick={() => setLightboxSrc(null)}
            sx={{
              position: 'absolute',
              top: -16,
              right: -16,
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.medium}`,
              color: c.text.secondary,
              width: 32,
              height: 32,
              zIndex: 1,
              '&:hover': { bgcolor: c.bg.secondary },
              boxShadow: c.shadow.md,
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
          <img
            src={lightboxSrc || ''}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              borderRadius: 8,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              display: 'block',
            }}
          />
        </Box>
      </Modal>

      <Snackbar
        open={oversizeQueue.length > 0}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ mb: 10 }}
      >
        <Alert
          severity="warning"
          variant="filled"
          icon={false}
          sx={{ alignItems: 'center', maxWidth: 520, fontSize: '0.78rem' }}
          action={
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Box
                component="button"
                disabled={summarizingPath === oversizeQueue[0]?.path}
                onClick={() => oversizeQueue[0] && summarizeOversize(oversizeQueue[0].path)}
                sx={{
                  background: 'rgba(255,255,255,0.18)', color: 'inherit', border: 'none',
                  borderRadius: '6px', px: 1, py: 0.5, fontSize: '0.72rem', cursor: 'pointer',
                  '&:hover': { background: 'rgba(255,255,255,0.28)' },
                  '&:disabled': { opacity: 0.6, cursor: 'wait' },
                }}
              >
                {summarizingPath === oversizeQueue[0]?.path ? 'Summarizing…' : 'Summarize instead'}
              </Box>
              <Box
                component="button"
                onClick={() => oversizeQueue[0] && detachOversize(oversizeQueue[0].path)}
                sx={{
                  background: 'transparent', color: 'inherit', border: '1px solid rgba(255,255,255,0.4)',
                  borderRadius: '6px', px: 1, py: 0.5, fontSize: '0.72rem', cursor: 'pointer',
                  '&:hover': { background: 'rgba(255,255,255,0.12)' },
                }}
              >
                Detach
              </Box>
            </Box>
          }
        >
          {oversizeQueue[0] ? (
            <span>
              <strong>{oversizeQueue[0].name}</strong> is ~{formatTokenCount(oversizeQueue[0].tokens)} tokens, over 50% of this model's window ({formatTokenCount(currentModelCtx)}). Summarize sends the file content to your configured aux provider.
            </span>
          ) : null}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!summarizeError}
        autoHideDuration={6000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        onClose={() => setSummarizeError(null)}
        sx={{ mb: 18 }}
      >
        <Alert severity="error" variant="filled" onClose={() => setSummarizeError(null)} sx={{ fontSize: '0.78rem', maxWidth: 520 }}>
          {summarizeError}
        </Alert>
      </Snackbar>
    </>
  );
};
