import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { KeyBadge, SectionHeader } from './shared/CommandsHelpers';
import { Shortcut, SHORTCUTS } from './shared/commandsTypes';

interface ShortcutsSectionProps {
  navShortcuts: Shortcut[];
  actionShortcuts: Shortcut[];
  c: any;
}

const ShortcutsSection: React.FC<ShortcutsSectionProps> = ({ navShortcuts, actionShortcuts, c }) => (
  <Box>
    <SectionHeader
      icon={<KeyboardIcon sx={{ fontSize: 22 }} />}
      title="Keyboard Shortcuts"
      subtitle="Press ? anywhere to see the quick-reference dialog"
      count={SHORTCUTS.length}
      c={c}
    />

    <Box sx={{ display: 'flex', gap: 4 }}>
      <Box sx={{ flex: 1 }}>
        <Typography
          sx={{
            color: c.text.tertiary,
            fontSize: '0.7rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 1,
            mb: 1.5,
            px: 1,
          }}
        >
          Navigation
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {navShortcuts.map((s) => (
            <Box
              key={s.key}
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                px: 1.5,
                py: 1,
                borderRadius: 2,
                '&:hover': { bgcolor: `${c.accent.primary}06` },
                transition: 'background-color 0.15s',
              }}
            >
              <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>
                {s.description}
              </Typography>
              <KeyBadge keys={s.key} c={c} />
            </Box>
          ))}
        </Box>
      </Box>

      <Box sx={{ flex: 1 }}>
        <Typography
          sx={{
            color: c.text.tertiary,
            fontSize: '0.7rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 1,
            mb: 1.5,
            px: 1,
          }}
        >
          Actions
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {actionShortcuts.map((s) => (
            <Box
              key={s.key}
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                px: 1.5,
                py: 1,
                borderRadius: 2,
                '&:hover': { bgcolor: `${c.accent.primary}06` },
                transition: 'background-color 0.15s',
              }}
            >
              <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>
                {s.description}
              </Typography>
              <KeyBadge keys={s.key} c={c} />
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  </Box>
);

export default ShortcutsSection;
