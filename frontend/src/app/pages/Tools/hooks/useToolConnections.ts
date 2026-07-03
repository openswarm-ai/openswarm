import { useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  updateTool,
  fetchToolStatus,
  discoverTools,
  startOAuth,
  startDeviceCodeLogin,
  pollDeviceCodeStatus,
  disconnectM365,
  ToolDefinition,
} from '@/shared/state/toolsSlice';
import { API_BASE } from '@/shared/config';
import { Integration } from '../integrations';

type Snackbar = { open: boolean; message: string; severity?: 'success' | 'error' };

interface Deps {
  items: Record<string, ToolDefinition>;
  setSnackbar: (s: Snackbar) => void;
  setExpandedToolId: (id: string | null) => void;
}

export function useToolConnections({ items, setSnackbar, setExpandedToolId }: Deps) {
  const dispatch = useAppDispatch();

  const [deviceCodeDialogOpen, setDeviceCodeDialogOpen] = useState(false);
  const [deviceCodeDialogToolId, setDeviceCodeDialogToolId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState('');
  const [deviceCodeUrl, setDeviceCodeUrl] = useState('');
  const [deviceCodeStatus, setDeviceCodeStatus] = useState<'loading' | 'awaiting' | 'connected' | 'error'>('loading');

  const [credDialogOpen, setCredDialogOpen] = useState(false);
  const [credDialogToolId, setCredDialogToolId] = useState<string | null>(null);
  const [credDialogIntegration, setCredDialogIntegration] = useState<Integration | null>(null);
  const [credDialogValues, setCredDialogValues] = useState<Record<string, string>>({});
  const [credDialogSaving, setCredDialogSaving] = useState(false);

  const handleOAuthConnect = async (toolId: string) => {
    const result = await dispatch(startOAuth(toolId));
    if (startOAuth.fulfilled.match(result)) {
      const { auth_url } = result.payload;
      const popup = window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');

      const afterConnect = async () => {
        const statusResult = await dispatch(fetchToolStatus(toolId));
        if (fetchToolStatus.fulfilled.match(statusResult) && statusResult.payload.auth_status === 'connected') {
          setSnackbar({ open: true, message: 'Account connected! Discovering tools…' });
          setExpandedToolId(toolId);
          dispatch(discoverTools(toolId));
        } else {
          setSnackbar({ open: true, message: 'Account connected!' });
        }
      };

      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_complete' && event.data?.tool_id === toolId) {
          afterConnect();
          window.removeEventListener('message', onMessage);
        }
      };
      window.addEventListener('message', onMessage);

      const pollInterval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollInterval);
          afterConnect();
          window.removeEventListener('message', onMessage);
        }
      }, 1000);
    } else {
      setSnackbar({ open: true, message: 'OAuth failed; check that OAuth credentials are set in backend .env', severity: 'error' });
    }
  };

  const handleDeviceCodeConnect = async (toolId: string) => {
    setDeviceCodeDialogToolId(toolId);
    setDeviceCodeStatus('loading');
    setDeviceCode('');
    setDeviceCodeUrl('');
    setDeviceCodeDialogOpen(true);

    const result = await dispatch(startDeviceCodeLogin(toolId));
    if (startDeviceCodeLogin.fulfilled.match(result)) {
      const { device_code, device_code_url } = result.payload;
      setDeviceCode(device_code);
      const url = device_code_url || 'https://login.microsoft.com/device';
      setDeviceCodeUrl(url);
      setDeviceCodeStatus('awaiting');

      window.open(url, 'm365-login', 'width=500,height=700,left=200,top=100');

      const poll = setInterval(async () => {
        const statusResult = await dispatch(pollDeviceCodeStatus(toolId));
        if (pollDeviceCodeStatus.fulfilled.match(statusResult)) {
          const { status, email } = statusResult.payload;
          if (status === 'connected') {
            clearInterval(poll);
            setDeviceCodeStatus('connected');
            setSnackbar({ open: true, message: `Connected to Microsoft 365${email ? ` as ${email}` : ''}! Discovering tools…` });
            setDeviceCodeDialogOpen(false);
            setExpandedToolId(toolId);
            await dispatch(fetchToolStatus(toolId));
            dispatch(discoverTools(toolId));
          } else if (status === 'error') {
            clearInterval(poll);
            setDeviceCodeStatus('error');
          }
        }
      }, 2000);

      setTimeout(() => clearInterval(poll), 300000);
    } else {
      setDeviceCodeStatus('error');
    }
  };

  const handleM365Disconnect = async (toolId: string) => {
    await dispatch(disconnectM365(toolId));
    setSnackbar({ open: true, message: 'Disconnected from Microsoft 365' });
  };

  const openCredentialsDialog = (toolId: string, integration: Integration) => {
    const tool = items[toolId];
    const existing = tool?.credentials || {};
    const initial: Record<string, string> = {};
    for (const field of integration.credentialFields || []) {
      initial[field.key] = existing[field.key] || '';
    }
    setCredDialogToolId(toolId);
    setCredDialogIntegration(integration);
    setCredDialogValues(initial);
    setCredDialogOpen(true);
  };

  const handleCredentialsSave = async () => {
    if (!credDialogToolId || !credDialogIntegration) return;
    const hasEmpty = (credDialogIntegration.credentialFields || []).some((f) => !credDialogValues[f.key]?.trim());
    if (hasEmpty) return;

    setCredDialogSaving(true);
    try {
      const result = await dispatch(updateTool({
        id: credDialogToolId,
        credentials: credDialogValues,
        auth_type: 'env_vars',
        auth_status: 'connected',
      }));
      if (updateTool.fulfilled.match(result)) {
        setCredDialogOpen(false);
        setSnackbar({ open: true, message: `${credDialogIntegration.name} connected! Re-discovering tools…` });
        dispatch(discoverTools(credDialogToolId));
      } else {
        setSnackbar({ open: true, message: 'Failed to save credentials', severity: 'error' });
      }
    } finally {
      setCredDialogSaving(false);
    }
  };

  const handleSlackAutoConnect = async () => {
    if (!credDialogToolId || !credDialogIntegration) return;
    const slackBridge = (window as any).openswarm?.connectSlack;
    if (!slackBridge) {
      setSnackbar({ open: true, message: 'Slack auto-connect requires the desktop app', severity: 'error' });
      return;
    }
    setCredDialogSaving(true);
    try {
      const { token, cookie } = await slackBridge();
      const creds = { SLACK_MCP_XOXC_TOKEN: token, SLACK_MCP_XOXD_TOKEN: cookie };
      const result = await dispatch(updateTool({
        id: credDialogToolId,
        credentials: creds,
        auth_type: 'env_vars',
        auth_status: 'connected',
      }));
      if (updateTool.fulfilled.match(result)) {
        setCredDialogOpen(false);
        setSnackbar({ open: true, message: 'Slack connected! Re-discovering tools…' });
        dispatch(discoverTools(credDialogToolId));
      } else {
        setSnackbar({ open: true, message: 'Failed to save Slack credentials', severity: 'error' });
      }
    } catch (err: any) {
      setSnackbar({ open: true, message: err?.message || 'Slack sign-in cancelled', severity: 'error' });
    } finally {
      setCredDialogSaving(false);
    }
  };

  const handleDisconnectIntegration = async (toolId: string, integration: Integration) => {
    if (integration.authType === 'oauth2') {
      fetch(`${API_BASE}/tools/${toolId}/oauth/disconnect`, { method: 'POST' }).catch(() => {});
      const result = await dispatch(updateTool({
        id: toolId,
        oauth_tokens: {},
        auth_status: 'configured',
        connected_account_email: '',
      }));
      if (updateTool.fulfilled.match(result)) {
        setSnackbar({ open: true, message: `${integration.name} disconnected. You can now connect a different account.` });
      } else {
        setSnackbar({ open: true, message: `Failed to disconnect ${integration.name}`, severity: 'error' });
      }
    } else {
      await dispatch(updateTool({
        id: toolId,
        credentials: {},
        auth_type: 'none',
        auth_status: 'configured',
      }));
      setSnackbar({ open: true, message: `${integration.name} disconnected` });
    }
  };

  return {
    deviceCodeDialogOpen, setDeviceCodeDialogOpen, deviceCode, deviceCodeUrl, deviceCodeStatus,
    credDialogOpen, setCredDialogOpen, credDialogIntegration, credDialogValues, setCredDialogValues, credDialogSaving,
    handleOAuthConnect, handleDeviceCodeConnect, handleM365Disconnect,
    openCredentialsDialog, handleCredentialsSave, handleSlackAutoConnect, handleDisconnectIntegration,
  };
}
