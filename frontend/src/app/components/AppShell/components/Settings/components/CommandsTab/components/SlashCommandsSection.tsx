import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import { SectionHeader } from './shared/CommandsHelpers';
import { SlashCommand } from './shared/commandsTypes';

interface SlashCommandsSectionProps {
  slashCommands: SlashCommand[];
  modesMap: Record<string, { color: string }>;
  c: any;
}

const SlashCommandsSection: React.FC<SlashCommandsSectionProps> = ({ slashCommands, modesMap, c }) => (
  <Box>
    <SectionHeader
      icon={<TerminalIcon sx={{ fontSize: 22 }} />}
      title="Slash Commands"
      subtitle="Type / in chat to invoke skills and modes"
      count={slashCommands.length}
      c={c}
    />

    {slashCommands.length === 0 ? (
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
        <TerminalIcon sx={{ fontSize: 36, opacity: 0.3 }} />
        <Typography sx={{ fontSize: '0.85rem' }}>
          No slash commands yet. Create skills or modes to see them here.
        </Typography>
      </Box>
    ) : (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {slashCommands.map((cmd) => (
          <Box
            key={`${cmd.type}-${cmd.id}`}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              px: 2,
              py: 1.25,
              borderRadius: 2,
              '&:hover': { bgcolor: `${c.accent.primary}06` },
              transition: 'background-color 0.15s',
            }}
          >
            <Box sx={{
              color: cmd.type === 'mode' ? (modesMap[cmd.id]?.color || c.accent.primary)
                : c.status.success,
              display: 'flex',
            }}>
              {cmd.type === 'mode' ? (
                <SmartToyOutlinedIcon sx={{ fontSize: 18 }} />
              ) : (
                <PsychologyIcon sx={{ fontSize: 18 }} />
              )}
            </Box>
            <Typography
              sx={{
                color: c.text.primary,
                fontSize: '0.85rem',
                fontFamily: c.font.mono,
                fontWeight: 500,
                minWidth: 140,
              }}
            >
              /{cmd.command}
            </Typography>
            <Chip
              label={cmd.type}
              size="small"
              sx={{
                height: 20,
                fontSize: '0.65rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                bgcolor: cmd.type === 'mode' ? `${modesMap[cmd.id]?.color || c.accent.primary}15`
                  : `${c.status.success}15`,
                color: cmd.type === 'mode' ? (modesMap[cmd.id]?.color || c.accent.primary)
                  : c.status.success,
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

export default SlashCommandsSection;
