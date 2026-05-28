import React from 'react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import LinkIcon from '@mui/icons-material/Link';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';

interface CustomToolConnectProps {
  tool: ToolDefinition;
  ig: Integration | undefined;
  isDisabled: boolean;
  onOAuthConnect: (toolId: string) => void;
  onDeviceCodeConnect: (toolId: string) => void;
  onOpenCredentialsDialog: (toolId: string, integration: Integration) => void;
  onM365Disconnect: (toolId: string) => void;
  onDisconnectIntegration: (toolId: string, integration: Integration) => void;
}

const CustomToolConnect: React.FC<CustomToolConnectProps> = ({
  tool, ig, isDisabled,
  onOAuthConnect: handleOAuthConnect,
  onDeviceCodeConnect: handleDeviceCodeConnect,
  onOpenCredentialsDialog: openCredentialsDialog,
  onM365Disconnect: handleM365Disconnect,
  onDisconnectIntegration: handleDisconnectIntegration,
}) => {
  const c = useClaudeTokens();
  return (
    <>
                        {!isDisabled && (tool.auth_type === 'oauth2' || ig?.authType === 'oauth2') && (tool.auth_status !== 'connected' || ig?.id === 'discord') && (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); handleOAuthConnect(tool.id); }}
                            sx={{ borderColor: `${c.status.info}40`, color: c.status.info, '&:hover': { borderColor: c.status.info, bgcolor: `${c.status.info}10` }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
                          >
                            {ig?.id === 'discord' && tool.auth_status === 'connected' ? 'Add server' : `Connect ${tool.name}`}
                          </Button>
                        )}
                        {!isDisabled && ig?.authType === 'device_code' && tool.auth_status !== 'connected' && (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); handleDeviceCodeConnect(tool.id); }}
                            sx={{ borderColor: `${ig.color}40`, color: ig.color, '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}10` }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
                          >
                            Connect Microsoft 365
                          </Button>
                        )}
                        {!isDisabled && ig?.credentialFields && tool.auth_status !== 'connected' && (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); openCredentialsDialog(tool.id, ig); }}
                            sx={{ borderColor: `${ig.color}40`, color: ig.color, '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}10` }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
                          >
                            {ig.connectLabel || 'Connect'}
                          </Button>
                        )}
                        {!isDisabled && ig && tool.auth_status === 'connected' && (
                          <Tooltip title={ig.credentialFields || ig.authType === 'oauth2' || ig.authType === 'device_code' ? 'Disconnect' : ''}>
                            <Chip
                              icon={<CheckCircleIcon sx={{ fontSize: 12 }} />}
                              label={tool.connected_account_email ? `Connected · ${tool.connected_account_email}` : 'Connected'}
                              size="small"
                              onDelete={(ig.credentialFields || ig.authType === 'oauth2' || ig.authType === 'device_code') ? (e: React.SyntheticEvent) => { e.stopPropagation(); ig.authType === 'device_code' ? handleM365Disconnect(tool.id) : handleDisconnectIntegration(tool.id, ig); } : undefined}
                              onClick={(e) => e.stopPropagation()}
                              sx={{ bgcolor: c.status.successBg, color: c.status.success, fontSize: '0.7rem', height: 22, '& .MuiChip-icon': { color: c.status.success }, '& .MuiChip-deleteIcon': { color: c.status.success, '&:hover': { color: c.status.error } }, flexShrink: 0 }}
                            />
                          </Tooltip>
                        )}
    </>
  );
};

export default CustomToolConnect;
