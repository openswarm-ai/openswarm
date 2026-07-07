import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Switch from '@mui/material/Switch';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import SecurityIcon from '@mui/icons-material/Security';
import PanToolIcon from '@mui/icons-material/PanTool';
import PublicIcon from '@mui/icons-material/Public';
import { BuiltinTool } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface BrowserPermissionCardProps {
  open: boolean;
  enabled: boolean;
  onToggleOpen: () => void;
  browserTools: BuiltinTool[];
  browserDelegationTools: BuiltinTool[];
  browserActionTools: BuiltinTool[];
  browserCollapsed: Record<string, boolean>;
  setBrowserCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  builtinPermissions: Record<string, string>;
  onSectionEnabledChange: (tools: BuiltinTool[], enabled: boolean) => void;
  onCategoryPermissionChange: (toolNames: string[], policy: string) => void;
  onPermissionChange: (toolName: string, policy: string) => void;
}

const BrowserPermissionCard: React.FC<BrowserPermissionCardProps> = ({
  open: browserSectionOpen,
  enabled: browserSectionEnabled,
  onToggleOpen,
  browserTools,
  browserDelegationTools,
  browserActionTools,
  browserCollapsed,
  setBrowserCollapsed,
  builtinPermissions,
  onSectionEnabledChange: handleSectionEnabledChange,
  onCategoryPermissionChange: handleBuiltinCategoryPermissionChange,
  onPermissionChange: handleBuiltinPermissionChange,
}) => {
  const c = useClaudeTokens();
  return (
        <Card sx={{ bgcolor: c.bg.surface, border: `1px solid ${browserSectionOpen && browserSectionEnabled ? c.accent.primary : c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, '&:hover': { borderColor: c.accent.primary, boxShadow: '0 0 0 1px rgba(174,86,48,0.12)' }, transition: 'border-color 0.2s, box-shadow 0.2s' }}>
          <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
            <Box
              onClick={() => browserSectionEnabled && onToggleOpen()}
              sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: browserSectionEnabled ? 'pointer' : 'default' }}
            >
              <Box sx={{
                width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                bgcolor: c.bg.secondary, color: c.text.tertiary, flexShrink: 0,
                opacity: browserSectionEnabled ? 1 : 0.4, transition: 'opacity 0.2s',
              }}>
                <PublicIcon sx={{ fontSize: 18 }} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0, opacity: browserSectionEnabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                  <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>Browser</Typography>
                  <Chip label={`${browserTools.length} tools`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 20, '& .MuiChip-label': { px: 0.6 } }} />
                </Box>
                <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>Browser automation delegation and individual browser tools</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={browserSectionEnabled}
                  onChange={(_, checked) => handleSectionEnabledChange(browserTools, checked)}
                  sx={{
                    '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
                    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
                  }}
                />
              </Box>
              {browserSectionEnabled && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                  <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: browserSectionOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                </Box>
              )}
            </Box>
          </CardContent>
          <Collapse in={browserSectionOpen && browserSectionEnabled} timeout={0} unmountOnExit>
            <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <SecurityIcon sx={{ fontSize: 14, color: c.text.muted }} />
                  <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tool Permissions</Typography>
                  <Chip label={`${browserTools.length} tools`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, ml: 0.5, '& .MuiChip-label': { px: 0.6 } }} />
                </Box>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {browserDelegationTools.length > 0 && (() => {
                  const delegationPolicies = browserDelegationTools.map((t) => builtinPermissions[t.name] || 'always_allow');
                  const groupPolicy = delegationPolicies.every((p) => p === 'always_allow') ? 'always_allow'
                    : delegationPolicies.every((p) => p === 'deny') ? 'deny'
                    : delegationPolicies.every((p) => p === 'ask') ? 'ask' : 'ask';
                  const isOpen = !browserCollapsed.browser_delegation;
                  return (
                    <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: c.border.medium } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
                        onClick={() => setBrowserCollapsed((p) => ({ ...p, browser_delegation: !p.browser_delegation }))}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                          <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>Delegation</Typography>
                          <Chip label={browserDelegationTools.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                          <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserDelegationTools.map((t) => t.name), 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: groupPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserDelegationTools.map((t) => t.name), 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: groupPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserDelegationTools.map((t) => t.name), 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: groupPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                        </Box>
                      </Box>
                      <Collapse in={isOpen} timeout={0} unmountOnExit>
                        <Box sx={{ px: 1, pb: 1 }}>
                          {browserDelegationTools.map((bt) => {
                            const toolPolicy = builtinPermissions[bt.name] || 'always_allow';
                            return (
                              <Box key={bt.name} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}>
                                <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                                  <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{bt.display_name || bt.name}</Typography>
                                  {bt.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bt.description}</Typography>}
                                </Box>
                                <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                                  <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: toolPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: toolPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: toolPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })()}

                {browserActionTools.length > 0 && (() => {
                  const actionPolicies = browserActionTools.map((t) => builtinPermissions[t.name] || 'always_allow');
                  const groupPolicy = actionPolicies.every((p) => p === 'always_allow') ? 'always_allow'
                    : actionPolicies.every((p) => p === 'deny') ? 'deny'
                    : actionPolicies.every((p) => p === 'ask') ? 'ask' : 'ask';
                  const isOpen = !browserCollapsed.browser_action;
                  return (
                    <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: c.border.medium } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
                        onClick={() => setBrowserCollapsed((p) => ({ ...p, browser_action: !p.browser_action }))}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                          <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>Browser Tools</Typography>
                          <Chip label={browserActionTools.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                          <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserActionTools.map((t) => t.name), 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: groupPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserActionTools.map((t) => t.name), 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: groupPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserActionTools.map((t) => t.name), 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: groupPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                        </Box>
                      </Box>
                      <Collapse in={isOpen} timeout={0} unmountOnExit>
                        <Box sx={{ px: 1, pb: 1 }}>
                          {browserActionTools.map((bt) => {
                            const toolPolicy = builtinPermissions[bt.name] || 'always_allow';
                            return (
                              <Box key={bt.name} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}>
                                <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                                  <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{bt.display_name || bt.name}</Typography>
                                  {bt.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bt.description}</Typography>}
                                </Box>
                                <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                                  <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: toolPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: toolPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: toolPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })()}
              </Box>
            </Box>
          </Collapse>
        </Card>
  );
};

export default BrowserPermissionCard;
