import React, { useState, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import LanguageIcon from '@mui/icons-material/Language';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  reorderBrowserTab, setActiveBrowserTab, addBrowserTab,
  removeBrowserTab, removeBrowserCard, type BrowserTab,
} from '@/shared/state/dashboardLayoutSlice';
import type { TabLocalState } from '../TabLocalState';

interface BrowserTabBarProps {
  tabs: BrowserTab[];
  activeTabId: string;
  browserId: string;
  tabLocalStates: Record<string, TabLocalState>;
  accentColor: string;
  agentActive: boolean;
  isDragging: boolean;
  onDragPointerDown: (e: React.PointerEvent) => void;
  onDragPointerMove: (e: React.PointerEvent) => void;
  onDragPointerUp: (e: React.PointerEvent) => void;
}

const BrowserTabBar: React.FC<BrowserTabBarProps> = ({
  tabs, activeTabId, browserId, tabLocalStates, accentColor, agentActive,
  isDragging, onDragPointerDown, onDragPointerMove, onDragPointerUp,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const browserHomepage = useAppSelector((state) => state.settings.data.browser_homepage);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const handleSwitchTab = useCallback((tabId: string) => { dispatch(setActiveBrowserTab({ browserId, tabId })); }, [dispatch, browserId]);
  const handleAddTab = useCallback((e: React.MouseEvent) => { e.stopPropagation(); dispatch(addBrowserTab({ browserId, url: browserHomepage })); }, [dispatch, browserId, browserHomepage]);
  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => { e.stopPropagation(); dispatch(removeBrowserTab({ browserId, tabId })); }, [dispatch, browserId]);
  const handleRemove = useCallback((e: React.MouseEvent) => { e.stopPropagation(); dispatch(removeBrowserCard(browserId)); }, [dispatch, browserId]);

  const tabDragRef = useRef<{ tabId: string; startX: number; isDragging: boolean } | null>(null);
  const swapCooldown = useRef(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragTabOffset, setDragTabOffset] = useState(0);

  const handleTabPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const tabId = (e.currentTarget as HTMLElement).getAttribute('data-tab-id');
    if (!tabId) return;
    tabDragRef.current = { tabId, startX: e.clientX, isDragging: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleTabPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = tabDragRef.current; if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.isDragging && Math.abs(dx) < 5) return;
    drag.isDragging = true; setDragTabId(drag.tabId); setDragTabOffset(dx);
    if (swapCooldown.current) return;
    const bar = tabBarRef.current; if (!bar) return;
    const draggedEl = bar.querySelector(`[data-tab-id="${drag.tabId}"]`) as HTMLElement | null;
    if (!draggedEl) return;
    const rect = draggedEl.getBoundingClientRect();
    const center = rect.left + rect.width / 2 + dx;
    const ci = tabs.findIndex((t) => t.id === drag.tabId);
    const trySwap = (targetIdx: number) => {
      const el = bar.querySelector(`[data-tab-id="${tabs[targetIdx].id}"]`) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if ((targetIdx > ci && center > mid) || (targetIdx < ci && center < mid)) {
        dispatch(reorderBrowserTab({ browserId, tabId: drag.tabId, toIndex: targetIdx }));
        drag.startX = e.clientX; setDragTabOffset(0);
        swapCooldown.current = true;
        requestAnimationFrame(() => { swapCooldown.current = false; });
      }
    };
    if (ci < tabs.length - 1) trySwap(ci + 1);
    if (ci > 0) trySwap(ci - 1);
  }, [tabs, browserId, dispatch]);

  const handleTabPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    if (!drag.isDragging) handleSwitchTab(drag.tabId);
    tabDragRef.current = null;
    setDragTabId(null);
    setDragTabOffset(0);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, [handleSwitchTab]);

  return (
    <Box ref={tabBarRef} onPointerDown={onDragPointerDown} onPointerMove={onDragPointerMove} onPointerUp={onDragPointerUp}
      sx={{
        position: 'relative', zIndex: 16, display: 'flex', alignItems: 'stretch',
        bgcolor: agentActive ? `${accentColor}0a` : c.bg.secondary,
        borderBottom: `1px solid ${agentActive ? `${accentColor}30` : c.border.subtle}`,
        cursor: isDragging ? 'grabbing' : 'grab', flexShrink: 0, minHeight: 34, userSelect: 'none',
        transition: 'background 0.3s ease', overflow: 'hidden',
      }}
    >
      <Box sx={{ display: 'flex', flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isBeingDragged = tab.id === dragTabId;
          const tls = tabLocalStates[tab.id];
          return (
            <Box key={tab.id} data-tab-id={tab.id} onPointerDown={handleTabPointerDown}
              onPointerMove={handleTabPointerMove} onPointerUp={handleTabPointerUp}
              sx={{
                display: 'flex', alignItems: 'center', gap: 0.5, px: 1, minWidth: 0, maxWidth: 180, flex: '0 1 180px',
                position: 'relative', borderRight: `1px solid ${c.border.subtle}`,
                bgcolor: isActive ? c.bg.surface : 'transparent', cursor: isBeingDragged ? 'grabbing' : 'pointer',
                transform: isBeingDragged ? `translateX(${dragTabOffset}px)` : 'none',
                transition: isBeingDragged ? 'none' : 'background 0.15s ease, transform 0.2s ease',
                zIndex: isBeingDragged ? 10 : 1,
                '&:hover': { bgcolor: isActive ? c.bg.surface : c.bg.hover },
                '&:hover .tab-close': { opacity: 1 },
                ...(isActive && { '&::after': {
                  content: '""', position: 'absolute', bottom: 0, left: 0, right: 0, height: '2px', bgcolor: accentColor,
                } }),
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, width: 14, height: 14, justifyContent: 'center' }}>
                {tls?.loading ? (
                  <CircularProgress size={10} thickness={5} sx={{ color: accentColor }} />
                ) : tab.favicon ? (
                  <Box component="img" src={tab.favicon} sx={{ width: 14, height: 14, borderRadius: '2px' }}
                    onError={(e: any) => { e.target.style.display = 'none'; }} />
                ) : (
                  <LanguageIcon sx={{ fontSize: 13, color: isActive ? accentColor : c.text.ghost }} />
                )}
              </Box>
              <Typography sx={{
                flex: 1, fontSize: '0.7rem', fontWeight: isActive ? 600 : 400,
                color: isActive ? c.text.primary : c.text.muted,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, lineHeight: 1.2,
              }}>
                {tab.title || 'New Tab'}
              </Typography>
              <Box className="tab-close" onClick={(e: React.MouseEvent) => handleCloseTab(tab.id, e)}
                onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
                sx={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16,
                  borderRadius: '4px', flexShrink: 0, opacity: isActive ? 0.6 : 0, cursor: 'pointer',
                  transition: 'opacity 0.15s, background 0.15s', '&:hover': { bgcolor: `${c.text.muted}25`, opacity: 1 },
                }}>
                <CloseIcon sx={{ fontSize: 10, color: c.text.muted }} />
              </Box>
            </Box>
          );
        })}
        <Box onClick={handleAddTab} onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
          sx={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, flexShrink: 0,
            cursor: 'pointer', borderRadius: '4px', mx: 0.25, my: 0.5,
            transition: 'background 0.15s', '&:hover': { bgcolor: `${c.text.muted}15` },
          }}>
          <AddIcon sx={{ fontSize: 15, color: c.text.muted }} />
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 0.5, flexShrink: 0 }}>
        {agentActive && (
          <Box sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 0.75, py: 0.25, borderRadius: '6px',
            bgcolor: `${accentColor}18`, border: `1px solid ${accentColor}30`,
            animation: 'badge-fade-in 0.25s ease-out',
            '@keyframes badge-fade-in': { '0%': { opacity: 0, transform: 'scale(0.85)' }, '100%': { opacity: 1, transform: 'scale(1)' } },
          }}>
            <Box sx={{
              width: 6, height: 6, borderRadius: '50%', bgcolor: accentColor,
              animation: 'badge-dot-pulse 1.4s ease-in-out infinite',
              '@keyframes badge-dot-pulse': { '0%, 100%': { opacity: 0.5, transform: 'scale(0.8)' }, '50%': { opacity: 1, transform: 'scale(1.3)' } },
            }} />
            <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: accentColor, lineHeight: 1 }}>AI</Typography>
          </Box>
        )}
        <Tooltip title="Close browser" placement="top">
          <IconButton size="small" onClick={handleRemove} onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.ghost, p: 0.4, '&:hover': { color: c.status.error } }}>
            <CloseIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default BrowserTabBar;
