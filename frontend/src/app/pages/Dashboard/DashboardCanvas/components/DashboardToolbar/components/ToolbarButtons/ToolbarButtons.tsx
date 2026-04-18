import React from 'react';
import Box from '@mui/material/Box';
import AddIcon from '@mui/icons-material/Add';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import LanguageIcon from '@mui/icons-material/Language';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { WarmTooltip } from './WarmTooltip';

const BUTTON_SIZE = 40;

interface ToolbarButtonsProps {
  onNewAgent: () => void;
  onOpenViewPicker: () => void;
  onAddBrowser: () => void;
  onOpenHistory: () => void;
  shortcutLabel: string;
  c: ClaudeTokens;
}

const PLACEHOLDER_ITEMS = [
  { icon: StickyNote2OutlinedIcon, label: 'Add Notes', sub: 'Coming soon' },
];

export default function ToolbarButtons({
  onNewAgent, onOpenViewPicker, onAddBrowser, onOpenHistory, shortcutLabel, c,
}: ToolbarButtonsProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
      <WarmTooltip tokens={c} title={`New Agent  ${shortcutLabel}`} placement="top" arrow enterDelay={400}>
        <Box
          role="button"
          aria-label="New Agent"
          tabIndex={0}
          onClick={onNewAgent}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: `${c.radius.lg}px`,
            bgcolor: c.accent.primary,
            color: '#fff',
            cursor: 'pointer',
            transition: 'background-color 0.15s',
            '&:hover': { bgcolor: c.accent.hover },
            '&:active': { bgcolor: c.accent.pressed },
          }}
        >
          <AddIcon sx={{ fontSize: 20 }} />
        </Box>
      </WarmTooltip>

      <WarmTooltip
        tokens={c}
        placement="top"
        arrow
        enterDelay={200}
        title={
          <Box sx={{ textAlign: 'center' }}>
            <Box sx={{ fontWeight: 600 }}>Add View  ⌘M</Box>
          </Box>
        }
      >
        <Box
          role="button"
          aria-label="Add View"
          tabIndex={0}
          onClick={onOpenViewPicker}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: `${c.radius.md}px`,
            color: c.text.tertiary,
            cursor: 'pointer',
            transition: 'opacity 0.15s, background-color 0.15s',
            '&:hover': { opacity: 1, bgcolor: c.bg.secondary, color: c.accent.primary },
          }}
        >
          <GridViewRoundedIcon sx={{ fontSize: 22 }} />
        </Box>
      </WarmTooltip>

      <WarmTooltip
        tokens={c}
        placement="top"
        arrow
        enterDelay={200}
        title={
          <Box sx={{ textAlign: 'center' }}>
            <Box sx={{ fontWeight: 600 }}>Browser  ⌘N</Box>
          </Box>
        }
      >
        <Box
          role="button"
          aria-label="Browser"
          tabIndex={0}
          onClick={onAddBrowser}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: `${c.radius.md}px`,
            color: c.text.tertiary,
            cursor: 'pointer',
            transition: 'opacity 0.15s, background-color 0.15s',
            '&:hover': { opacity: 1, bgcolor: c.bg.secondary, color: c.accent.primary },
          }}
        >
          <LanguageIcon sx={{ fontSize: 22 }} />
        </Box>
      </WarmTooltip>

      <WarmTooltip
        tokens={c}
        placement="top"
        arrow
        enterDelay={200}
        title={
          <Box sx={{ textAlign: 'center' }}>
            <Box sx={{ fontWeight: 600 }}>History  ⌘O</Box>
          </Box>
        }
      >
        <Box
          role="button"
          aria-label="History"
          tabIndex={0}
          onClick={onOpenHistory}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: `${c.radius.md}px`,
            color: c.text.tertiary,
            cursor: 'pointer',
            transition: 'opacity 0.15s, background-color 0.15s',
            '&:hover': { opacity: 1, bgcolor: c.bg.secondary, color: c.accent.primary },
          }}
        >
          <HistoryRoundedIcon sx={{ fontSize: 22 }} />
        </Box>
      </WarmTooltip>

      {PLACEHOLDER_ITEMS.map(({ icon: PlaceholderIcon, label, sub }) => (
        <WarmTooltip
          key={label}
          tokens={c}
          placement="top"
          arrow
          enterDelay={200}
          title={
            <Box sx={{ textAlign: 'center' }}>
              <Box sx={{ fontWeight: 600 }}>{label}</Box>
              <Box sx={{ opacity: 0.6, fontSize: '0.7rem', mt: '1px' }}>{sub}</Box>
            </Box>
          }
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: BUTTON_SIZE,
              height: BUTTON_SIZE,
              borderRadius: `${c.radius.md}px`,
              color: c.text.tertiary,
              opacity: 0.45,
              cursor: 'default',
              transition: 'opacity 0.15s, background-color 0.15s',
              '&:hover': { opacity: 0.65, bgcolor: c.bg.secondary },
            }}
          >
            <PlaceholderIcon sx={{ fontSize: 22 }} />
          </Box>
        </WarmTooltip>
      ))}
    </div>
  );
}
