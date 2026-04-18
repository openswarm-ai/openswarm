import React, { useState, useRef, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DashboardIcon from '@mui/icons-material/Dashboard';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import LanguageIcon from '@mui/icons-material/Language';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { AgentSession } from '@/shared/state/agentsSlice';
import type { CardPosition, ViewCardPosition, BrowserCardPosition } from '@/shared/state/dashboardLayoutSlice';
import type { App } from '@/shared/backend-bridge/apps/app_builder';
import type { CanvasActions } from '@/app/pages/Dashboard/types/types';
import { STATUS_DOT, cleanUrl, CategoryGroup, ItemRow } from './DashboardHeaderParts';

interface DashboardHeaderProps {
  dashboardName: string | undefined;
  sessions: Record<string, AgentSession>;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  outputs: Record<string, App>;
  dashboardId: string | undefined;
  canvasActions: CanvasActions;
  onHighlightCard?: (cardId: string) => void;
}

const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  dashboardName,
  sessions,
  cards,
  viewCards,
  browserCards,
  outputs,
  dashboardId,
  canvasActions,
  onHighlightCard,
}) => {
  const c = useClaudeTokens();
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
      return { id: vc.output_id, name: output.name, card: vc };
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
      canvasActions.fitToCards([card], 1.0, true);
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
          gap: 1,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: expanded ? `${c.radius.lg}px ${c.radius.lg}px 0 0` : `${c.radius.lg}px`,
          boxShadow: c.shadow.sm,
          py: 0.75,
          px: 1.5,
          cursor: hasItems ? 'pointer' : 'default',
          userSelect: 'none',
          transition: 'border-radius 0.2s',
          '&:hover': hasItems ? { bgcolor: c.bg.secondary } : {},
        }}
      >
        <DashboardIcon sx={{ fontSize: 'small', color: c.accent.primary }} />
        <Typography
          sx={{
            fontSize: '0.9rem',
            fontWeight: 600,
            color: c.text.primary,
            lineHeight: 1,
          }}
        >
          {dashboardName || 'Dashboard'}
        </Typography>
        {hasItems && (
          <KeyboardArrowDownIcon
            sx={{
              fontSize: 18,
              color: c.text.tertiary,
              transition: 'transform 0.2s',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              ml: 0.25,
            }}
          />
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
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.medium}`,
              borderTop: 'none',
              borderRadius: `0 0 ${c.radius.lg}px ${c.radius.lg}px`,
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
                      {item.status.replace('_', ' ')}
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

export default DashboardHeader;
