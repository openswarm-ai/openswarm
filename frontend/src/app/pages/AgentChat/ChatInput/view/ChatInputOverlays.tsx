import React from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import IconButton from '@mui/material/IconButton';
import Modal from '@mui/material/Modal';
import CloseIcon from '@mui/icons-material/Close';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

function ShrinkingLabel() {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6 }}>
      <Box component="span" sx={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        bgcolor: 'currentColor',
        animation: 'osw-pulse 1.2s ease-in-out infinite',
        '@keyframes osw-pulse': {
          '0%, 100%': { opacity: 0.4 },
          '50%': { opacity: 1 },
        },
      }} />
      Shrinking
    </Box>
  );
}

interface OversizePopupProps {
  c: ClaudeTokens;
  oversizeQueue: Array<{ path: string; name: string; tokens: number }>;
  summarizingAll: boolean;
  summarizingPath: string | null;
}

/** Status indicator (NOT a prompt). When files land oversize they auto-shrink
 *  via useContextFiles' useEffect — no click required. This box just tells the
 *  user what's happening so the chat doesn't look frozen during the shrink. */
const OversizePopup: React.FC<OversizePopupProps> = ({
  c, oversizeQueue, summarizingAll, summarizingPath,
}) => {
  const queued = oversizeQueue.length > 0;
  const lastSnapshot = React.useRef(oversizeQueue);
  if (queued) lastSnapshot.current = oversizeQueue;
  const snap = lastSnapshot.current;
  const n = snap.length;
  if (n === 0) return null;
  const firstName = snap[0].name;
  const shrinking = summarizingAll || !!summarizingPath;
  const label = n === 1
    ? <>Shrinking <strong>{firstName}</strong> to fit</>
    : <>Shrinking <strong>{firstName}</strong> and {n - 1} other{n > 2 ? 's' : ''} to fit</>;
  return (
    <Fade in={queued} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        sx={{
          position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 8px)',
          bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
          boxShadow: c.shadow.md, borderRadius: '12px',
          px: 2, py: 1.25,
          whiteSpace: 'normal',
          zIndex: 5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box component="span" sx={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            bgcolor: c.accent.primary,
            animation: shrinking ? 'osw-pulse 1.2s ease-in-out infinite' : 'none',
            '@keyframes osw-pulse': {
              '0%, 100%': { opacity: 0.4 },
              '50%': { opacity: 1 },
            },
            flexShrink: 0,
          }} />
          <Box sx={{
            color: c.text.primary, fontSize: '0.875rem', lineHeight: 1.45,
            flex: '1 1 auto', minWidth: 0,
          }}>
            {label}
          </Box>
        </Box>
        <SlowHint active={shrinking} color={c.text.secondary} />
      </Box>
    </Fade>
  );
};

/** Fade-wrapped error toast. Last-non-null snapshot keeps the message visible
 *  through the exit animation instead of going blank during fade-out. */
const ErrorToast: React.FC<{ c: ClaudeTokens; message: string | null; onClose: () => void }> = ({ c, message, onClose }) => {
  const lastMessage = React.useRef<string | null>(null);
  if (message) lastMessage.current = message;
  const display = lastMessage.current;
  if (!display) return null;
  return (
    <Fade in={!!message} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
      <Box
        sx={{
          position: 'absolute', left: 8, right: 8, bottom: 'calc(100% + 8px)',
          display: 'flex', alignItems: 'center', gap: 1.5,
          bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`,
          boxShadow: c.shadow.md, borderRadius: '12px',
          px: 2, py: 1.25,
          whiteSpace: 'normal',
          zIndex: 6,
        }}
      >
        <Box sx={{
          color: c.text.primary, fontSize: '0.875rem', lineHeight: 1.45,
          flex: '1 1 auto', minWidth: 0,
        }}>
          {display}
        </Box>
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ color: c.text.secondary, flexShrink: 0, '&:hover': { color: c.text.primary } }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>
    </Fade>
  );
};

/** Honest "this is taking a sec" hint that fades in only AFTER 10s of waiting.
 *  Silent on fast operations (most cases) so we don't lie about every shrink
 *  being slow; visible only when the user has actually been waiting long enough
 *  to start wondering if it's frozen. */
function SlowHint({ active, color }: { active: boolean; color: string }) {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    if (!active) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), 10000);
    return () => clearTimeout(t);
  }, [active]);
  return (
    <Fade in={show} timeout={250}>
      <Box sx={{ color, fontSize: '0.75rem', mt: 0.5, lineHeight: 1.3, opacity: 0.7 }}>
        This may take up to a minute. Sit tight.
      </Box>
    </Fade>
  );
}

interface Props {
  c: ClaudeTokens;
  lightboxSrc: string | null;
  setLightboxSrc: (src: string | null) => void;
  oversizeQueue: Array<{ path: string; name: string; tokens: number }>;
  summarizingPath: string | null;
  summarizingAll: boolean;
  summarizeOversize: (path: string) => void;
  summarizeAllOversize: () => void;
  detachOversize: (path: string) => void;
  detachAllOversize: () => void;
  currentModelCtx: number;
  summarizeError: string | null;
  setSummarizeError: (v: string | null) => void;
}

export const ChatInputOverlays: React.FC<Props> = ({
  c, lightboxSrc, setLightboxSrc, oversizeQueue, summarizingPath, summarizingAll,
  summarizeOversize, summarizeAllOversize, detachOversize, detachAllOversize,
  currentModelCtx, summarizeError, setSummarizeError,
}) => {
  // Auto-dismiss the error after 6s, matching the Snackbar behavior we replaced.
  React.useEffect(() => {
    if (!summarizeError) return;
    const t = setTimeout(() => setSummarizeError(null), 6000);
    return () => clearTimeout(t);
  }, [summarizeError, setSummarizeError]);
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

      {/* Single popup handles ALL over-size files. Fade controls enter/exit so the
          handoff to auto-retry-send feels smooth, not snap-cut. Internal SlowHint
          only fades in after 10s of waiting so we're honest without being noisy. */}
      <OversizePopup
        c={c}
        oversizeQueue={oversizeQueue}
        summarizingAll={summarizingAll}
        summarizingPath={summarizingPath}
      />

      {/* Error toast also fades. 220ms exit keeps it from snap-disappearing on close. */}
      <ErrorToast c={c} message={summarizeError} onClose={() => setSummarizeError(null)} />
    </>
  );
};
