import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { store } from '@/shared/state/store';
import { captureBrowserShot } from '@/shared/captureBrowserShot';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { getWebview } from '@/shared/browserRegistry';
import { buildDockEntries, CardRect, DockEntry } from './dockEntries';
import { openCardContextMenu } from './openCardContextMenu';
import { dockTileMenuRows } from './dockTileMenuRows';
import { useDockLayout } from './useDockLayout';
import { DockTileIcon } from './DockTileIcon';
import DockActionTiles, { DOCK_ACTION_COUNT } from './DockActionTiles';
import DockHoverPreview from './DockHoverPreview';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
  WorkflowCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';

interface DesktopDockProps {
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  outputs: Record<string, Output>;
  selectedIds: string[];
  onFocusCard: (id: string, rect: CardRect) => void;
  onApplications: () => void;
  onAddBrowser: () => void;
}

const CARET_H = 13;

/** Left-edge desktop dock: one tile per open card, hover previews, click focuses the window. */
function DesktopDock({
  cards,
  viewCards,
  browserCards,
  workflowCards,
  outputs,
  selectedIds,
  onFocusCard,
  onApplications,
  onAddBrowser,
}: DesktopDockProps): React.ReactElement | null {
  const dispatch = useAppDispatch();
  const accent = useClaudeTokens().accent.primary;
  const [hovered, setHovered] = useState<{ id: string; top: number } | null>(null);
  const [liveShot, setLiveShot] = useState<{ id: string; dataUrl: string } | null>(null);
  const [edges, setEdges] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });
  const hoverTimer = useRef<number | null>(null);

  // The dock consumes only name + turn_label per session, but the whole-dict identity changes on
  // every stream tick to ANY session; a primitive fingerprint keeps this from rebuilding per tick.
  const sessionsKey = useAppSelector((s2) =>
    Object.values(s2.agents.sessions).map((x) => `${x.id}:${x.name ?? ''}:${x.turn_label?.label ?? ''}`).join('|'));
  const entries = useMemo<DockEntry[]>(
    () => buildDockEntries({ sessions: store.getState().agents.sessions, cards, viewCards, browserCards, workflowCards, outputs }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsKey, cards, viewCards, browserCards, workflowCards, outputs],
  );

  const { dockRef, scrollRef, tile, gap, iconSize, scrolls, scrollHeight, bleed, applyMagnify } = useDockLayout({
    cardCount: entries.length,
    actionCount: DOCK_ACTION_COUNT,
    dividerCount: entries.length > 0 ? 2 : 1,
  });

  const endHover = useCallback(() => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    setHovered(null);
    setLiveShot(null);
  }, []);

  const beginHover = useCallback(
    (entry: DockEntry, target: HTMLElement) => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      const box = scrollRef.current;
      const top = target.offsetTop + (box?.contains(target) ? box.offsetTop - box.scrollTop : 0);
      hoverTimer.current = window.setTimeout(() => {
        setHovered({ id: entry.id, top });
        if (entry.browserId) {
          const entryId = entry.id;
          void captureBrowserShot(entry.browserId).then((shot) => {
            if (shot) setLiveShot({ id: entryId, dataUrl: shot });
          });
        }
      }, 220);
    },
    [scrollRef],
  );

  const readEdges = useCallback((el: HTMLDivElement) => {
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && scrolls) readEdges(el);
    else setEdges((prev) => (prev.top || prev.bottom ? { top: false, bottom: false } : prev));
  }, [scrolls, scrollHeight, entries.length, readEdges, scrollRef]);

  // The fade is exactly the bleed band, which (since scrolling only happens at the tile floor, where bleed > tile)
  // is the only place a partly-scrolled tile can ever show: so a cut icon always fades out, never hard-clips.
  const mask = scrolls
    ? `linear-gradient(to bottom, rgba(0,0,0,${edges.top ? 0 : 1}) 0px, #000 ${bleed}px, #000 calc(100% - ${bleed}px), rgba(0,0,0,${edges.bottom ? 0 : 1}) 100%)`
    : undefined;

  const hoveredEntry = useMemo(() => (hovered ? entries.find((e) => e.id === hovered.id) : undefined), [entries, hovered]);
  const previewImage = hoveredEntry
    ? (liveShot?.id === hoveredEntry.id ? liveShot.dataUrl : hoveredEntry.thumbnail || undefined)
    : undefined;

  // Past the shrink floor the column scrolls, and a hidden scrollbar with no caret reads as "the rest is gone".
  const carets: { key: string; top: number; icon: React.ReactNode }[] = [];
  if (scrolls && edges.top) carets.push({ key: 'up', top: 0, icon: <KeyboardArrowUpRoundedIcon sx={{ fontSize: '0.75rem' }} /> });
  if (scrolls && edges.bottom) carets.push({ key: 'down', top: scrollHeight - CARET_H, icon: <KeyboardArrowDownRoundedIcon sx={{ fontSize: '0.75rem' }} /> });

  return (
    <Box
      ref={dockRef}
      data-desktop-dock
      onMouseMove={(e: React.MouseEvent) => applyMagnify(e.clientY)}
      onMouseLeave={() => { endHover(); applyMagnify(null); }}
      sx={{
        position: 'absolute',
        left: 12,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 11,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: `${gap}px`,
        p: '7px',
        borderRadius: '16px',
        background: 'rgba(22,12,34,0.66)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
        // Rounder squircle tiles (real app icons, not lame squares). The magnify transform is set
        // imperatively per-frame by applyMagnify; a short ease smooths the chase + the reset.
        '& .osw-dock-tile': {
          borderRadius: '12px',
          transition: 'transform 0.12s ease-out',
          transformOrigin: 'left center',
          willChange: 'transform',
        },
        // One source of truth for glyph size, so favicons and every icon pack shrink with the tile.
        '& .osw-dock-tile svg, & .osw-dock-tile img': { width: iconSize, height: iconSize },
      }}
    >
      {entries.length > 0 && (
        <Box
          ref={scrollRef}
          data-dock-scroll
          onScroll={scrolls ? (e: React.UIEvent<HTMLDivElement>) => { readEdges(e.currentTarget); endHover(); } : undefined}
          // The canvas zooms on wheel; a wheel we consume here must never reach it.
          onWheel={scrolls ? (e: React.WheelEvent) => e.stopPropagation() : undefined}
          sx={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: `${gap}px`,
            ...(scrolls && {
              height: `${scrollHeight}px`,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              // Bleed the clip box past the column so scrolling doesn't crop the magnified tiles.
              width: `${tile + bleed * 2}px`,
              mx: `${-bleed}px`,
              py: `${bleed}px`,
              scrollbarWidth: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
              maskImage: mask,
              WebkitMaskImage: mask,
            }),
          }}
        >
          {entries.map((entry) => {
            const isActive = selectedIds.includes(entry.id);
            return (
              <Box
                key={entry.id}
                className="osw-dock-tile"
                data-dock-group="entries"
                role="button"
                // The hover card carries the name for the eye; this carries it for everything else (screen readers, tests).
                aria-label={entry.label}
                onMouseEnter={(e) => beginHover(entry, e.currentTarget as HTMLElement)}
                onClick={() => {
                  endHover();
                  onFocusCard(entry.id, entry.rect);
                }}
                onContextMenu={(e: React.MouseEvent) => {
                  endHover();
                  openCardContextMenu(e, { items: dockTileMenuRows(entry, dispatch, () => onFocusCard(entry.id, entry.rect)) });
                }}
                sx={{
                  position: 'relative',
                  width: tile,
                  height: tile,
                  borderRadius: '12px',
                  background: entry.tileBg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  flexShrink: 0,
                  transition: 'box-shadow 140ms ease, background 140ms ease',
                  // Same grammar as the minimized rail: soft accent tint, ONE accent inner ring as the carrier, and the icon lifts. The outer glow is decoration, never the signal.
                  ...(isActive && {
                    background: `linear-gradient(0deg, ${accent}1f, ${accent}1f), ${entry.tileBg}`,
                    boxShadow: `inset 0 0 0 1px ${accent}, 0 0 24px ${accent}26`,
                    '& > *': { filter: 'brightness(1.25)' },
                  }),
                }}
              >
                {/* Keyed by url so navigating to a new site re-arms the favicon after a previous one failed. */}
                <DockTileIcon key={entry.faviconUrl || 'glyph'} entry={entry} />
              </Box>
            );
          })}
        </Box>
      )}

      {entries.length > 0 && (
        <Box sx={{ width: tile - 8, height: '1px', background: 'rgba(255,255,255,0.14)' }} />
      )}
      <DockActionTiles tile={tile} onAddBrowser={onAddBrowser} onApplications={onApplications} onHoverAway={endHover} />

      {/* Anchored to the root's padding box, whose top edge IS the scroll box's top edge. */}
      {carets.map((c) => (
        <Box
          key={c.key}
          sx={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${c.top}px`,
            height: `${CARET_H}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.72)',
            pointerEvents: 'none',
            zIndex: 40,
          }}
        >
          {c.icon}
        </Box>
      ))}

      {hoveredEntry && (
        <DockHoverPreview entry={hoveredEntry} top={hovered!.top} railHeight={dockRef.current?.offsetHeight ?? 0} image={previewImage} />
      )}
    </Box>
  );
}

export default React.memo(DesktopDock);
