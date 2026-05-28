import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Switch from '@mui/material/Switch';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';

interface IntegrationGalleryCardProps {
  integration: Integration;
  isLoading: boolean;
  onToggle: (integration: Integration) => void;
}

const IntegrationGalleryCard: React.FC<IntegrationGalleryCardProps> = ({ integration: ig, isLoading, onToggle: handleIntegrationToggle }) => {
  const c = useClaudeTokens();
  return (
                  <Card
                    key={ig.id}
                    sx={{ order: 2, bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, transition: 'border-color 0.2s, box-shadow 0.2s' }}
                  >
                    <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Box sx={{
                          width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          bgcolor: c.bg.secondary, fontSize: '1.1rem', fontWeight: 700, color: c.text.ghost,
                        }}>
                          {ig.icon}
                        </Box>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>{ig.name}</Typography>
                            <Chip component="a" href={ig.website} clickable icon={<OpenInNewIcon sx={{ fontSize: 10 }} />} label="docs" size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, fontSize: 10 } }} />
                          </Box>
                          <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>{ig.description}</Typography>
                        </Box>
                        <Box
                          data-onboarding={
                            ig.id === 'youtube'
                              ? 'actions-youtube-toggle'
                              : ig.id === 'reddit'
                                ? 'actions-reddit-toggle'
                                : undefined
                          }
                          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}
                        >
                          {isLoading && <CircularProgress size={16} sx={{ color: ig.color }} />}
                          <Switch
                            checked={false}
                            onChange={() => handleIntegrationToggle(ig)}
                            disabled={isLoading}
                            sx={{
                              '& .MuiSwitch-switchBase.Mui-checked': { color: ig.color },
                              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: ig.color },
                            }}
                          />
                        </Box>
                      </Box>
                    </CardContent>
                  </Card>
  );
};

export default IntegrationGalleryCard;
