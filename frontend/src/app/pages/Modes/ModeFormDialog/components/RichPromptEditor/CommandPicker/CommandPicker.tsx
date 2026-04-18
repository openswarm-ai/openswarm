import React, { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { CommandPickerItem, CommandPickerProps, highlightMatch } from './components/commandPickerTypes';
import { useCommandPickerItems } from './components/useCommandPickerItems';

const CommandPicker: React.FC<CommandPickerProps> = ({ trigger, filter, onSelect, onClose, visible }) => {
  const c = useClaudeTokens();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, flatItems, modesMap } = useCommandPickerItems(trigger, filter);

  const getIconColor = (item: CommandPickerItem): string => {
    switch (item.type) {
      case 'skill': return c.status.success;
      case 'mode': {
        const mode = modesMap[item.id];
        return mode?.color || c.accent.primary;
      }
      case 'context': return c.text.tertiary;
      default: return c.text.tertiary;
    }
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter, trigger]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-picker-idx="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((p) => (p < items.length - 1 ? p + 1 : p));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((p) => (p > 0 ? p - 1 : p));
          break;
        case 'Enter':
        case 'Tab':
          if (items[selectedIndex]) {
            e.preventDefault();
            onSelect(items[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, items, selectedIndex, onSelect, onClose]);

  if (!visible || items.length === 0) return null;

  return (
    <Paper
      ref={containerRef}
      elevation={0}
      sx={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        mb: 0.5,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: '12px',
        maxHeight: 320,
        overflow: 'auto',
        zIndex: 1000,
        boxShadow: c.shadow.lg,
        animation: 'cmdPickerIn 120ms ease-out',
        '@keyframes cmdPickerIn': {
          from: { opacity: 0, transform: 'translateY(4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        '&::-webkit-scrollbar': { width: 4 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': {
          background: c.border.medium,
          borderRadius: 2,
          '&:hover': { background: c.border.strong },
        },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}
    >
      <Box sx={{ py: 0.5 }}>
        {flatItems.map(({ item, isGroupStart, category }, idx) => (
          <React.Fragment key={`${item.type}-${item.id}`}>
            {isGroupStart && (
              <Box sx={{ px: 1.5, pt: idx === 0 ? 0.75 : 1.25, pb: 0.375 }}>
                <Typography
                  sx={{
                    color: c.text.ghost,
                    fontSize: '0.625rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  {category}
                </Typography>
              </Box>
            )}
            <Box
              data-picker-idx={idx}
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                py: 0.5,
                mx: 0.5,
                borderRadius: '8px',
                cursor: 'pointer',
                bgcolor: idx === selectedIndex ? `${c.accent.primary}0a` : 'transparent',
                '&:hover': { bgcolor: `${c.accent.primary}0a` },
                transition: 'background-color 60ms ease',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                  borderRadius: '6px',
                  bgcolor: `${getIconColor(item)}12`,
                  color: getIconColor(item),
                }}
              >
                {item.icon}
              </Box>
              <Typography
                component="span"
                sx={{
                  color: c.text.primary,
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  fontFamily: c.font.mono,
                  whiteSpace: 'nowrap',
                  lineHeight: 1.3,
                }}
              >
                {trigger}{highlightMatch(item.command, filter, c.accent.primary)}
              </Typography>
              <Typography
                component="span"
                sx={{
                  color: c.text.muted,
                  fontSize: '0.72rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  ml: 0.5,
                  lineHeight: 1.3,
                }}
              >
                {item.description}
              </Typography>
            </Box>
          </React.Fragment>
        ))}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 1.5,
          py: 0.625,
          borderTop: `1px solid ${c.border.subtle}`,
        }}
      >
        {[
          { keys: '↑↓', label: 'navigate' },
          { keys: '↵', label: 'select' },
          { keys: 'esc', label: 'dismiss' },
        ].map(({ keys, label }) => (
          <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.375 }}>
            <Typography
              sx={{
                fontSize: '0.58rem',
                fontFamily: c.font.mono,
                color: c.text.ghost,
                bgcolor: c.bg.secondary,
                px: 0.5,
                py: 0.125,
                borderRadius: '3px',
                border: `1px solid ${c.border.subtle}`,
                lineHeight: 1.3,
              }}
            >
              {keys}
            </Typography>
            <Typography sx={{ fontSize: '0.58rem', color: c.text.ghost }}>
              {label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
};

export default CommandPicker;
