import React, { useState, useRef, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import LanguageIcon from '@mui/icons-material/Language';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch } from '@/shared/hooks';
import DashboardGlyph from './DashboardGlyph';
import ShareButton from '@/app/components/share/ShareButton';
import type { AgentSession } from '@/shared/state/agentsSlice';
import { saveLayout, viewCardKey } from '@/shared/state/dashboardLayoutSlice';
import type { CardPosition, ViewCardPosition, BrowserCardPosition, NotePosition, WorkflowCardPosition, WorkflowsHubPosition } from '@/shared/state/dashboardLayoutSlice';
import type { Output } from '@/shared/state/outputsSlice';
import type { CanvasActions } from '../hooks/interaction/useCanvasControls';
import { friendlyStatusLabel } from '@/shared/statusLabel';

interface DashboardHeaderProps {
  dashboardName: string | undefined;
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  workflowCards: Record<string, WorkflowCardPosition>;
  workflowsHub: WorkflowsHubPosition | null;
  notes: Record<string, NotePosition>;
  expandedSessionIds: string[];
  outputs: Record<string, Output>;
  dashboardId: string | undefined;
  canvasActions: CanvasActions;
  onHighlightCard?: (cardId: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  running: '#22c55e',
  waiting_approval: '#f59e0b',
  completed: '#94a3b8',
  error: '#ef4444',
  stopped: '#94a3b8',
  draft: '#6366f1',
};

const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  dashboardName,
  sessions,
  cards,
  viewCards,
  browserCards,
  workflowCards,
  workflowsHub,
  notes,
  expandedSessionIds,
  outputs,
  dashboardId,
  canvasActions,
  onHighlightCard,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const agentItems = Object.values(cards)
    .map((card) => {
      const session = sessions[card.session_id];
      if (!session || session.status === 'draft') return null;
      return { id: card.session_id, name: session.name, status: session.status, model: session.model, card };
    })
    .filter(Boolean) as Array<{ id: string; name: string; status: string; model: string; card: CardPosition }>;

  const viewItems = Object.values(viewCards)
    .map((vc) => {
      const output = outputs[vc.output_id];
      if (!output) return null;
      const label = (vc.instance ?? 1) > 1 ? `${output.name} #${vc.instance}` : output.name;
      return { id: viewCardKey(vc.output_id, vc.instance), name: label, card: vc };
    })
    .filter(Boolean) as Array<{ id: string; name: string; card: ViewCardPosition }>;

  const browserItems = Object.values(browserCards).map((bc) => {
    const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId);
    return {
      id: bc.browser_id,
      title: activeTab?.title || 'New Tab',
      url: activeTab?.url || bc.url,
      card: bc,
    };
  });

  const hasItems = agentItems.length > 0 || viewItems.length > 0 || browserItems.length > 0;

  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [expanded]);

  const handleFocus = useCallback(
    (cardId: string, card: { x: number; y: number; width: number; height: number }) => {
      canvasActions.fitToCards([card], 1.15, true);
      onHighlightCard?.(cardId);
      setExpanded(false);
    },
    [canvasActions, onHighlightCard],
  );

  const toggle = useCallback(() => {
    if (hasItems) setExpanded((v) => !v);
  }, [hasItems]);

  return (
    <Box ref={containerRef} sx={{ position: 'relative', display: 'inline-flex', flexDirection: 'column' }}>
      <Box
        onClick={toggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          // macOS-toolbar vibrancy: a faint translucent material + blur so the title stays legible over the dot grid without a hard box.
          bgcolor: expanded ? c.bg.surface : `${c.bg.surface}40`,
          backdropFilter: 'blur(16px) saturate(180%)',
          WebkitBackdropFilter: 'blur(16px) saturate(180%)',
          borderRadius: '6px',
          py: 0.5,
          px: 0.75,
          cursor: hasItems ? 'pointer' : 'default',
          userSelect: 'none',
          transition: 'background-color 0.12s ease',
          '&:hover': hasItems ? { bgcolor: `${c.bg.surface}99` } : {},
        }}
      >
        <Box sx={{ display: 'flex', flexShrink: 0 }}>
          <DashboardGlyph name={dashboardName} size={16} />
        </Box>
        <Typography
          noWrap
          sx={{
            fontSize: '0.9rem',
            fontWeight: 600,
            color: c.text.primary,
            lineHeight: 1,
            maxWidth: 320,
          }}
        >
          {dashboardName || 'Dashboard'}
        </Typography>
        {hasItems && (
          <KeyboardArrowDownIcon
            sx={{
              fontSize: 18,
              color: c.text.tertiary,
              transition: 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              ml: 0.25,
            }}
          />
        )}
        {dashboardId && (
          <Box sx={{ ml: 0.25, display: 'flex' }}>
            <ShareButton
              target={{ kind: 'dashboard', id: dashboardId, name: dashboardName || 'Dashboard' }}
              iconFontSize={15}
              onOpen={() => {
                // Layout saves are debounced, so a just-added app/agent card may not be on disk yet. The export reads disk, flush the live layout now so Share captures the current board, not a stale one.
                if (!dashboardId) return;
                dispatch(saveLayout({ dashboardId, cards, viewCards, browserCards, workflowCards, workflowsHub, notes, expandedSessionIds }));
              }}
            />
          </Box>
        )}
      </Box>

      {/* Dropdown overlay */}
      {hasItems && (
        <Box
          sx={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 100,
            minWidth: 280,
            maxWidth: 360,
            maxHeight: expanded ? 400 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.25s ease-in-out',
          }}
        >
          <Box
            sx={{
              mt: 0.5,
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.medium}`,
              borderRadius: `${c.radius.lg}px`,
              boxShadow: c.shadow.md,
              py: 0.75,
              overflowY: 'auto',
              maxHeight: 380,
            }}
          >
            {agentItems.length > 0 && (
              <CategoryGroup icon={<SmartToyOutlinedIcon />} label="Agents" count={agentItems.length} c={c}>
                {agentItems.map((item) => (
                  <ItemRow key={item.id} onClick={() => handleFocus(item.id, item.card)} c={c}>
                    <Box
                      sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        bgcolor: STATUS_DOT[item.status] || c.text.tertiary,
                        flexShrink: 0,
                        mt: '1px',
                      }}
                    />
                    <Typography
                      noWrap
                      sx={{ fontSize: '0.8rem', color: c.text.primary, flex: 1, minWidth: 0 }}
                    >
                      {item.name}
                    </Typography>
                    <Typography
                      sx={{ fontSize: '0.7rem', color: c.text.ghost, flexShrink: 0 }}
                    >
                      {friendlyStatusLabel(item.status)}
                    </Typography>
                  </ItemRow>
                ))}
              </CategoryGroup>
            )}

            {viewItems.length > 0 && (
              <CategoryGroup icon={<GridViewRoundedIcon />} label="Views" count={viewItems.length} c={c}>
                {viewItems.map((item) => (
                  <ItemRow key={item.id} onClick={() => handleFocus(item.id, item.card)} c={c}>
                    <Typography
                      noWrap
                      sx={{ fontSize: '0.8rem', color: c.text.primary, flex: 1, minWidth: 0 }}
                    >
                      {item.name}
                    </Typography>
                  </ItemRow>
                ))}
              </CategoryGroup>
            )}

            {browserItems.length > 0 && (
              <CategoryGroup icon={<LanguageIcon />} label="Browsers" count={browserItems.length} c={c}>
                {browserItems.map((item) => (
                  <ItemRow key={item.id} onClick={() => handleFocus(item.id, item.card)} c={c}>
                    <Typography
                      noWrap
                      sx={{ fontSize: '0.8rem', color: c.text.primary, flex: 1, minWidth: 0 }}
                    >
                      {item.title}
                    </Typography>
                    <Typography
                      noWrap
                      sx={{ fontSize: '0.68rem', color: c.text.ghost, maxWidth: 120, flexShrink: 0 }}
                    >
                      {cleanUrl(item.url)}
                    </Typography>
                  </ItemRow>
                ))}
              </CategoryGroup>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};

function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

const CategoryGroup: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  c: ReturnType<typeof useClaudeTokens>;
  children: React.ReactNode;
}> = ({ icon, label, count, c, children }) => (
  <Box sx={{ '&:not(:first-of-type)': { borderTop: `1px solid ${c.border.subtle}`, mt: 0.5, pt: 0.5 } }}>
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.5,
        py: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', color: c.text.tertiary, '& > svg': { fontSize: 15 } }}>{icon}</Box>
      <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost }}>
        {count}
      </Typography>
    </Box>
    {children}
  </Box>
);

const ItemRow: React.FC<{
  onClick: () => void;
  c: ReturnType<typeof useClaudeTokens>;
  children: React.ReactNode;
}> = ({ onClick, c, children }) => (
  <Box
    onClick={onClick}
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 0.75,
      px: 1.5,
      pl: 3.25,
      py: 0.4,
      cursor: 'pointer',
      borderRadius: 0.5,
      mx: 0.5,
      '&:hover': { bgcolor: c.bg.secondary },
      transition: 'background-color 0.1s',
    }}
  >
    {children}
  </Box>
);

export default React.memo(DashboardHeader);
