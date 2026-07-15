import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Switch from '@mui/material/Switch';
import IconButton from '@mui/material/IconButton';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import TerminalIcon from '@mui/icons-material/Terminal';
import ExtensionIcon from '@mui/icons-material/Extension';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import SettingsIcon from '@mui/icons-material/Settings';
import SecurityIcon from '@mui/icons-material/Security';
import RefreshIcon from '@mui/icons-material/Refresh';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';
import ServiceGroup from './ServiceGroup';
import CustomToolDevInfo from './CustomToolDevInfo';
import CustomToolConnect from './CustomToolConnect';

interface CustomToolCardProps {
  tool: ToolDefinition;
  ig: Integration | undefined;
  isExpanded: boolean;
  onToggleExpand: (toolId: string, isExpanded: boolean) => void;
  expandedServices: Record<string, boolean>;
  setExpandedServices: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  expandedSchema: string | null;
  setExpandedSchema: React.Dispatch<React.SetStateAction<string | null>>;
  devMode: boolean;
  integrationLoading: Record<string, boolean>;
  discovering: boolean;
  onPermissionChange: (toolId: string, toolName: string, policy: string) => void;
  onGroupPermissionChange: (toolId: string, names: string[], policy: string) => void;
  onBulkReadOnly: (toolId: string) => void;
  onResetPermissions: (toolId: string) => void;
  onDiscover: (toolId: string) => void;
  onIntegrationToggle: (integration: Integration) => void;
  onOAuthConnect: (toolId: string) => void;
  onDeviceCodeConnect: (toolId: string) => void;
  onM365Disconnect: (toolId: string) => void;
  onDisconnectIntegration: (toolId: string, integration: Integration) => void;
  onOpenCredentialsDialog: (toolId: string, integration: Integration) => void;
  onEdit: (tool: ToolDefinition) => void;
  onDelete: (toolId: string) => void;
}

const CustomToolCard: React.FC<CustomToolCardProps> = ({
  tool, ig, isExpanded, onToggleExpand,
  expandedServices, setExpandedServices, expandedSchema, setExpandedSchema,
  devMode, integrationLoading, discovering,
  onPermissionChange: handlePermissionChange,
  onGroupPermissionChange: handleGroupPermissionChange,
  onBulkReadOnly: handleBulkReadOnly,
  onResetPermissions: handleResetPermissions,
  onDiscover: handleDiscover,
  onIntegrationToggle: handleIntegrationToggle,
  onOAuthConnect: handleOAuthConnect,
  onDeviceCodeConnect: handleDeviceCodeConnect,
  onM365Disconnect: handleM365Disconnect,
  onDisconnectIntegration: handleDisconnectIntegration,
  onOpenCredentialsDialog: openCredentialsDialog,
  onEdit: openEdit,
  onDelete: handleDelete,
}) => {
  const c = useClaudeTokens();

  const isMcp = tool.mcp_config && Object.keys(tool.mcp_config).length > 0;
  const isStdio = isMcp && (tool.mcp_config.type === 'stdio' || !!tool.mcp_config.command);
  const canDiscover = isMcp;
  const perms = tool.tool_permissions || {};
  const services = perms._services as Record<string, { read?: string[]; write?: string[] }> | undefined;
  const descriptions = (perms._tool_descriptions || {}) as Record<string, string>;
  const schemas = (perms._tool_schemas || {}) as Record<string, any>;
  const serviceNames = services ? Object.keys(services) : [];
  const hasPerms = serviceNames.length > 0;
  const totalToolCount = serviceNames.reduce((acc, s) => acc + (services![s].read?.length || 0) + (services![s].write?.length || 0), 0);

  const isDisabled = tool.enabled === false;

  // Defensive Reddit detection so onboarding hooks still attach when ig.id lookup fails (legacy/manual installs).
  const isReddit =
    ig?.id === 'reddit' ||
    tool.name?.toLowerCase() === 'reddit' ||
    (tool.command || '').toLowerCase().includes('reddit');
  const isYoutube =
    ig?.id === 'youtube' ||
    tool.name?.toLowerCase() === 'youtube' ||
    (tool.command || '').toLowerCase().includes('youtube');
  return (
                  <Card
                    key={tool.id}
                    sx={{ bgcolor: c.bg.surface, border: `1px solid ${isExpanded ? c.accent.primary : c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, '&:hover': { borderColor: isDisabled ? c.border.subtle : c.accent.primary, boxShadow: isDisabled ? undefined : '0 0 0 1px rgba(174,86,48,0.12)' }, transition: 'border-color 0.2s, box-shadow 0.2s' }}
                  >
                    <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: isDisabled ? 'default' : 'pointer' }}
                        data-onboarding={isYoutube ? 'actions-youtube-chevron' : isReddit ? 'actions-reddit-chevron' : undefined}
                        onClick={() => !isDisabled && onToggleExpand(tool.id, isExpanded)}
                      >
                        {ig && (
                          <Box sx={{
                            width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            bgcolor: `${ig.color}18`, fontSize: '1.1rem', fontWeight: 700, color: ig.color, flexShrink: 0,
                            opacity: isDisabled ? 0.4 : 1, transition: 'opacity 0.2s',
                          }}>
                            {ig.icon}
                          </Box>
                        )}
                        <Box sx={{ flex: 1, minWidth: 0, opacity: isDisabled ? 0.4 : 1, transition: 'opacity 0.2s' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
                            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>{tool.name}</Typography>
                            {isMcp && <Chip icon={<ExtensionIcon sx={{ fontSize: 12 }} />} label={isStdio ? 'MCP · stdio' : 'MCP'} size="small" sx={{ bgcolor: `${c.status.warning}20`, color: c.status.warning, fontSize: '0.75rem', height: 24 }} />}
                            {tool.command && <Chip icon={<TerminalIcon sx={{ fontSize: 12 }} />} label={`/${tool.command}`} size="small" sx={{ bgcolor: 'rgba(174,86,48,0.12)', color: c.accent.hover, fontSize: '0.72rem', height: 22 }} />}
                            {tool.auth_status === 'connected' && !ig && (
                              <Chip icon={<CheckCircleIcon sx={{ fontSize: 12 }} />} label={tool.connected_account_email ? `Connected · ${tool.connected_account_email}` : 'Connected'} size="small" sx={{ bgcolor: c.status.successBg, color: c.status.success, fontSize: '0.7rem', height: 20, '& .MuiChip-icon': { color: c.status.success } }} />
                            )}
                            {tool.auth_status === 'configured' && !ig?.credentialFields && (
                              <Chip icon={<SettingsIcon sx={{ fontSize: 12 }} />} label="Configured" size="small" sx={{ bgcolor: c.status.warningBg, color: c.status.warning, fontSize: '0.7rem', height: 20, '& .MuiChip-icon': { color: c.status.warning } }} />
                            )}
                            {ig && totalToolCount > 0 && (
                              <Chip label={`${totalToolCount} tools`} size="small" sx={{ bgcolor: `${ig.color}15`, color: ig.color, fontSize: '0.7rem', height: 20, '& .MuiChip-label': { px: 0.6 } }} />
                            )}
                            {ig && (
                              <Chip component="a" href={ig.website} clickable icon={<OpenInNewIcon sx={{ fontSize: 10 }} />} label="docs" size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, fontSize: 10 } }} />
                            )}
                          </Box>
                          {tool.description && <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>{tool.description}</Typography>}
                        </Box>
                        <CustomToolConnect
                          tool={tool}
                          ig={ig}
                          isDisabled={isDisabled}
                          onOAuthConnect={handleOAuthConnect}
                          onDeviceCodeConnect={handleDeviceCodeConnect}
                          onOpenCredentialsDialog={openCredentialsDialog}
                          onM365Disconnect={handleM365Disconnect}
                          onDisconnectIntegration={handleDisconnectIntegration}
                        />
                        {ig && (
                          <Box
                            data-onboarding={
                              isYoutube
                                ? 'actions-youtube-toggle'
                                : isReddit
                                  ? 'actions-reddit-toggle'
                                  : undefined
                            }
                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {!!integrationLoading[ig.id] && <CircularProgress size={16} sx={{ color: ig.color }} />}
                            <Switch
                              checked={tool.enabled !== false}
                              onChange={() => handleIntegrationToggle(ig)}
                              disabled={!!integrationLoading[ig.id]}
                              sx={{
                                '& .MuiSwitch-switchBase.Mui-checked': { color: ig.color },
                                '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: ig.color },
                              }}
                            />
                          </Box>
                        )}
                        {!isDisabled && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                            <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                            {!ig && (
                              <>
                                <Tooltip title="Edit" placement="left"><IconButton size="small" onClick={(e) => { e.stopPropagation(); openEdit(tool); }} sx={{ color: c.text.ghost, '&:hover': { color: c.accent.primary } }}><EditIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                                <Tooltip title="Delete" placement="left"><IconButton size="small" onClick={(e) => { e.stopPropagation(); handleDelete(tool.id); }} sx={{ color: c.text.ghost, '&:hover': { color: c.status.error } }}><DeleteIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                              </>
                            )}
                          </Box>
                        )}
                      </Box>
                    </CardContent>

                    <Collapse in={isExpanded && !isDisabled} timeout={0} unmountOnExit>
                        <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, mb: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <SecurityIcon sx={{ fontSize: 14, color: c.text.muted }} />
                              <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tool Permissions</Typography>
                              {hasPerms && <Chip label={`${totalToolCount} tools`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, ml: 0.5, '& .MuiChip-label': { px: 0.6 } }} />}
                            </Box>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              {hasPerms && (
                                <>
                                  <Tooltip title="Allow all read-only tools">
                                    <Button size="small" onClick={() => handleBulkReadOnly(tool.id)} sx={{ color: c.status.info, textTransform: 'none', fontSize: '0.7rem', minWidth: 'auto', px: 1, py: 0.25 }}>
                                      Allow reads
                                    </Button>
                                  </Tooltip>
                                  <Tooltip title="Reset all to Ask">
                                    <Button size="small" onClick={() => handleResetPermissions(tool.id)} sx={{ color: c.text.ghost, textTransform: 'none', fontSize: '0.7rem', minWidth: 'auto', px: 1, py: 0.25 }}>
                                      Reset
                                    </Button>
                                  </Tooltip>
                                </>
                              )}
                              <Tooltip title="Discover / refresh tools from MCP server">
                                <IconButton
                                  size="small"
                                  onClick={() => handleDiscover(tool.id)}
                                  disabled={discovering || !canDiscover}
                                  sx={{ color: c.text.ghost, '&:hover': { color: c.accent.primary } }}
                                >
                                  {discovering ? <CircularProgress size={14} sx={{ color: c.text.ghost }} /> : <RefreshIcon sx={{ fontSize: 16 }} />}
                                </IconButton>
                              </Tooltip>
                            </Box>
                          </Box>

                          {!hasPerms ? (
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 3, gap: 1.5 }}>
                              <ExtensionIcon sx={{ fontSize: 28, color: c.text.ghost, opacity: 0.4 }} />
                              <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem' }}>No tools discovered yet</Typography>
                              <Button
                                size="small"
                                variant="outlined"
                                startIcon={discovering ? <CircularProgress size={12} /> : <SearchIcon sx={{ fontSize: 14 }} />}
                                onClick={() => handleDiscover(tool.id)}
                                disabled={discovering || !canDiscover}
                                sx={{ borderColor: c.border.medium, color: c.text.secondary, '&:hover': { borderColor: c.accent.primary, color: c.accent.primary }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5 }}
                              >
                                Discover Tools
                              </Button>
                              {!canDiscover && (
                                <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Add an MCP configuration to enable tool discovery</Typography>
                              )}
                            </Box>
                          ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                              {serviceNames.map((svc, idx) => (
                                <ServiceGroup
                                  key={svc}
                                  tool={tool}
                                  ig={ig}
                                  serviceName={svc}
                                  data={services![svc]}
                                  isFirstGroup={idx === 0}
                                  perms={perms}
                                  descriptions={descriptions}
                                  schemas={schemas}
                                  expandedServices={expandedServices}
                                  setExpandedServices={setExpandedServices}
                                  expandedSchema={expandedSchema}
                                  setExpandedSchema={setExpandedSchema}
                                  devMode={devMode}
                                  onGroupPermissionChange={handleGroupPermissionChange}
                                  onPermissionChange={handlePermissionChange}
                                />
                              ))}
                            </Box>
                          )}

                          {devMode && isMcp && <CustomToolDevInfo tool={tool} />}
                        </Box>
                      </Collapse>
                  </Card>
  );
};

export default CustomToolCard;
