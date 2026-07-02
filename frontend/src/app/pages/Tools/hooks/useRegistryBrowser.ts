import { useCallback, useRef, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { createTool, discoverTools } from '@/shared/state/toolsSlice';
import { searchRegistry, fetchRegistryStats, McpServer } from '@/shared/state/mcpRegistrySlice';
import { ToolForm, serverToToolForm, serverToMcpConfig } from '../toolsHelpers';

type Snackbar = { open: boolean; message: string; severity?: 'success' | 'error' };
type RegSource = '' | 'community' | 'google' | 'curated';

interface Deps {
  regServersRaw: McpServer[];
  setSnackbar: (s: Snackbar) => void;
  setEditingId: (id: string | null) => void;
  setForm: (f: ToolForm) => void;
  setDialogOpen: (v: boolean) => void;
  closeMenu: () => void;
}

export function useRegistryBrowser({ regServersRaw, setSnackbar, setEditingId, setForm, setDialogOpen, closeMenu }: Deps) {
  const dispatch = useAppDispatch();

  const [registryOpen, setRegistryOpen] = useState(false);
  const [regQuery, setRegQuery] = useState('');
  const [regSort, setRegSort] = useState<'name' | 'stars'>('stars');
  // Default 'curated' hides the long tail; client-side filter, backend still returns the full list.
  const [regSource, setRegSource] = useState<RegSource>('curated');
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const [mcpConfigServer, setMcpConfigServer] = useState<McpServer | null>(null);
  const [mcpAuthType, setMcpAuthType] = useState<'none' | 'env_vars'>('none');
  const [mcpCredentials, setMcpCredentials] = useState<Record<string, string>>({});
  const [mcpConfigJson, setMcpConfigJson] = useState('');
  const [mcpConfigError, setMcpConfigError] = useState('');

  // Translate UI "curated" pseudo-source to "" for the backend; the whitelist is applied client-side.
  const _backendSource = (s: RegSource): '' | 'community' | 'google' =>
    s === 'curated' ? '' : s;

  const openRegistryBrowser = () => {
    closeMenu();
    setRegistryOpen(true);
    setRegQuery('');
    setRegSort('stars');
    setRegSource('');
    setExpandedServer(null);
    dispatch(fetchRegistryStats());
    dispatch(searchRegistry({ q: '', limit: 20, offset: 0, sort: 'stars', source: '' }));
  };

  const handleRegSearch = useCallback((q: string, sort?: 'name' | 'stars', source?: RegSource) => {
    setRegQuery(q);
    setExpandedServer(null);
    const sortVal = sort ?? regSort;
    const sourceVal = source ?? regSource;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch(searchRegistry({ q, limit: 20, offset: 0, sort: sortVal, source: _backendSource(sourceVal) }));
    }, 300);
  }, [dispatch, regSort, regSource]);

  const handleLoadMore = () => {
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: regServersRaw.length, sort: regSort, source: _backendSource(regSource) }));
  };

  const handleRegSort = (sort: 'name' | 'stars') => {
    setRegSort(sort);
    setExpandedServer(null);
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort, source: _backendSource(regSource) }));
  };

  const handleRegSourceFilter = (_: React.MouseEvent<HTMLElement>, val: RegSource) => {
    if (val === null) return;
    setRegSource(val);
    setExpandedServer(null);
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort: regSort, source: _backendSource(val) }));
  };

  const openMcpConfigDialog = (srv: McpServer) => {
    setMcpConfigServer(srv);
    setMcpAuthType('none');
    setMcpCredentials({});
    const derivedConfig = serverToMcpConfig(srv);
    setMcpConfigJson(JSON.stringify(
      Object.keys(derivedConfig).length > 0 ? derivedConfig : {},
      null, 2,
    ));
    setMcpConfigError('');
    setMcpConfigOpen(true);
  };

  const handleMcpConfigSave = async () => {
    if (!mcpConfigServer) return;
    let parsedConfig: Record<string, any> = {};
    try { parsedConfig = JSON.parse(mcpConfigJson); } catch { setMcpConfigError('Invalid JSON'); return; }

    const f = serverToToolForm(mcpConfigServer);
    const authStatus = 'configured';

    await dispatch(createTool({
      name: f.name,
      description: f.description,
      command: '',
      mcp_config: parsedConfig,
      credentials: mcpCredentials,
      auth_type: mcpAuthType,
      auth_status: authStatus,
    }));

    setMcpConfigOpen(false);
    setSnackbar({ open: true, message: `Installed "${f.name}" as MCP tool` });
  };

  const handleInstall = async (srv: McpServer) => {
    const f = serverToToolForm(srv);
    const mcpConfig = serverToMcpConfig(srv);
    const hasConfig = Object.keys(mcpConfig).length > 0;

    if (srv.source === 'google' && srv.remoteUrl && hasConfig) {
      await dispatch(createTool({
        name: f.name,
        description: f.description,
        command: '',
        mcp_config: mcpConfig,
        credentials: {},
        auth_type: 'oauth2',
        auth_status: 'configured',
      }));
      setSnackbar({ open: true, message: `Installed "${f.name}", click "Connect Google" to authorize` });
    } else if (hasConfig && mcpConfig.type === 'stdio') {
      const result = await dispatch(createTool({
        name: f.name,
        description: f.description,
        command: '',
        mcp_config: mcpConfig,
        credentials: {},
        auth_type: 'none',
        auth_status: 'configured',
      }));
      if (createTool.fulfilled.match(result)) {
        const newTool = result.payload;
        setSnackbar({ open: true, message: `Installed "${f.name}", discovering tools…` });
        const discoverResult = await dispatch(discoverTools(newTool.id));
        if (discoverTools.fulfilled.match(discoverResult)) {
          setSnackbar({ open: true, message: `${f.name} ready, tools discovered` });
        } else {
          const detail = (discoverResult as any).error?.message
            || 'discovery failed; the MCP server may need setup first';
          setSnackbar({ open: true, message: `${f.name}: ${detail}`, severity: 'error' });
        }
      }
    } else {
      openMcpConfigDialog(srv);
    }
  };

  const handleEditInstall = (srv: McpServer) => {
    setRegistryOpen(false);
    const f = serverToToolForm(srv);
    setEditingId(null);
    setForm(f);
    setDialogOpen(true);
  };

  return {
    registryOpen, setRegistryOpen, regQuery, regSort, regSource, expandedServer, setExpandedServer,
    mcpConfigOpen, setMcpConfigOpen, mcpConfigServer, mcpAuthType, setMcpAuthType, mcpCredentials, setMcpCredentials,
    mcpConfigJson, setMcpConfigJson, mcpConfigError, setMcpConfigError,
    openRegistryBrowser, handleRegSearch, handleLoadMore, handleRegSort, handleRegSourceFilter,
    handleMcpConfigSave, handleInstall, handleEditInstall,
  };
}
