import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Modal from '@mui/material/Modal';
import Snackbar from '@mui/material/Snackbar';
import CloseIcon from '@mui/icons-material/Close';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

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
        sx={{ mb: 10, '& .MuiSnackbarContent-root': { p: 0, minWidth: 0, bgcolor: 'transparent', boxShadow: 'none' } }}
      >
        <Box
          sx={{
            display: 'flex', alignItems: 'center', gap: 2,
            bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
            boxShadow: c.shadow.md, borderRadius: '12px',
            px: 2.5, py: 1.5,
            width: 'min(560px, calc(100vw - 32px))',
            whiteSpace: 'normal',
          }}
        >
          {oversizeQueue[0] ? (
            <Box sx={{
              color: c.text.primary, fontSize: '0.9rem', lineHeight: 1.5,
              flex: '1 1 auto', minWidth: 0,
            }}>
              This file is too big to send. Shrink it down to a summary, or remove it?
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', gap: 0.75, flexShrink: 0 }}>
            <Box
              component="button"
              disabled={summarizingPath === oversizeQueue[0]?.path}
              onClick={() => oversizeQueue[0] && summarizeOversize(oversizeQueue[0].path)}
              sx={{
                bgcolor: c.accent.primary, color: '#fff',
                border: 'none', borderRadius: '6px',
                px: 1.5, py: 0.7, fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer',
                whiteSpace: 'nowrap',
                '&:hover': { bgcolor: c.accent.hover },
                '&:disabled': { opacity: 0.6, cursor: 'wait' },
              }}
            >
              {summarizingPath === oversizeQueue[0]?.path ? 'Shrinking…' : 'Shrink it'}
            </Box>
            <Box
              component="button"
              onClick={() => oversizeQueue[0] && detachOversize(oversizeQueue[0].path)}
              sx={{
                bgcolor: 'transparent', color: c.text.secondary,
                border: `1px solid ${c.border.medium}`, borderRadius: '6px',
                px: 1.5, py: 0.7, fontSize: '0.82rem', cursor: 'pointer',
                whiteSpace: 'nowrap',
                '&:hover': { bgcolor: c.bg.secondary, color: c.text.primary },
              }}
            >
              Remove
            </Box>
          </Box>
        </Box>
      </Snackbar>

      <Snackbar
        open={!!summarizeError}
        autoHideDuration={6000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        onClose={() => setSummarizeError(null)}
        sx={{ mb: 18, '& .MuiSnackbarContent-root': { p: 0, minWidth: 0, bgcolor: 'transparent', boxShadow: 'none' } }}
      >
        <Box
          sx={{
            display: 'flex', alignItems: 'center', gap: 1.5,
            bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
            boxShadow: c.shadow.md, borderRadius: '12px',
            px: 2.5, py: 1.5,
            width: 'min(560px, calc(100vw - 32px))',
            whiteSpace: 'normal',
          }}
        >
          <Box sx={{
            color: c.text.primary, fontSize: '0.9rem', lineHeight: 1.5,
            flex: '1 1 auto', minWidth: 0,
          }}>
            {summarizeError}
          </Box>
          <IconButton
            onClick={() => setSummarizeError(null)}
            size="small"
            sx={{ color: c.text.secondary, flexShrink: 0, '&:hover': { color: c.text.primary } }}
          >
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
      </Snackbar>
    </>
  );
};
