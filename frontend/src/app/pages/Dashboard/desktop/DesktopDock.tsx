import React, { useCallback, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import LanguageIcon from '@mui/icons-material/Language';
import SettingsIcon from '@mui/icons-material/Settings';
import EditNoteIcon from '@mui/icons-material/EditNote';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import CoPresentIcon from '@mui/icons-material/CoPresent';
import { useAppDispatch } from '@/shared/hooks';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import { getWebview } from '@/shared/browserRegistry';
import { displayChatTitle } from '@/shared/state/sessionDisplay';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type {
  CardPosition,
  ViewCardPosition,
  BrowserCardPosition,
  NotePosition,
  WorkflowCardPosition,
} from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';

interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DockEntry {
  id: string;
  label: string;
  rect: CardRect;
  tileBg: string;
  icon: React.ReactNode;
  faviconUrl?: string;
  thumbnail?: string | null;
  browserId?: string;
  snippet?: string;
}

interface DesktopDockProps {
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  notes: Record<string, NotePosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  outputs: Record<string, Output>;
  selectedIds: string[];
  onFocusCard: (id: string, rect: CardRect) => void;
}

const TILE = 30;
const PREVIEW_W = 190;

/** Left-edge desktop dock: one tile per open card, hover previews, click focuses the window. */
function DesktopDock({
  sessions,
  cards,
  viewCards,
  browserCards,
  notes,
  workflowCards,
  outputs,
  selectedIds,
  onFocusCard,
}: DesktopDockProps): React.ReactElement | null {
  const dispatch = useAppDispatch();
  const [hovered, setHovered] = useState<{ id: string; top: number } | null>(null);
  const [liveShot, setLiveShot] = useState<{ id: string; dataUrl: string } | null>(null);
  const hoverTimer = useRef<number | null>(null);

  const entries = useMemo<DockEntry[]>(() => {
    const list: DockEntry[] = [];
    for (const card of Object.values(cards)) {
      const session = sessions[card.session_id];
      if (!session) continue;
      list.push({
        id: card.session_id,
        label: displayChatTitle(session),
        rect: card,
        tileBg: 'linear-gradient(135deg, #4a7dd6, #2b4fa8)',
        icon: <AutoAwesomeIcon sx={{ fontSize: 17, color: '#fff' }} />,
        snippet: session.turn_label?.label || undefined,
      });
    }
    for (const bc of Object.values(browserCards)) {
      const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId) || bc.tabs[0];
      list.push({
        id: bc.browser_id,
        label: activeTab?.title || 'Browser',
        rect: bc,
        tileBg: 'linear-gradient(135deg, #4f9fe8, #2f6ed4)',
        icon: <LanguageIcon sx={{ fontSize: 17, color: '#fff' }} />,
        faviconUrl: activeTab?.favicon,
        browserId: bc.browser_id,
      });
    }
    for (const [cardKey, vc] of Object.entries(viewCards)) {
      const output = outputs[vc.output_id];
      list.push({
        id: cardKey,
        label: output?.name || 'App',
        rect: vc,
        tileBg: 'linear-gradient(135deg, #ef9552, #d96a2b)',
        icon: <CoPresentIcon sx={{ fontSize: 16, color: '#fff' }} />,
        thumbnail: output?.thumbnail,
      });
    }
    for (const note of Object.values(notes)) {
      const firstLine = (note.content || '').split('\n')[0].trim();
      list.push({
        id: note.note_id,
        label: firstLine || 'Note',
        rect: note,
        tileBg: 'linear-gradient(135deg, #f2d270, #e0b23e)',
        icon: <EditNoteIcon sx={{ fontSize: 18, color: '#7a5d10' }} />,
        snippet: (note.content || '').slice(0, 140),
      });
    }
    for (const [cardKey, wf] of Object.entries(workflowCards)) {
      list.push({
        id: cardKey,
        label: 'Workflow',
        rect: wf,
        tileBg: 'linear-gradient(135deg, #ef7a70, #d94f45)',
        icon: <CalendarMonthIcon sx={{ fontSize: 16, color: '#fff' }} />,
      });
    }
    return list;
  }, [sessions, cards, viewCards, browserCards, notes, workflowCards, outputs]);

  const beginHover = useCallback(
    (entry: DockEntry, target: HTMLElement) => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      const top = target.offsetTop;
      hoverTimer.current = window.setTimeout(() => {
        setHovered({ id: entry.id, top });
        if (entry.browserId) {
          const wv = getWebview(entry.browserId);
          const capture = wv?.capturePage?.();
          if (capture && typeof (capture as Promise<unknown>).then === 'function') {
            (capture as Promise<{ toDataURL(): string }>)
              .then((img) => setLiveShot({ id: entry.id, dataUrl: img.toDataURL() }))
              .catch(() => undefined);
          }
        }
      }, 220);
    },
    [],
  );

  const endHover = useCallback(() => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    setHovered(null);
    setLiveShot(null);
  }, []);

  if (entries.length === 0) return null;

  const hoveredEntry = hovered ? entries.find((e) => e.id === hovered.id) : undefined;
  const previewImage = hoveredEntry
    ? (liveShot?.id === hoveredEntry.id ? liveShot.dataUrl : hoveredEntry.thumbnail || undefined)
    : undefined;

  return (
    <Box
      onMouseLeave={endHover}
      sx={{
        position: 'absolute',
        left: 12,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 11,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '9px',
        p: '7px',
        borderRadius: '14px',
        background: 'rgba(22,12,34,0.66)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
      }}
    >
      {entries.map((entry) => {
        const isActive = selectedIds.includes(entry.id);
        return (
          <Box
            key={entry.id}
            onMouseEnter={(e) => beginHover(entry, e.currentTarget as HTMLElement)}
            onClick={() => {
              endHover();
              onFocusCard(entry.id, entry.rect);
            }}
            sx={{
              width: TILE,
              height: TILE,
              borderRadius: '9px',
              background: entry.tileBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              overflow: 'hidden',
              flexShrink: 0,
              transition: 'transform 0.15s ease',
              '&:hover': { transform: 'scale(1.12)' },
              ...(isActive && { outline: '2px solid #6aa2ff', outlineOffset: '2px' }),
            }}
          >
            {entry.faviconUrl ? (
              <Box
                component="img"
                src={entry.faviconUrl}
                alt=""
                sx={{ width: 18, height: 18, borderRadius: '4px' }}
              />
            ) : (
              entry.icon
            )}
          </Box>
        );
      })}

      <Box sx={{ width: TILE - 8, height: '1px', background: 'rgba(255,255,255,0.14)' }} />
      <Box
        onClick={() => dispatch(openSettingsModal(undefined))}
        onMouseEnter={endHover}
        sx={{
          width: TILE,
          height: TILE,
          borderRadius: '9px',
          background: 'linear-gradient(135deg, #5a5a62, #34343c)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'transform 0.15s ease',
          '&:hover': { transform: 'scale(1.12)' },
        }}
      >
        <SettingsIcon sx={{ fontSize: 18, color: '#e8e8ee' }} />
      </Box>

      {hoveredEntry && (
        <Box
          sx={{
            position: 'absolute',
            left: 'calc(100% + 10px)',
            top: Math.max(0, hovered!.top - 34),
            width: PREVIEW_W,
            borderRadius: '10px',
            overflow: 'hidden',
            background: previewImage ? '#fff' : 'rgba(22,12,34,0.9)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
          }}
        >
          {previewImage ? (
            <Box component="img" src={previewImage} alt="" sx={{ width: '100%', display: 'block' }} />
          ) : (
            <Box sx={{ p: 1.25 }}>
              <Typography sx={{ color: '#fff', fontSize: '0.78rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {hoveredEntry.label}
              </Typography>
              {hoveredEntry.snippet && (
                <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.7rem', mt: 0.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {hoveredEntry.snippet}
                </Typography>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

export default DesktopDock;
