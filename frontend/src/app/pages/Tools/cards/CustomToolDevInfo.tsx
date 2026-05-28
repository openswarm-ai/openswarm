import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const CustomToolDevInfo: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const c = useClaudeTokens();
  return (
                            <Box sx={{ mt: 2, pt: 1.5, borderTop: `1px solid ${c.border.subtle}`, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                              <Typography sx={{ color: c.text.muted, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                Developer Info
                              </Typography>
                              <Box sx={{ bgcolor: c.bg.page, borderRadius: 1.5, border: `1px solid ${c.border.subtle}`, px: 1.5, py: 1 }}>
                                <Typography sx={{ color: c.text.ghost, fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', mb: 0.5 }}>
                                  MCP Config
                                </Typography>
                                <Typography component="pre" sx={{ color: c.text.muted, fontSize: '0.75rem', fontFamily: c.font.mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all', m: 0, lineHeight: 1.5 }}>
                                  {JSON.stringify(tool.mcp_config, null, 2)}
                                </Typography>
                              </Box>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Auth type:</Typography>
                                  <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontFamily: c.font.mono }}>{tool.auth_type || 'none'}</Typography>
                                </Box>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Status:</Typography>
                                  <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontFamily: c.font.mono }}>{tool.auth_status || 'none'}</Typography>
                                </Box>
                                {tool.connected_account_email && (
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Account:</Typography>
                                    <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontFamily: c.font.mono }}>{tool.connected_account_email}</Typography>
                                  </Box>
                                )}
                              </Box>
                              {tool.credentials && Object.keys(tool.credentials).length > 0 && (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                                  <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Credentials:</Typography>
                                  {Object.keys(tool.credentials).map((key) => (
                                    <Chip key={key} label={`${key}: configured`} size="small" sx={{ bgcolor: `${c.status.success}12`, color: c.status.success, fontSize: '0.65rem', height: 18, fontFamily: c.font.mono, '& .MuiChip-label': { px: 0.6 } }} />
                                  ))}
                                </Box>
                              )}
                            </Box>
  );
};

export default CustomToolDevInfo;
