import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
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
                    sx={{ bgcolor: 'transparent', border: 'none', borderRadius: 0, boxShadow: 'none', borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' }, '&:hover': { bgcolor: c.bg.elevated }, transition: 'background-color 0.12s' }}
                  >
                    <CardContent sx={{ py: 1.4, px: 2, '&:last-child': { pb: 1.4 } }}>
                      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px 200px', alignItems: 'center', gap: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
                          <Box sx={{
                            width: 34, height: 34, borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface, fontSize: '1.125rem', fontWeight: 700, color: c.text.ghost,
                          }}>
                            {ig.icon}
                          </Box>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.9375rem', mb: 0.25 }}>{ig.name}</Typography>
                            <Typography noWrap sx={{ color: c.text.muted, fontSize: '0.8125rem' }}>{ig.description}</Typography>
                            <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mt: 0.25 }}>
                              <Box component="a" href={ig.website} target="_blank" rel="noreferrer" sx={{ color: c.text.ghost, textDecoration: 'none', '&:hover': { color: c.text.secondary, textDecoration: 'underline' } }}>
                                docs<OpenInNewIcon sx={{ fontSize: 10, ml: 0.25, verticalAlign: 'middle' }} />
                              </Box>
                            </Typography>
                          </Box>
                        </Box>
                        <Typography sx={{ color: c.text.secondary, fontSize: '0.8125rem' }}>MCP</Typography>
                        <Box
                          data-onboarding={
                            ig.id === 'youtube'
                              ? 'actions-youtube-toggle'
                              : ig.id === 'reddit'
                                ? 'actions-reddit-toggle'
                                : undefined
                          }
                          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.75 }}
                        >
                          {isLoading && <CircularProgress size={16} sx={{ color: ig.color }} />}
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={isLoading}
                            onClick={() => handleIntegrationToggle(ig)}
                            sx={{
                              textTransform: 'none', fontSize: '0.8125rem', fontWeight: 600, px: 1.75, py: 0.4,
                              color: c.text.primary, borderColor: c.border.medium, borderRadius: 999,
                              '&:hover': { borderColor: c.border.strong, bgcolor: c.bg.elevated },
                            }}
                          >
                            Connect
                          </Button>
                        </Box>
                      </Box>
                    </CardContent>
                  </Card>
  );
};

export default IntegrationGalleryCard;
