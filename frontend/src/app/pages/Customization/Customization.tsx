import React from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import DescriptionIcon from '@mui/icons-material/Description';
import PsychologyIcon from '@mui/icons-material/Psychology';
import BuildIcon from '@mui/icons-material/Build';
import TuneIcon from '@mui/icons-material/Tune';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const PANELS = [
  {
    label: 'Prompts',
    path: '/templates',
    icon: <DescriptionIcon />,
    description:
      'Create and manage reusable prompt templates with structured input fields that your agents can fill in.',
  },
  {
    label: 'Skills',
    path: '/skills',
    icon: <PsychologyIcon />,
    description:
      'Install or author reusable skill packages that teach your agents new capabilities and workflows.',
  },
  {
    label: 'Actions',
    path: '/actions',
    icon: <BuildIcon />,
    description:
      'Define and manage the actions your agents can take.',
  },
  {
    label: 'Modes',
    path: '/modes',
    icon: <TuneIcon />,
    description:
      'Configure agent interaction modes with custom system prompts, allowed actions, and auto-switching rules.',
  },
];

const Customization: React.FC = () => {
  const c = useClaudeTokens();
  const navigate = useNavigate();

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 4 }}>
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Box sx={{ mb: 4 }}>
          <Typography variant="h4" sx={{ fontWeight: 700, color: c.text.primary }}>
            Customization
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem', mt: 0.5 }}>
            Tailor how your agents behave, what they can do, and how they interact.
          </Typography>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 2.5,
          }}
        >
          {PANELS.map((panel) => (
            <Card
              key={panel.path}
              sx={{
                bgcolor: c.bg.surface,
                border: `1px solid ${c.border.subtle}`,
                borderRadius: 2.5,
                boxShadow: c.shadow.sm,
                '&:hover': {
                  borderColor: c.accent.primary,
                  boxShadow: `0 0 0 1px ${c.accent.primary}22`,
                },
                transition: 'border-color 0.2s, box-shadow 0.2s',
              }}
            >
              <CardActionArea
                onClick={() => navigate(panel.path)}
                sx={{ p: 3, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1.5 }}
              >
                <Box
                  sx={{
                    width: 44,
                    height: 44,
                    borderRadius: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: `${c.accent.primary}12`,
                    color: c.accent.primary,
                  }}
                >
                  {React.cloneElement(panel.icon, { sx: { fontSize: 24 } })}
                </Box>
                <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1.05rem' }}>
                  {panel.label}
                </Typography>
                <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.55 }}>
                  {panel.description}
                </Typography>
              </CardActionArea>
            </Card>
          ))}
        </Box>
      </Box>
    </Box>
  );
};

export default Customization;
