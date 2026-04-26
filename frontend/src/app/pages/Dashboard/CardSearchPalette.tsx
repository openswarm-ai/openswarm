import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import Typography from '@mui/material/Typography';
import SearchIcon from '@mui/icons-material/Search';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { CardPosition, ViewCardPosition, BrowserCardPosition } from '@/shared/state/dashboardLayoutSlice';
import type { AgentSession } from '@/shared/state/agentsSlice';

interface CardSearchItem {
  id: string;
  label: string;
  type: 'agent' | 'view' | 'browser';
  rect: { x: number; y: number; width: number; height: number };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigate: (rect: { x: number; y: number; width: number; height: number }) => void;
  cards: Record<string, CardPosition>;
  viewCards: Record<string, ViewCardPosition>;
  browserCards: Record<string, BrowserCardPosition>;
  sessions: Record<string, AgentSession>;
}

const CardSearchPalette: React.FC<Props> = ({
  open, onClose, onNavigate,
  cards, viewCards, browserCards, sessions,
}) => {
  const c = useClaudeTokens();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build searchable items
  const items = useMemo((): CardSearchItem[] => {
    const result: CardSearchItem[] = [];
    for (const card of Object.values(cards)) {
      const session = sessions[card.session_id];
      result.push({
        id: card.session_id,
        label: session?.name || `Agent ${card.session_id.slice(0, 8)}`,
        type: 'agent',
        rect: { x: card.x, y: card.y, width: card.width, height: card.height },
      });
    }
    for (const vc of Object.values(viewCards)) {
      result.push({
        id: vc.output_id,
        label: `View: ${vc.output_id.slice(0, 12)}`,
        type: 'view',
        rect: { x: vc.x, y: vc.y, width: vc.width, height: vc.height },
      });
    }
    for (const bc of Object.values(browserCards)) {
      const activeTab = bc.tabs.find((t) => t.id === bc.activeTabId);
      result.push({
        id: bc.browser_id,
        label: activeTab?.title || activeTab?.url || `Browser ${bc.browser_id.slice(0, 8)}`,
        type: 'browser',
        rect: { x: bc.x, y: bc.y, width: bc.width, height: bc.height },
      });
    }
    return result;
  }, [cards, viewCards, browserCards, sessions]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSelect = useCallback((item: CardSearchItem) => {
    onNavigate(item.rect);
    onClose();
  }, [onNavigate, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        handleSelect(filtered[selectedIndex]);
      }
    }
  }, [filtered, selectedIndex, handleSelect, onClose]);

  if (!open) return null;

  const typeLabel = (type: string) => {
    switch (type) {
      case 'agent': return 'Agent';
      case 'view': return 'View';
      case 'browser': return 'Browser';
      default: return type;
    }
  };

  const typeColor = (type: string) => {
    switch (type) {
      case 'agent': return c.accent.primary;
      case 'view': return c.status.info;
      case 'browser': return c.status.success;
      default: return c.text.muted;
    }
  };

  return (
    <>
      {/* Backdrop */}
      <Box
        onClick={onClose}
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          bgcolor: 'rgba(0,0,0,0.2)',
        }}
      />

      {/* Palette */}
      <Box
        sx={{
          position: 'fixed',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 440,
          maxHeight: 400,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: c.shadow.lg,
          zIndex: 1001,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 1.5, borderBottom: `1px solid ${c.border.subtle}` }}>
          <SearchIcon sx={{ fontSize: '1.25rem', color: c.text.muted, mr: 1.5 }} />
          <InputBase
            inputRef={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards..."
            fullWidth
            sx={{
              fontSize: '0.9375rem',
              fontFamily: c.font.sans,
              color: c.text.primary,
              '& input::placeholder': { color: c.text.muted, opacity: 1 },
            }}
          />
        </Box>

        {/* Results */}
        <Box sx={{ overflowY: 'auto', maxHeight: 320 }}>
          {filtered.length === 0 ? (
            <Typography sx={{ px: 2, py: 2, fontSize: '0.875rem', color: c.text.muted, textAlign: 'center' }}>
              No cards found
            </Typography>
          ) : (
            filtered.map((item, i) => (
              <Box
                key={item.id}
                onClick={() => handleSelect(item)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  px: 2,
                  py: 1,
                  cursor: 'pointer',
                  bgcolor: i === selectedIndex ? c.bg.secondary : 'transparent',
                  '&:hover': { bgcolor: c.bg.secondary },
                }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: typeColor(item.type),
                    flexShrink: 0,
                  }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontSize: '0.875rem',
                      fontWeight: 500,
                      color: c.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.label}
                  </Typography>
                </Box>
                <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, flexShrink: 0 }}>
                  {typeLabel(item.type)}
                </Typography>
              </Box>
            ))
          )}
        </Box>
      </Box>
    </>
  );
};

export default CardSearchPalette;
