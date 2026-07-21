import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import AddRounded from '@mui/icons-material/AddRounded';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import LanguageIcon from '@mui/icons-material/Language';

interface DesktopSpawnPillProps {
  onOpenComposer: () => void;
  onAddNote: () => void;
  onAddBrowser: () => void;
  onAddApp: () => void;
  onWorkflows: () => void;
  onHistory: () => void;
}

const MENU_ITEMS: Array<{ key: string; label: string; icon: React.ElementType }> = [
  { key: 'note', label: 'Add note', icon: StickyNote2OutlinedIcon },
  { key: 'browser', label: 'Browser', icon: LanguageIcon },
  { key: 'app', label: 'Add app', icon: GridViewRoundedIcon },
  { key: 'workflows', label: 'Workflows', icon: EventRepeatIcon },
  { key: 'history', label: 'History', icon: HistoryRoundedIcon },
];

/** Collapsed desktop composer: one dark pill that spawns an agent; + tucks the add actions away. */
function DesktopSpawnPill({
  onOpenComposer,
  onAddNote,
  onAddBrowser,
  onAddApp,
  onWorkflows,
  onHistory,
}: DesktopSpawnPillProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const actions: Record<string, () => void> = {
    note: onAddNote,
    browser: onAddBrowser,
    app: onAddApp,
    workflows: onWorkflows,
    history: onHistory,
  };

  return (
    <Box ref={rootRef} sx={{ position: 'relative' }}>
      {menuOpen && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 'calc(100% + 10px)',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            flexDirection: 'column',
            minWidth: 168,
            p: '6px',
            borderRadius: '14px',
            background: 'rgba(22,12,34,0.82)',
            backdropFilter: 'blur(20px) saturate(160%)',
            WebkitBackdropFilter: 'blur(20px) saturate(160%)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
          }}
        >
          {MENU_ITEMS.map(({ key, label, icon: ItemIcon }) => (
            <Box
              key={key}
              onClick={() => {
                setMenuOpen(false);
                actions[key]();
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.25,
                py: 0.75,
                borderRadius: '9px',
                cursor: 'pointer',
                '&:hover': { background: 'rgba(255,255,255,0.1)' },
              }}
            >
              <ItemIcon sx={{ fontSize: 17, color: 'rgba(255,255,255,0.75)' }} />
              <Typography sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.88)', fontWeight: 500 }}>
                {label}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          height: 34,
          pl: 1.75,
          pr: 1.25,
          borderRadius: 999,
          background: 'rgba(22,12,34,0.66)',
          backdropFilter: 'blur(20px) saturate(160%)',
          WebkitBackdropFilter: 'blur(20px) saturate(160%)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
          cursor: 'text',
        }}
        onClick={onOpenComposer}
      >
        <Typography
          sx={{
            fontSize: '0.82rem',
            color: 'rgba(255,255,255,0.55)',
            fontWeight: 400,
            userSelect: 'none',
            mr: 1.5,
          }}
        >
          Spawn an agent...
        </Typography>
        <Box
          role="button"
          aria-label="Add to canvas"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: '50%',
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.6)',
            '&:hover': { color: '#fff', background: 'rgba(255,255,255,0.12)' },
          }}
        >
          <AddRounded sx={{ fontSize: 18 }} />
        </Box>
        <Tooltip title="Voice input (coming soon)" placement="top" arrow>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: '50%',
              color: 'rgba(255,255,255,0.45)',
              cursor: 'default',
            }}
          >
            <MicNoneOutlinedIcon sx={{ fontSize: 16 }} />
          </Box>
        </Tooltip>
      </Box>
    </Box>
  );
}

export default DesktopSpawnPill;
