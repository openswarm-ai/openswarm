import { createTool, discoverTools } from '@/shared/state/toolsSlice';
import type { AppDispatch } from '@/shared/state/store';
import type { Integration } from './integrations';

export interface InstallIntegrationResult {
  toolId: string | null;
  message: string;
  severity: 'success' | 'error';
}

// The one install path for a vetted integration (Tools page card AND the Directory's + button):
// create the tool, then discover immediately unless the auth flow has to run first.
export async function installIntegration(dispatch: AppDispatch, integration: Integration): Promise<InstallIntegrationResult> {
  const result = await dispatch(createTool({
    name: integration.name,
    description: integration.description,
    command: '',
    mcp_config: integration.mcp_config,
    credentials: {},
    auth_type: integration.authType || 'none',
    auth_status: 'configured',
  }));
  if (!createTool.fulfilled.match(result)) {
    return { toolId: null, message: `Could not enable ${integration.name}`, severity: 'error' };
  }
  const newTool = result.payload;
  if (integration.authType === 'oauth2' || integration.authType === 'device_code') {
    return { toolId: newTool.id, message: `Enabled ${integration.name}, connect your account to discover tools`, severity: 'success' };
  }
  const discoverResult = await dispatch(discoverTools(newTool.id));
  if (discoverTools.fulfilled.match(discoverResult)) {
    return { toolId: newTool.id, message: `${integration.name} ready, tools discovered`, severity: 'success' };
  }
  const detail = (discoverResult as { error?: { message?: string } }).error?.message
    || `discovery failed; is ${integration.mcp_config.command || 'the server'} installed?`;
  return { toolId: newTool.id, message: `${integration.name}: ${detail}`, severity: 'error' };
}
