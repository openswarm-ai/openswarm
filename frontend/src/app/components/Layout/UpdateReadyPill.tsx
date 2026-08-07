import React, { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Grow from '@mui/material/Grow';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CloseIcon from '@mui/icons-material/Close';
import { Sprout } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { setInstalling } from '@/shared/state/updateSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const UPDATE_DISMISS_KEY = 'openswarm-update-dismissed';

// Claude-desktop-style quiet card, not a colored capsule: the download already ran silently
// (autoDownload in main.js), so the only state worth pixels is "ready". Top-right, above the
// frameless-window drag strip that used to swallow the old banner button's clicks.
const UpdateReadyPill: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const updateStatus = useAppSelector((s) => s.update.status);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const installing = useAppSelector((s) => s.update.installing);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try { return localStorage.getItem(UPDATE_DISMISS_KEY); } catch { return null; }
  });
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleInstall = useCallback(() => {
    if (installing) return;
    dispatch(setInstalling());
    (window as any).openswarm?.installUpdate();
  }, [installing, dispatch]);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setSessionDismissed(true);
    // Squirrel reports no version, so a persisted dismissal there would hide every FUTURE update too; those stay session-only.
    if (availableVersion) {
      try { localStorage.setItem(UPDATE_DISMISS_KEY, availableVersion); } catch {}
      setDismissedVersion(availableVersion);
    }
  }, [availableVersion]);

  const dismissed = sessionDismissed || (availableVersion !== null && dismissedVersion === availableVersion);
  const show = updateStatus === 'downloaded' && !dismissed;

  return (
    <Grow in={show} unmountOnExit>
      <Box
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handleInstall}
        role="button"
        aria-label={availableVersion ? `Restart to update to ${availableVersion}` : 'Restart to update'}
        sx={{
          position: 'fixed',
          // Owns the very corner while visible, deliberately covering the canvas Help pill: the card is transient (relaunch or dismiss) and the corner should show the most important thing. Top clears the 3px Spaces hot zone.
          top: 14,
          right: 16,
          zIndex: 1400,
          WebkitAppRegion: 'no-drag',
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          pl: 1.25,
          pr: 1.5,
          py: 1,
          borderRadius: '12px',
          bgcolor: c.bg.surface,
          border: `1px solid ${hovered ? c.border.strong : c.border.medium}`,
          boxShadow: hovered ? c.shadow.lg : c.shadow.md,
          cursor: installing ? 'default' : 'pointer',
          userSelect: 'none',
          transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
          transform: hovered && !installing ? 'translateY(-1px)' : 'none',
        }}
      >
        {/* Sprout = fresh growth, our answer to Claude's leaf: a thin-stroke monochrome glyph, never a raster logo in a quiet card. */}
        <Sprout size={22} strokeWidth={1.8} color={c.text.secondary} style={{ flexShrink: 0 }} />
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.25, color: c.text.primary, whiteSpace: 'nowrap' }}>
            {installing ? 'Relaunching…' : 'Relaunch to update'}
          </Typography>
          {availableVersion && (
            <Typography sx={{ fontSize: '0.6875rem', lineHeight: 1.3, color: c.text.tertiary, whiteSpace: 'nowrap' }}>
              v{availableVersion}
            </Typography>
          )}
        </Box>
        {installing
          ? <CircularProgress size={14} sx={{ color: c.text.tertiary, ml: 0.5, flexShrink: 0 }} />
          : (
            <ArrowForwardIcon
              sx={{
                fontSize: 16,
                color: c.text.tertiary,
                ml: 0.5,
                flexShrink: 0,
                transition: 'transform 0.18s ease, color 0.18s ease',
                transform: hovered ? 'translateX(2px)' : 'none',
              }}
            />
          )}
        {!installing && (
          <Box
            role="button"
            aria-label="Dismiss update reminder"
            onClick={handleDismiss}
            sx={{
              position: 'absolute',
              top: -7,
              right: -7,
              width: 18,
              height: 18,
              borderRadius: '50%',
              bgcolor: c.bg.elevated,
              border: `1px solid ${c.border.medium}`,
              color: c.text.tertiary,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? 'auto' : 'none',
              transition: 'opacity 0.15s ease',
              '&:hover': { color: c.text.primary, borderColor: c.border.strong },
            }}
          >
            <CloseIcon sx={{ fontSize: 11 }} />
          </Box>
        )}
      </Box>
    </Grow>
  );
};

export default UpdateReadyPill;
