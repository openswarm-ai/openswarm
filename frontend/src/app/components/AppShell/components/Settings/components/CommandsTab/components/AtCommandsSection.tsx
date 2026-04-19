import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import AlternateEmailIcon from '@mui/icons-material/AlternateEmail';
import { SectionHeader } from './shared/CommandsHelpers';
import { AtCommand } from './shared/commandsTypes';

interface AtCommandsSectionProps {
  atCommands: AtCommand[];
  c: any;
}

const AtCommandsSection: React.FC<AtCommandsSectionProps> = ({ atCommands, c }) => (
  <Box>
    <SectionHeader
      icon={<AlternateEmailIcon sx={{ fontSize: 22 }} />}
      title="@ Context Commands"
      subtitle="Type @ in chat to attach context and activate actions"
      count={atCommands.length}
      c={c}
    />

    {atCommands.length === 0 ? (
      <Box
        sx={{
          py: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          color: c.text.ghost,
        }}
      >
        <AlternateEmailIcon sx={{ fontSize: 36, opacity: 0.3 }} />
        <Typography sx={{ fontSize: '0.85rem' }}>
          No @ commands yet. Install MCP actions to see them here.
        </Typography>
      </Box>
    ) : (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {atCommands.map((cmd) => (
          <Box
            key={cmd.prefix}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              pl: cmd.isChild ? 5 : 2,
              pr: 2,
              py: cmd.isChild ? 0.875 : 1.25,
              borderRadius: 2,
              '&:hover': { bgcolor: `${c.accent.primary}06` },
              transition: 'background-color 0.15s',
            }}
          >
            <Box sx={{ color: c.accent.primary, display: 'flex', opacity: cmd.isChild ? 0.6 : 1 }}>
              {cmd.icon}
            </Box>
            <Typography
              sx={{
                color: c.text.primary,
                fontSize: cmd.isChild ? '0.8rem' : '0.85rem',
                fontFamily: c.font.mono,
                fontWeight: 500,
                minWidth: 140,
              }}
            >
              {cmd.prefix}
            </Typography>
            <Chip
              label={cmd.source}
              size="small"
              sx={{
                height: 20,
                fontSize: '0.65rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                bgcolor: cmd.source === 'builtin' ? `${c.accent.primary}12` : cmd.source === 'view' ? '#f472b615' : `${c.status.info}15`,
                color: cmd.source === 'builtin' ? c.accent.primary : cmd.source === 'view' ? '#f472b6' : c.status.info,
              }}
            />
            <Typography
              sx={{
                color: c.text.muted,
                fontSize: '0.8rem',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {cmd.description}
            </Typography>
          </Box>
        ))}
      </Box>
    )}
  </Box>
);

export default AtCommandsSection;
