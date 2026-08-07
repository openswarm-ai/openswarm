import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDashboard, deleteDashboard, duplicateDashboard, renameDashboard } from '@/shared/state/dashboardsSlice';
import { openCardContextMenu } from './openCardContextMenu';
import { ACTIVE_TILE_ATTR, useStripScroll } from './useStripScroll';

// macOS Spaces, one for one: rest the cursor on the top edge and the spaces bar slides down,
// full-size thumbnail tiles with the name beneath, + at the right end to add a space. It stays
// up while the cursor is anywhere near the bar and only leaves once you move well below it
// (mouseleave flicker is exactly what Mission Control does not do). Right-click a tile for
// Rename / Duplicate / Delete; rename edits the name inline under the tile.
const HOT_ZONE_PX = 3;
const TILE_W = 176;
const TILE_H = 104;
const DISMISS_BELOW_PX = 72;
const EDGE_W = 76;

interface StripEdgeProps {
  side: 'left' | 'right';
  visible: boolean;
  onNudge: () => void;
}

// The fade says "there is more this way"; the chevron makes it clickable for anyone without a trackpad.
const StripEdge: React.FC<StripEdgeProps> = ({ side, visible, onNudge }) => (
  <Box
    sx={{
      position: 'absolute', top: 0, bottom: 0, [side]: 0, width: EDGE_W,
      display: 'flex', alignItems: 'center', justifyContent: side === 'left' ? 'flex-start' : 'flex-end',
      px: 0.75, pointerEvents: 'none', zIndex: 1,
      opacity: visible ? 1 : 0, transition: 'opacity 180ms ease',
      background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(20,18,24,0.9), rgba(20,18,24,0))`,
    }}
  >
    <Box
      component="button"
      aria-label={side === 'left' ? 'Scroll spaces left' : 'Scroll spaces right'}
      onClick={onNudge}
      sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '50%', cursor: 'pointer',
        pointerEvents: visible ? 'auto' : 'none',
        border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.12)',
        color: 'rgba(255,255,255,0.92)', transition: 'background 140ms',
        '&:hover': { background: 'rgba(255,255,255,0.26)' },
      }}
    >
      {side === 'left' ? <ChevronLeft size={17} /> : <ChevronRight size={17} />}
    </Box>
  </Box>
);

const SpacesStrip: React.FC = () => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const dashboards = useAppSelector((s) => s.dashboards.items);
  const [open, setOpen] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const barRef = React.useRef<HTMLDivElement | null>(null);

  const activeId = React.useMemo(() => {
    const m = location.pathname.match(/\/dashboard\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);

  const list = React.useMemo(
    () => Object.values(dashboards).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
    [dashboards],
  );

  const strip = useStripScroll(activeId, list.length, open);

  // Mission Control dismissal: while open, watch the cursor globally and close only once it has
  // moved a comfortable distance BELOW the bar; hovering within or near the bar never flickers.
  // The watcher pauses while a context menu, rename or drag-pan is live, so those can wander below the bar.
  React.useEffect(() => {
    if (!open || renamingId || strip.dragging) return undefined;
    const onMove = (e: MouseEvent): void => {
      // The shared menu stamps this class while up; the strip must not slide away under an open menu.
      if (document.body.classList.contains('osw-card-menu-open')) return;
      const barBottom = barRef.current?.getBoundingClientRect().bottom ?? 0;
      if (e.clientY > barBottom + DISMISS_BELOW_PX) setOpen(false);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [open, renamingId, strip.dragging]);

  const addSpace = (): void => {
    void dispatch(createDashboard('Untitled Dashboard')).then((result) => {
      if (createDashboard.fulfilled.match(result)) {
        navigate(`/dashboard/${(result.payload as { id: string }).id}`);
        setOpen(false);
      }
    });
  };

  const commitRename = (id: string): void => {
    const trimmed = renameValue.trim();
    const previousName = dashboards[id]?.name;
    if (trimmed && trimmed !== previousName) {
      void dispatch(renameDashboard({ id, name: trimmed, previousName }));
    }
    setRenamingId(null);
  };

  const duplicateSpace = (id: string): void => {
    void dispatch(duplicateDashboard(id)).then((result) => {
      if (duplicateDashboard.fulfilled.match(result)) navigate(`/dashboard/${(result.payload as { id: string }).id}`);
    });
  };

  const deleteSpace = (id: string): void => {
    void dispatch(deleteDashboard(id));
    if (id === activeId) {
      const next = list.find((d) => d.id !== id);
      if (next) navigate(`/dashboard/${next.id}`);
    }
  };

  return (
    <>
      <Box onMouseEnter={() => setOpen(true)} sx={{ position: 'fixed', top: 0, left: 0, right: 0, height: HOT_ZONE_PX, zIndex: 99998 }} />
      <Box
        ref={barRef}
        sx={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
          pt: 2, pb: 1.75,
          background: 'rgba(22,20,26,0.45)',
          backdropFilter: 'blur(30px) saturate(150%)',
          WebkitBackdropFilter: 'blur(30px) saturate(150%)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          transform: open ? 'translateY(0)' : 'translateY(-110%)',
          transition: 'transform 260ms cubic-bezier(0.22,1,0.36,1)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <Box
          ref={strip.scrollRef}
          data-spaces-rail
          sx={{
            position: 'relative',
            display: 'flex', alignItems: 'flex-start', gap: 2.25, px: 3,
            // The active/hover ring is a box-shadow OUTSIDE the tile, so the clipping scroll box needs breathing room or the ring's top edge gets sheared off (the "Dashboard 1 looks cut off" report).
            py: '4px',
            // "safe center" centers a short row but falls back to start-aligned once it overflows, so tile one is never clipped out of reach.
            justifyContent: 'safe center',
            overflowX: 'auto', overflowY: 'hidden', userSelect: 'none',
            cursor: strip.dragging ? 'grabbing' : 'default',
            scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
          }}
        >
          {list.map((d) => {
            const active = d.id === activeId;
            const renaming = renamingId === d.id;
            return (
              <Box
                key={d.id}
                component="button"
                {...{ [ACTIVE_TILE_ATTR]: active ? 'true' : 'false' }}
                onClick={() => { if (!renaming) { navigate(`/dashboard/${d.id}`); setOpen(false); } }}
                onContextMenu={(e: React.MouseEvent) => openCardContextMenu(e, {
                  items: [
                    { label: 'Rename', onClick: () => { setRenameValue(d.name || 'Untitled'); setRenamingId(d.id); } },
                    { label: 'Duplicate', onClick: () => duplicateSpace(d.id) },
                    { kind: 'separator' },
                    { label: 'Delete', danger: true, disabled: list.length <= 1, onClick: () => deleteSpace(d.id) },
                  ],
                })}
                sx={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, flexShrink: 0,
                  p: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                  '&:hover .osw-space-tile': { boxShadow: '0 0 0 3px rgba(255,255,255,0.65), 0 10px 26px rgba(0,0,0,0.4)' },
                }}
              >
                <Box
                  className="osw-space-tile"
                  sx={{
                    width: TILE_W, height: TILE_H, borderRadius: '10px', overflow: 'hidden',
                    background: 'rgba(255,255,255,0.08)',
                    boxShadow: active
                      ? '0 0 0 3px rgba(255,255,255,0.9), 0 10px 26px rgba(0,0,0,0.4)'
                      : '0 0 0 1px rgba(255,255,255,0.14), 0 8px 20px rgba(0,0,0,0.35)',
                    transition: 'box-shadow 140ms',
                  }}
                >
                  {d.thumbnail ? (
                    <Box component="img" src={d.thumbnail} alt="" draggable={false} sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  ) : (
                    <Box sx={{ width: '100%', height: '100%', background: 'linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05))' }} />
                  )}
                </Box>
                {renaming ? (
                  <Box
                    component="input"
                    autoFocus
                    value={renameValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitRename(d.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => commitRename(d.id)}
                    sx={{
                      width: TILE_W - 24, textAlign: 'center', border: '1px solid rgba(255,255,255,0.35)',
                      borderRadius: '6px', background: 'rgba(0,0,0,0.35)', outline: 'none', userSelect: 'text',
                      color: 'rgba(255,255,255,0.95)', fontFamily: 'inherit', fontSize: '0.8125rem', py: 0.2,
                    }}
                  />
                ) : (
                  <Typography sx={{ color: 'rgba(255,255,255,0.92)', fontSize: '0.8125rem', fontWeight: active ? 600 : 500, maxWidth: TILE_W, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.name || 'Untitled'}
                  </Typography>
                )}
              </Box>
            );
          })}
          <Box
            component="button"
            aria-label="New dashboard"
            onClick={addSpace}
            sx={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 64, height: TILE_H, borderRadius: '10px', cursor: 'pointer',
              border: '1.5px dashed rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.85)', flexShrink: 0,
              transition: 'background 140ms, border-color 140ms',
              '&:hover': { background: 'rgba(255,255,255,0.14)', borderColor: 'rgba(255,255,255,0.6)' },
            }}
          >
            <Plus size={22} />
          </Box>
        </Box>
        <StripEdge side="left" visible={strip.overflowing && !strip.atStart} onNudge={() => strip.scrollByPage(-1)} />
        <StripEdge side="right" visible={strip.overflowing && !strip.atEnd} onNudge={() => strip.scrollByPage(1)} />
      </Box>
    </>
  );
};

export default SpacesStrip;
