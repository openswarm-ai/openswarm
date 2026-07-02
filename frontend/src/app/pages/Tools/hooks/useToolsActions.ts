import { useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  createTool,
  updateTool,
  deleteTool,
  discoverTools,
  updateBuiltinPermissions,
  ToolDefinition,
  BuiltinTool,
} from '@/shared/state/toolsSlice';
import { McpServer } from '@/shared/state/mcpRegistrySlice';
import { ToolForm, emptyForm } from '../toolsHelpers';
import { Integration } from '../integrations';
import { useToolConnections } from './useToolConnections';
import { useRegistryBrowser } from './useRegistryBrowser';

type Snackbar = { open: boolean; message: string; severity?: 'success' | 'error' };

interface ToolsActionsDeps {
  items: Record<string, ToolDefinition>;
  allTools: ToolDefinition[];
  regServersRaw: McpServer[];
  closeMenu: () => void;
}

export function useToolsActions({ items, allTools, regServersRaw, closeMenu }: ToolsActionsDeps) {
  const dispatch = useAppDispatch();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolForm>(emptyForm);

  const [snackbar, setSnackbar] = useState<Snackbar>({ open: false, message: '' });

  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [integrationLoading, setIntegrationLoading] = useState<Record<string, boolean>>({});
  const [expandedServices, setExpandedServices] = useState<Record<string, boolean>>({});
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);

  const connections = useToolConnections({ items, setSnackbar, setExpandedToolId });
  const registry = useRegistryBrowser({ regServersRaw, setSnackbar, setEditingId, setForm, setDialogOpen, closeMenu });

  const getInstalledIntegration = (integration: Integration): ToolDefinition | undefined => {
    return allTools.find((t) => t.name === integration.name);
  };

  const handleIntegrationToggle = async (integration: Integration) => {
    const existing = getInstalledIntegration(integration);
    setIntegrationLoading((p) => ({ ...p, [integration.id]: true }));
    try {
      if (existing && existing.enabled !== false) {
        await dispatch(updateTool({ id: existing.id, enabled: false }));
        setSnackbar({ open: true, message: `Disabled ${integration.name}` });
      } else if (existing && existing.enabled === false) {
        await dispatch(updateTool({ id: existing.id, enabled: true }));
        if (integration.authType === 'oauth2' && existing.auth_status !== 'connected') {
          setSnackbar({ open: true, message: `Enabled ${integration.name}, connect your account to discover tools` });
        } else {
          setSnackbar({ open: true, message: `Enabled ${integration.name}, re-discovering tools…` });
          const discoverResult = await dispatch(discoverTools(existing.id));
          if (discoverTools.fulfilled.match(discoverResult)) {
            setSnackbar({ open: true, message: `${integration.name} ready, tools discovered` });
          } else {
            const detail = (discoverResult as any).error?.message || 'discovery failed';
            setSnackbar({ open: true, message: `${integration.name}: ${detail}`, severity: 'error' });
          }
        }
      } else {
        const result = await dispatch(createTool({
          name: integration.name,
          description: integration.description,
          command: '',
          mcp_config: integration.mcp_config,
          credentials: {},
          auth_type: integration.authType || 'none',
          auth_status: 'configured',
        }));
        if (createTool.fulfilled.match(result)) {
          const newTool = result.payload;
          if (integration.authType === 'oauth2' || integration.authType === 'device_code') {
            setSnackbar({ open: true, message: `Enabled ${integration.name}, connect your account to discover tools` });
          } else {
            setSnackbar({ open: true, message: `Enabled ${integration.name}, discovering tools…` });
            const discoverResult = await dispatch(discoverTools(newTool.id));
            if (discoverTools.fulfilled.match(discoverResult)) {
              setSnackbar({ open: true, message: `${integration.name} ready, tools discovered` });
            } else {
              const detail = (discoverResult as any).error?.message
                || `discovery failed; is ${integration.mcp_config.command || 'the server'} installed?`;
              setSnackbar({ open: true, message: `${integration.name}: ${detail}`, severity: 'error' });
            }
          }
        }
      }
    } finally {
      setIntegrationLoading((p) => ({ ...p, [integration.id]: false }));
    }
  };

  const handleDiscover = async (toolId: string) => {
    setDiscovering(true);
    try {
      const result = await dispatch(discoverTools(toolId));
      if (discoverTools.fulfilled.match(result)) {
        setSnackbar({ open: true, message: 'Tools discovered successfully' });
      } else {
        const detail = (result as any).error?.message || 'Discovery failed; is the MCP server running?';
        setSnackbar({ open: true, message: detail, severity: 'error' });
      }
    } finally {
      setDiscovering(false);
    }
  };

  const handlePermissionChange = async (toolId: string, toolName: string, policy: string) => {
    const tool = items[toolId];
    if (!tool) return;
    const updated = { ...tool.tool_permissions, [toolName]: policy };
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleGroupPermissionChange = async (toolId: string, names: string[], policy: string) => {
    const tool = items[toolId];
    if (!tool) return;
    const updated = { ...tool.tool_permissions };
    for (const name of names) updated[name] = policy;
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleBulkReadOnly = async (toolId: string) => {
    const tool = items[toolId];
    if (!tool?.tool_permissions?._categories) return;
    const readNames: string[] = tool.tool_permissions._categories.read || [];
    const updated = { ...tool.tool_permissions };
    for (const name of readNames) updated[name] = 'always_allow';
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleResetPermissions = async (toolId: string) => {
    const tool = items[toolId];
    if (!tool?.tool_permissions) return;
    const updated = { ...tool.tool_permissions };
    for (const key of Object.keys(updated)) {
      if (!key.startsWith('_')) updated[key] = 'ask';
    }
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleBuiltinPermissionChange = async (toolName: string, policy: string) => {
    await dispatch(updateBuiltinPermissions({ [toolName]: policy }));
  };

  const handleBuiltinCategoryPermissionChange = async (toolNames: string[], policy: string) => {
    const perms: Record<string, string> = {};
    for (const name of toolNames) perms[name] = policy;
    await dispatch(updateBuiltinPermissions(perms));
  };

  const handleSectionEnabledChange = async (tools: BuiltinTool[], enabled: boolean) => {
    const perms: Record<string, string> = {};
    for (const t of tools) perms[t.name] = enabled ? 'always_allow' : 'deny';
    await dispatch(updateBuiltinPermissions(perms));
  };

  const openCreate = () => {
    closeMenu();
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (tool: ToolDefinition) => {
    setEditingId(tool.id);
    setForm({ name: tool.name, description: tool.description, command: tool.command });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const payload = { name: form.name, description: form.description, command: form.command };
    if (editingId) { await dispatch(updateTool({ id: editingId, ...payload })); } else { await dispatch(createTool(payload)); }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => { await dispatch(deleteTool(id)); };

  return {
    dialogOpen, setDialogOpen, editingId, setEditingId, form, setForm, snackbar, setSnackbar,
    expandedToolId, setExpandedToolId, discovering, integrationLoading,
    expandedServices, setExpandedServices, expandedSchema, setExpandedSchema,
    ...connections,
    ...registry,
    handleIntegrationToggle, handleDiscover, handlePermissionChange, handleGroupPermissionChange,
    handleBulkReadOnly, handleResetPermissions, handleBuiltinPermissionChange, handleBuiltinCategoryPermissionChange,
    handleSectionEnabledChange, openCreate, openEdit, handleSave, handleDelete,
  };
}
