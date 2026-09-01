import React from 'react';
import Box from '@mui/material/Box';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  toggleMinimizeCard, setTiledCard, recordClosedCard, closeSettingsCard, closeMarketplaceCard, closeWorkflowsApp,
} from '@/shared/state/dashboardLayoutSlice';
import { removeBrowserCardCleanly } from '@/shared/browserTeardown';
import { removeViewCardCleanly } from '@/shared/viewTeardown';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { GLASS_SURFACE, GLASS_SURFACE_BLUR } from '@/shared/styles/glassSurface';
import { dropMinimizedShot } from './minimizedShots';
import { buildMinimizedEntries, MinimizedEntry, MinimizedRect } from './minimizedEntries';
import MinimizedTile, { MINIMIZED_TILE_W } from './MinimizedTile';
import { openCardContextMenu } from './openCardContextMenu';
import type { BrowserCardPosition, ViewCardPosition } from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';

interface MinimizedStackProps {
  browserCards: Record<string, BrowserCardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  outputs: Record<string, Output>;
  selectedIds: string[];
  onRestore: (id: string, rect: MinimizedRect) => void;
}

/** Right-edge rail of parked windows, browsers and apps alike; click a tile to put it back. */
function MinimizedStack({ browserCards, viewCards, outputs, selectedIds, onRestore }: MinimizedStackProps): React.ReactElement | null {
  const dispatch = useAppDispatch();
  const c = useClaudeTokens();
  const minimizedCards = useAppSelector((s) => s.dashboardLayout.minimizedCards);
  const tiledCards = useAppSelector((s) => s.dashboardLayout.tiledCards);
  const workflowsHub = useAppSelector((s) => s.dashboardLayout.workflowsHub);
  const settingsCard = useAppSelector((s) => s.dashboardLayout.settingsCard);
  const marketplaceCard = useAppSelector((s) => s.dashboardLayout.marketplaceCard);
  const entries = buildMinimizedEntries({ browserCards, viewCards, outputs, workflowsHub, settingsCard, marketplaceCard, minimizedCards });
  if (entries.length === 0) return null;

  const restore = (entry: MinimizedEntry): void => {
    dropMinimizedShot(entry.id);
    dispatch(toggleMinimizeCard({ cardId: entry.id }));
    // A card that kept its tile comes back pinned to the viewport, so flying the camera to its stored
    // free-floating rect would just wander off to empty canvas.
    if (!tiledCards[entry.id]) onRestore(entry.id, entry.rect);
  };
  const close = (entry: MinimizedEntry): void => {
    dropMinimizedShot(entry.id);
    if (entry.kind === 'browser') {
      dispatch(recordClosedCard({ kind: 'browser', id: entry.id }));
      void removeBrowserCardCleanly(entry.id, dispatch);
    } else if (entry.kind === 'view') {
      dispatch(recordClosedCard({ kind: 'view', id: entry.id }));
      void removeViewCardCleanly(entry.id, dispatch);
    } else if (entry.kind === 'workflows') {
      dispatch(closeWorkflowsApp());
    } else if (entry.kind === 'marketplace') {
      dispatch(closeMarketplaceCard());
    } else {
      dispatch(closeSettingsCard());
    }
  };
  const tile = (entry: MinimizedEntry, zone: string): void => {
    restore(entry);
    // Let the unpark PAINT before tiling: doing both in one frame teleported a half-built card into the zone (the janky minimized-to-fullscreen). Next frame, the tile glide takes it from its home to the zone.
    if (zone !== 'restore') requestAnimationFrame(() => requestAnimationFrame(() => dispatch(setTiledCard({ cardId: entry.id, zone }))));
  };

  return (
    <Box
      data-minimized-rail
      // Must stay OUTSIDE the canvas transform: a transformed ancestor becomes the containing block, so a rail nested in there would ride the camera.
      sx={{
        position: 'absolute',
        right: 14,
        top: 120,
        zIndex: 11,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        p: '6px',
        borderRadius: '16px',
        width: MINIMIZED_TILE_W + 12,
        maxHeight: 'calc(100% - 220px)',
        overflowY: 'auto',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
        background: GLASS_SURFACE,
        backdropFilter: GLASS_SURFACE_BLUR,
        WebkitBackdropFilter: GLASS_SURFACE_BLUR,
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
        '@keyframes osw-min-tile-in': {
          from: { opacity: 0, transform: 'scale(0.96)' },
          to: { opacity: 1, transform: 'scale(1)' },
        },
        // A minimize is a physical snap, so the aggressive out-ease; nothing here loops.
        '& .osw-min-tile': { animation: 'osw-min-tile-in 180ms cubic-bezier(0.16, 1, 0.3, 1) both' },
        '@media (prefers-reduced-motion: reduce)': {
          '& .osw-min-tile': { animation: 'none' },
        },
      }}
    >
      {entries.map((entry) => (
        <MinimizedTile
          key={entry.id}
          entry={entry}
          accent={c.accent.primary}
          selected={selectedIds.includes(entry.id)}
          onRestore={() => restore(entry)}
          onClose={() => close(entry)}
          onTile={(zone: string) => tile(entry, zone)}
          onContextMenu={(e: React.MouseEvent) => openCardContextMenu(e, {
            items: [
              { label: 'Restore', onClick: () => restore(entry) },
              { label: 'Restore full screen', onClick: () => tile(entry, 'fullscreen') },
              { kind: 'separator' },
              { label: 'Close', danger: true, onClick: () => close(entry) },
            ],
          })}
        />
      ))}
    </Box>
  );
}

export default React.memo(MinimizedStack);
