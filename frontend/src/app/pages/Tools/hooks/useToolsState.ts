import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import type { ToolDefinition, BuiltinTool } from '@/shared/state/toolsSlice';
import {
  LIST_TOOLS, LIST_BUILTIN_TOOLS, GET_BUILTIN_PERMISSIONS, UPDATE_BUILTIN_PERMISSIONS,
  CREATE_TOOL, UPDATE_TOOL, DELETE_TOOL, OAUTH_START, GET_TOOL, DISCOVER_TOOL,
  OAUTH_DISCONNECT,
} from '@/shared/backend-bridge/apps/tools';
import { searchRegistry, fetchRegistryStats, fetchServerDetail, McpServer } from '@/shared/state/mcpRegistrySlice';
import { LIST_APPS, UPDATE_APP } from '@/shared/backend-bridge/apps/app_builder';
import { INTEGRATIONS, Integration, CATEGORY_ORDER } from '../integrations';
import { ToolForm, emptyForm, serverToToolForm, serverToMcpConfig, groupTools } from '../toolUtils';

const clearDetail = () => {
  return {
    type: 'mcpRegistry/clearDetail',
  };
};

export function useToolsState() {
  const dispatch = useAppDispatch();
  const { items, builtinTools, builtinPermissions, loading } = useAppSelector((s) => s.tools);
  const { servers: regServers, total: regTotal, loading: regLoading, stats: regStats, detail: regDetail, detailLoading: regDetailLoading } = useAppSelector((s) => s.mcpRegistry);
  const devMode = useAppSelector((s) => s.settings.data.dev_mode);
  const outputItems = useAppSelector((s) => s.apps.items);
  const outputs = useMemo(() => Object.values(outputItems), [outputItems]);
  const allTools = Object.values(items);

  const tools = useMemo(() => [...allTools].sort((a, b) => {
    const aIg = INTEGRATIONS.find(ig => ig.name === a.name); const bIg = INTEGRATIONS.find(ig => ig.name === b.name);
    const aCS = aIg?.comingSoon ? 1 : 0; const bCS = bIg?.comingSoon ? 1 : 0;
    if (aCS !== bCS) return aCS - bCS;
    const aP = Object.keys(a.tool_permissions || {}).filter(k => !k.startsWith('_')).length;
    const bP = Object.keys(b.tool_permissions || {}).filter(k => !k.startsWith('_')).length;
    const aS = (a.enabled !== false ? 4 : 0) + (a.auth_status === 'connected' ? 2 : 0) + (aP > 0 ? 1 : 0);
    const bS = (b.enabled !== false ? 4 : 0) + (b.auth_status === 'connected' ? 2 : 0) + (bP > 0 ? 1 : 0);
    return bS !== aS ? bS - aS : bP - aP;
  }), [allTools]);

  const uninstalledIntegrations = useMemo(() => {
    const u = INTEGRATIONS.filter((ig) => !allTools.find((t) => t.name === ig.name));
    return u.sort((a, b) => (a.comingSoon && !b.comingSoon ? 1 : !a.comingSoon && b.comingSoon ? -1 : 0));
  }, [allTools]);
  const getIntegrationForTool = useCallback((tool: ToolDefinition) => INTEGRATIONS.find((ig) => ig.name === tool.name), []);
  const getInstalledIntegration = useCallback((integration: Integration): ToolDefinition | undefined => allTools.find((t) => t.name === integration.name), [allTools]);

  const [dialogOpen, setDialogOpen] = useState(false); const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolForm>(emptyForm);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>(Object.fromEntries([...CATEGORY_ORDER.map((cat) => [cat, true]), ...CATEGORY_ORDER.map((cat) => [`d_${cat}`, true])]));
  const [expandedBuiltin, setExpandedBuiltin] = useState<string | null>(null);
  const [coreSectionOpen, setCoreSectionOpen] = useState(false); const [deferredSectionOpen, setDeferredSectionOpen] = useState(false);
  const [customSectionOpen, setCustomSectionOpen] = useState(true); const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [registryOpen, setRegistryOpen] = useState(false); const [regQuery, setRegQuery] = useState('');
  const [regSort, setRegSort] = useState<'name' | 'stars'>('stars'); const [regSource, setRegSource] = useState<'' | 'community' | 'google'>('');
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity?: 'success' | 'error' }>({ open: false, message: '' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false); const [mcpConfigServer, setMcpConfigServer] = useState<McpServer | null>(null);
  const [mcpAuthType, setMcpAuthType] = useState<'none' | 'env_vars'>('none'); const [mcpCredentials, setMcpCredentials] = useState<Record<string, string>>({});
  const [mcpConfigJson, setMcpConfigJson] = useState(''); const [mcpConfigError, setMcpConfigError] = useState('');
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null); const [discovering, setDiscovering] = useState(false);
  const [integrationLoading, setIntegrationLoading] = useState<Record<string, boolean>>({});
  const [credDialogOpen, setCredDialogOpen] = useState(false); const [credDialogToolId, setCredDialogToolId] = useState<string | null>(null);
  const [credDialogIntegration, setCredDialogIntegration] = useState<Integration | null>(null);
  const [credDialogValues, setCredDialogValues] = useState<Record<string, string>>({}); const [credDialogSaving, setCredDialogSaving] = useState(false);
  const [expandedServices, setExpandedServices] = useState<Record<string, boolean>>({}); const [expandedSchema, setExpandedSchema] = useState<string | null>(null);
  const [viewsSectionOpen, setViewsSectionOpen] = useState(false); const [browserSectionOpen, setBrowserSectionOpen] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState<Record<string, boolean>>({ browser_delegation: true, browser_action: true });
  const [builtinSectionOpen, setBuiltinSectionOpen] = useState(true);

  const BROWSER_CATEGORIES = useMemo(() => new Set(['browser_delegation', 'browser_action']), []);
  const coreTools = useMemo(() => builtinTools.filter((bt) => !bt.deferred && !BROWSER_CATEGORIES.has(bt.category)), [builtinTools]); const deferredTools = useMemo(() => builtinTools.filter((bt) => bt.deferred && !BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const browserTools = useMemo(() => builtinTools.filter((bt) => BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const browserDelegationTools = useMemo(() => browserTools.filter((bt) => bt.category === 'browser_delegation'), [browserTools]); const browserActionTools = useMemo(() => browserTools.filter((bt) => bt.category === 'browser_action'), [browserTools]);
  const groupedCore = useMemo(() => groupTools(coreTools), [coreTools]); const groupedDeferred = useMemo(() => groupTools(deferredTools), [deferredTools]);
  const coreSectionEnabled = useMemo(() => !coreTools.every((t) => builtinPermissions[t.name] === 'deny'), [coreTools, builtinPermissions]); const deferredSectionEnabled = useMemo(() => !deferredTools.every((t) => builtinPermissions[t.name] === 'deny'), [deferredTools, builtinPermissions]);
  const viewsSectionEnabled = useMemo(() => !outputs.every((o) => o.permission === 'deny'), [outputs]); const browserSectionEnabled = useMemo(() => browserTools.length > 0 && !browserTools.every((t) => builtinPermissions[t.name] === 'deny'), [browserTools, builtinPermissions]);

  useEffect(() => { dispatch(LIST_TOOLS()); dispatch(LIST_BUILTIN_TOOLS()); dispatch(GET_BUILTIN_PERMISSIONS()); dispatch(LIST_APPS()); }, [dispatch]);

  const handleIntegrationToggle = async (integration: Integration) => {
    const existing = getInstalledIntegration(integration);
    setIntegrationLoading((p) => ({ ...p, [integration.id]: true }));
    try {
      if (existing && existing.enabled !== false) {
        await dispatch(UPDATE_TOOL({ toolId: existing.id, enabled: false }));
        setSnackbar({ open: true, message: `Disabled ${integration.name}` });
      } else if (existing && existing.enabled === false) {
        await dispatch(UPDATE_TOOL({ toolId: existing.id, enabled: true }));
        if (integration.authType === 'oauth2' && existing.auth_status !== 'connected') {
          setSnackbar({ open: true, message: `Enabled ${integration.name} — connect your account to discover actions` });
        } else {
          setSnackbar({ open: true, message: `Enabled ${integration.name} — re-discovering actions…` });
          const r = await dispatch(DISCOVER_TOOL(existing.id));
          if (DISCOVER_TOOL.fulfilled.match(r)) setSnackbar({ open: true, message: `${integration.name} ready — actions discovered` });
          else setSnackbar({ open: true, message: `${integration.name} enabled but discovery failed`, severity: 'error' });
        }
      } else {
        const result = await dispatch(CREATE_TOOL({ name: integration.name, description: integration.description, command: '', mcp_config: integration.mcp_config, credentials: {}, auth_type: integration.authType || 'none', auth_status: 'configured', ...(integration.oauthProvider ? { oauth_provider: integration.oauthProvider } : {}) }));
        if (CREATE_TOOL.fulfilled.match(result)) {
          const newTool = result.payload.tool as unknown as ToolDefinition;
          if (integration.authType === 'oauth2') {
            setSnackbar({ open: true, message: `Enabled ${integration.name} — connect your account to discover actions` });
          } else {
            setSnackbar({ open: true, message: `Enabled ${integration.name} — discovering actions…` });
            const r = await dispatch(DISCOVER_TOOL(newTool.id));
            if (DISCOVER_TOOL.fulfilled.match(r)) setSnackbar({ open: true, message: `${integration.name} ready — actions discovered` });
            else setSnackbar({ open: true, message: `${integration.name} enabled but discovery failed — is ${integration.mcp_config.command || 'the server'} installed?`, severity: 'error' });
          }
        }
      }
    } finally { setIntegrationLoading((p) => ({ ...p, [integration.id]: false })); }
  };

  const handleDirectConnect = async (integration: Integration) => {
    setIntegrationLoading((p) => ({ ...p, [integration.id]: true }));
    try {
      const result = await dispatch(CREATE_TOOL({ name: integration.name, description: integration.description, command: '', mcp_config: integration.mcp_config, credentials: {}, auth_type: integration.authType || 'none', auth_status: 'configured', ...(integration.oauthProvider ? { oauth_provider: integration.oauthProvider } : {}) }));
      if (!CREATE_TOOL.fulfilled.match(result)) return;
      const newTool = result.payload.tool as unknown as ToolDefinition;
      if (integration.authType === 'oauth2') handleOAuthConnect(newTool.id);
      else if (integration.credentialFields) openCredentialsDialog(newTool.id, integration);
    } finally { setIntegrationLoading((p) => ({ ...p, [integration.id]: false })); }
  };

  const handleOAuthConnect = async (toolId: string) => {
    const result = await dispatch(OAUTH_START(toolId));
    if (OAUTH_START.fulfilled.match(result)) {
      const { auth_url } = result.payload;
      const popup = window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');
      const afterConnect = async () => {
        const statusResult = await dispatch(GET_TOOL(toolId));
        if (GET_TOOL.fulfilled.match(statusResult) && (statusResult.payload as unknown as ToolDefinition).auth_status === 'connected') {
          setSnackbar({ open: true, message: `${allTools.find(t => t.id === toolId)?.name || 'Account'} connected! Discovering actions…` });
          setExpandedToolId(toolId); dispatch(DISCOVER_TOOL(toolId));
        } else { setSnackbar({ open: true, message: `${allTools.find(t => t.id === toolId)?.name || 'Account'} connected!` }); }
      };
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_complete' && event.data?.tool_id === toolId) { afterConnect(); window.removeEventListener('message', onMessage); }
      };
      window.addEventListener('message', onMessage);
      const pollInterval = setInterval(() => { if (popup?.closed) { clearInterval(pollInterval); afterConnect(); window.removeEventListener('message', onMessage); } }, 1000);
    } else {
      setSnackbar({ open: true, message: (result as any)?.payload?.detail || (result as any)?.error?.message || 'OAuth failed — check backend .env for required credentials', severity: 'error' });
    }
  };

  const openCredentialsDialog = (toolId: string, integration: Integration) => {
    const existing = items[toolId]?.credentials || {};
    const initial: Record<string, string> = {};
    for (const field of integration.credentialFields || []) initial[field.key] = existing[field.key] || '';
    setCredDialogToolId(toolId); setCredDialogIntegration(integration); setCredDialogValues(initial); setCredDialogOpen(true);
  };

  const handleCredentialsSave = async () => {
    if (!credDialogToolId || !credDialogIntegration) return;
    if ((credDialogIntegration.credentialFields || []).some((f) => !f.optional && !credDialogValues[f.key]?.trim())) return;
    setCredDialogSaving(true);
    try {
      const result = await dispatch(UPDATE_TOOL({ toolId: credDialogToolId, credentials: credDialogValues, auth_type: 'env_vars', auth_status: 'connected' }));
      if (UPDATE_TOOL.fulfilled.match(result)) { setCredDialogOpen(false); setSnackbar({ open: true, message: `${credDialogIntegration.name} connected! Re-discovering actions…` }); dispatch(DISCOVER_TOOL(credDialogToolId)); }
      else setSnackbar({ open: true, message: 'Failed to save credentials', severity: 'error' });
    } finally { setCredDialogSaving(false); }
  };

  const handleDisconnectIntegration = async (toolId: string, integration: Integration) => {
    if (integration.authType === 'oauth2') {
      const result = await dispatch(OAUTH_DISCONNECT(toolId));
      if (OAUTH_DISCONNECT.fulfilled.match(result)) setSnackbar({ open: true, message: `${integration.name} disconnected. You can now connect a different account.` });
      else setSnackbar({ open: true, message: `Failed to disconnect ${integration.name}`, severity: 'error' });
    } else {
      await dispatch(UPDATE_TOOL({ toolId, credentials: {}, auth_type: 'none', auth_status: 'configured' }));
      setSnackbar({ open: true, message: `${integration.name} disconnected` });
    }
  };

  const handleDiscover = async (toolId: string) => {
    setDiscovering(true);
    try {
      const result = await dispatch(DISCOVER_TOOL(toolId));
      if (DISCOVER_TOOL.fulfilled.match(result)) setSnackbar({ open: true, message: 'Actions discovered successfully' });
      else setSnackbar({ open: true, message: (result as any).error?.message || 'Discovery failed — is the MCP server running?', severity: 'error' });
    } finally { setDiscovering(false); }
  };

  const handlePermissionChange = async (toolId: string, toolName: string, policy: string) => { const tool = items[toolId]; if (!tool) return; await dispatch(UPDATE_TOOL({ toolId, tool_permissions: { ...tool.tool_permissions, [toolName]: policy } })); };
  const handleGroupPermissionChange = async (toolId: string, names: string[], policy: string) => { const tool = items[toolId]; if (!tool) return; const updated = { ...tool.tool_permissions }; for (const name of names) updated[name] = policy; await dispatch(UPDATE_TOOL({ toolId, tool_permissions: updated })); };
  const handleBulkReadOnly = async (toolId: string) => { const tool = items[toolId]; if (!tool?.tool_permissions?._categories) return; const readNames: string[] = tool.tool_permissions._categories.read || []; const updated = { ...tool.tool_permissions }; for (const name of readNames) updated[name] = 'always_allow'; await dispatch(UPDATE_TOOL({ toolId, tool_permissions: updated })); };
  const handleResetPermissions = async (toolId: string) => { const tool = items[toolId]; if (!tool?.tool_permissions) return; const updated = { ...tool.tool_permissions }; for (const key of Object.keys(updated)) { if (!key.startsWith('_')) updated[key] = 'ask'; } await dispatch(UPDATE_TOOL({ toolId, tool_permissions: updated })); };

  const handleSave = async () => {
    const payload = { name: form.name, description: form.description, command: form.command };
    if (editingId) await dispatch(UPDATE_TOOL({ toolId: editingId, ...payload })); else await dispatch(CREATE_TOOL(payload));
    setDialogOpen(false);
  };
  const handleDelete = async (id: string) => { await dispatch(DELETE_TOOL(id)); };
  const openEdit = (tool: ToolDefinition) => { setEditingId(tool.id); setForm({ name: tool.name, description: tool.description, command: tool.command }); setDialogOpen(true); };
  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => setMenuAnchor(e.currentTarget);
  const handleMenuClose = () => setMenuAnchor(null);
  const openCreate = () => { handleMenuClose(); setEditingId(null); setForm(emptyForm); setDialogOpen(true); };
  const openRegistryBrowser = () => { handleMenuClose(); setRegistryOpen(true); setRegQuery(''); setRegSort('stars'); setRegSource(''); setExpandedServer(null); dispatch(fetchRegistryStats()); dispatch(searchRegistry({ q: '', limit: 20, offset: 0, sort: 'stars', source: '' })); };

  const handleRegSearch = useCallback((q: string) => { setRegQuery(q); setExpandedServer(null); if (debounceRef.current) clearTimeout(debounceRef.current); debounceRef.current = setTimeout(() => { dispatch(searchRegistry({ q, limit: 20, offset: 0, sort: regSort, source: regSource })); }, 300); }, [dispatch, regSort, regSource]);
  const handleLoadMore = () => { dispatch(searchRegistry({ q: regQuery, limit: 20, offset: regServers.length, sort: regSort, source: regSource })); };
  const handleRegSort = (sort: 'name' | 'stars') => { setRegSort(sort); setExpandedServer(null); dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort, source: regSource })); };
  const handleRegSourceFilter = (_: React.MouseEvent<HTMLElement>, val: '' | 'community' | 'google') => { if (val === null) return; setRegSource(val); setExpandedServer(null); dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort: regSort, source: val })); };
  const handleExpandServer = (name: string | null) => { setExpandedServer(name); if (name && devMode) { dispatch(clearDetail()); dispatch(fetchServerDetail(name)); } };

  const openMcpConfigDialog = (srv: McpServer) => { setMcpConfigServer(srv); setMcpAuthType('none'); setMcpCredentials({}); const dc = serverToMcpConfig(srv); setMcpConfigJson(JSON.stringify(Object.keys(dc).length > 0 ? dc : {}, null, 2)); setMcpConfigError(''); setMcpConfigOpen(true); };
  const handleMcpConfigSave = async () => { if (!mcpConfigServer) return; let parsedConfig: Record<string, any> = {}; try { parsedConfig = JSON.parse(mcpConfigJson); } catch { setMcpConfigError('Invalid JSON'); return; } const f = serverToToolForm(mcpConfigServer); await dispatch(CREATE_TOOL({ name: f.name, description: f.description, command: '', mcp_config: parsedConfig, credentials: mcpCredentials, auth_type: mcpAuthType, auth_status: 'configured' })); setMcpConfigOpen(false); setSnackbar({ open: true, message: `Installed "${f.name}" as MCP tool` }); };

  const handleInstall = async (srv: McpServer) => {
    const f = serverToToolForm(srv); const mcpConfig = serverToMcpConfig(srv);
    const hasConfig = Object.keys(mcpConfig).length > 0;
    if (srv.source === 'google' && srv.remoteUrl && hasConfig) {
      await dispatch(CREATE_TOOL({ name: f.name, description: f.description, command: '', mcp_config: mcpConfig, credentials: {}, auth_type: 'oauth2', auth_status: 'configured' }));
      setSnackbar({ open: true, message: `Installed "${f.name}" — click "Connect" to authorize` });
    } else if (hasConfig && mcpConfig.type === 'stdio') {
      const result = await dispatch(CREATE_TOOL({ name: f.name, description: f.description, command: '', mcp_config: mcpConfig, credentials: {}, auth_type: 'none', auth_status: 'configured' }));
      if (CREATE_TOOL.fulfilled.match(result)) {
        setSnackbar({ open: true, message: `Installed "${f.name}" — discovering actions…` });
        const r = await dispatch(DISCOVER_TOOL((result.payload.tool as unknown as ToolDefinition).id));
        if (DISCOVER_TOOL.fulfilled.match(r)) setSnackbar({ open: true, message: `${f.name} ready — actions discovered` });
        else setSnackbar({ open: true, message: `${f.name} installed but discovery failed — the MCP server may need setup first`, severity: 'error' });
      }
    } else { openMcpConfigDialog(srv); }
  };
  const handleEditInstall = (srv: McpServer) => { setRegistryOpen(false); setEditingId(null); setForm(serverToToolForm(srv)); setDialogOpen(true); };

  const handleSectionEnabledChange = async (tls: BuiltinTool[], enabled: boolean) => { const perms: Record<string, string> = {}; for (const t of tls) perms[t.name] = enabled ? 'always_allow' : 'deny'; await dispatch(UPDATE_BUILTIN_PERMISSIONS(perms)); };
  const handleViewsSectionEnabledChange = async (enabled: boolean) => { for (const out of outputs) await dispatch(UPDATE_APP({ appId: out.id, permission: enabled ? 'ask' : 'deny' })); };
  const handleBuiltinPermissionChange = async (toolName: string, policy: string) => { await dispatch(UPDATE_BUILTIN_PERMISSIONS({ [toolName]: policy })); };
  const handleBuiltinCategoryPermissionChange = async (toolNames: string[], policy: string) => { const perms: Record<string, string> = {}; for (const name of toolNames) perms[name] = policy; await dispatch(UPDATE_BUILTIN_PERMISSIONS(perms)); };
  const handleViewPermissionChange = async (viewId: string, permission: string) => { await dispatch(UPDATE_APP({ appId: viewId, permission })); };
  const toggleCategory = (cat: string) => setCollapsedCategories((p) => ({ ...p, [cat]: !p[cat] })); const toggleBuiltinExpand = (name: string) => setExpandedBuiltin((p) => (p === name ? null : name));

  return { items, builtinPermissions, loading, outputs, devMode, regServers, regTotal, regLoading, regStats, regDetail, regDetailLoading, allTools, tools, uninstalledIntegrations, getIntegrationForTool, coreTools, deferredTools, browserTools, browserDelegationTools, browserActionTools, groupedCore, groupedDeferred, coreSectionEnabled, deferredSectionEnabled, viewsSectionEnabled, browserSectionEnabled, dialogOpen, setDialogOpen, editingId, form, setForm, collapsedCategories, toggleCategory, expandedBuiltin, toggleBuiltinExpand, coreSectionOpen, setCoreSectionOpen, deferredSectionOpen, setDeferredSectionOpen, customSectionOpen, setCustomSectionOpen, menuAnchor, handleMenuOpen, handleMenuClose, registryOpen, setRegistryOpen, regQuery, regSort, regSource, expandedServer, snackbar, setSnackbar, mcpConfigOpen, setMcpConfigOpen, mcpConfigServer, mcpAuthType, setMcpAuthType, mcpCredentials, setMcpCredentials, mcpConfigJson, setMcpConfigJson, mcpConfigError, setMcpConfigError, expandedToolId, setExpandedToolId, discovering, integrationLoading, credDialogOpen, setCredDialogOpen, credDialogIntegration, credDialogValues, setCredDialogValues, credDialogSaving, expandedServices, setExpandedServices, expandedSchema, setExpandedSchema, viewsSectionOpen, setViewsSectionOpen, browserSectionOpen, setBrowserSectionOpen, browserCollapsed, setBrowserCollapsed, builtinSectionOpen, setBuiltinSectionOpen, handleIntegrationToggle, handleDirectConnect, handleOAuthConnect, openCredentialsDialog, handleCredentialsSave, handleDisconnectIntegration, handleDiscover, handlePermissionChange, handleGroupPermissionChange, handleBulkReadOnly, handleResetPermissions, handleSave, handleDelete, openEdit, openCreate, openRegistryBrowser, handleRegSearch, handleLoadMore, handleRegSort, handleRegSourceFilter, handleExpandServer, openMcpConfigDialog, handleMcpConfigSave, handleInstall, handleEditInstall, handleSectionEnabledChange, handleViewsSectionEnabledChange, handleBuiltinPermissionChange, handleBuiltinCategoryPermissionChange, handleViewPermissionChange };
}
