import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LanguageIcon from '@mui/icons-material/Language';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { toggleMinimizeCard, setTiledCard, recordClosedCard } from '@/shared/state/dashboardLayoutSlice';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import WindowControls, { ARC_CHIP_SX } from '../cards/WindowControls';
import { getMinimizedShot, dropMinimizedShot } from './minimizedShots';
import type { BrowserCardPosition } from '@/shared/state/dashboardLayoutSlice';

interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MinimizedStackProps {
  browserCards: Record<string, BrowserCardPosition>;
  onRestore: (id: string, rect: CardRect) => void;
}

const THUMB_W = 96;

/** Right-edge stack of minimized browser windows; click restores the card where it was. */
function MinimizedStack({ browserCards, onRestore }: MinimizedStackProps): React.ReactElement | null {
  const dispatch = useAppDispatch();
  const minimized = useAppSelector((s) => s.dashboardLayout.minimizedCards);
  const entries = Object.values(browserCards).filter((bc) => minimized[bc.browser_id]);
  if (entries.length === 0) return null;

  return (
    <Box
      sx={{
        position: 'absolute',
        right: 14,
        top: 120,
        zIndex: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        alignItems: 'flex-end',
      }}
    >
      {entries.map((bc) => {
        const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId) || bc.tabs[0];
        const shot = getMinimizedShot(bc.browser_id);
        const restore = (): void => {
          dropMinimizedShot(bc.browser_id);
          dispatch(toggleMinimizeCard({ cardId: bc.browser_id }));
          onRestore(bc.browser_id, bc);
        };
        return (
          <Box
            key={bc.browser_id}
            onClick={restore}
            title={activeTab?.title || 'Browser'}
            className="osw-card osw-pill-host"
            sx={{
              position: 'relative',
              width: THUMB_W,
              borderRadius: '8px',
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
              background: '#fff',
              transition: 'transform 0.15s ease, box-shadow 0.15s ease',
              '&:hover': { transform: 'scale(1.06)', boxShadow: '0 10px 28px rgba(0,0,0,0.4)' },
              '&:hover .osw-pill-lights': { opacity: 1, pointerEvents: 'auto' },
            }}
          >
            <Box
              className="osw-pill-lights"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              sx={{
                ...ARC_CHIP_SX,
                position: 'absolute', top: 2, left: 2, zIndex: 2, background: 'rgba(24,14,32,0.85)',
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                opacity: 0, pointerEvents: 'none', transition: 'opacity 140ms ease',
              }}
            >
              <WindowControls
                onClose={() => { dispatch(recordClosedCard({ kind: 'browser', id: bc.browser_id })); removeBrowserCardCleanly(bc.browser_id, dispatch); }}
                onMinimize={restore}
                onTile={(zone: string) => { restore(); if (zone !== 'restore') dispatch(setTiledCard({ cardId: bc.browser_id, zone })); }}
                tiled={false}
              />
            </Box>
            {shot ? (
              <Box component="img" src={shot} alt="" sx={{ width: '100%', display: 'block', borderRadius: '8px' }} />
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, py: 1.5, px: 1 }}>
                {activeTab?.favicon ? (
                  <Box component="img" src={activeTab.favicon} alt="" sx={{ width: 20, height: 20, borderRadius: '4px' }} />
                ) : (
                  <LanguageIcon sx={{ fontSize: 20, color: '#8a8494' }} />
                )}
                <Typography sx={{ fontSize: '0.62rem', color: '#3c3744', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                  {activeTab?.title || 'Browser'}
                </Typography>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export default MinimizedStack;
