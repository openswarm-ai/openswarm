import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import LockIcon from '@mui/icons-material/Lock';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchTools,
  fetchBuiltinTools,
  fetchBuiltinPermissions,
  ToolDefinition,
} from '@/shared/state/toolsSlice';
import {
  fetchServerDetail,
  clearDetail,
} from '@/shared/state/mcpRegistrySlice';
import { Skeleton } from '@/app/components/feedback/Loading';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { INTEGRATIONS } from './integrations';
import { CATEGORY_ORDER } from './toolsHelpers';
import ToolSection from './cards/ToolSection';
import BrowserPermissionCard from './cards/BrowserPermissionCard';
import AgentWorkflowsSection from './cards/AgentWorkflowsSection';
import RegistryBrowserDialog from './dialogs/RegistryBrowserDialog';
import ToolsAddMenu from './dialogs/ToolsAddMenu';
import ToolDialogs from './dialogs/ToolDialogs';
import CustomToolCard from './cards/CustomToolCard';
import PopularConnectorsRow from './cards/PopularConnectorsRow';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import SearchIcon from '@mui/icons-material/Search';
import IntegrationGalleryCard from './cards/IntegrationGalleryCard';
import { useToolsActions } from './hooks/useToolsActions';
import { useBuiltinSections } from './hooks/useBuiltinSections';
import { useConnectorFilters } from './hooks/useConnectorFilters';
import { useCuratedRegistry } from './hooks/useCuratedRegistry';

interface ToolsProps {
  /** Provided when hosted inside the Marketplace: Browse connectors switches the view in place. */
  onBrowseConnectors?: () => void;
  /** Connector to expand when returning from the Marketplace browse grid. */
  expandToolId?: string | null;
}

const Tools: React.FC<ToolsProps> = ({ onBrowseConnectors, expandToolId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { items, builtinTools, builtinPermissions, loading } = useAppSelector((s) => s.tools);
  const { servers: regServersRaw, total: regTotal, loading: regLoading, stats: regStats, detail: regDetail, detailLoading: regDetailLoading } = useAppSelector((s) => s.mcpRegistry);
  const devMode = useAppSelector((s) => s.settings.data.dev_mode);
  const allTools = Object.values(items);
  // Stable order so cards don't jump on refetch: connected+on, then on, then off; A-Z within each tier.
  const tools = useMemo(() => {
    const tier = (t: ToolDefinition) => (t.enabled === false ? 2 : t.auth_status === 'connected' ? 0 : 1);
    return Object.values(items).sort((a, b) => tier(a) - tier(b) || (a.name || '').localeCompare(b.name || ''));
  }, [items]);
  const uninstalledIntegrations = useMemo(() => INTEGRATIONS.filter((ig) => !allTools.find((t) => t.name === ig.name)), [allTools]);
  const getIntegrationForTool = useCallback((tool: ToolDefinition) => INTEGRATIONS.find((ig) => ig.name === tool.name), []);

  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>(
    Object.fromEntries([
      ...CATEGORY_ORDER.map((cat) => [cat, true]),
      ...CATEGORY_ORDER.map((cat) => [`d_${cat}`, true]),
    ]),
  );
  const [expandedBuiltin, setExpandedBuiltin] = useState<string | null>(null);
  const [coreSectionOpen, setCoreSectionOpen] = useState(false);
  const [deferredSectionOpen, setDeferredSectionOpen] = useState(false);
  const [browserSectionOpen, setBrowserSectionOpen] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState<Record<string, boolean>>({ browser_delegation: true, browser_action: true });
  // claude.ai's Connectors page tabs: All / Connected / Not connected.
  const { connFilter, setConnFilter, searchOpen, setSearchOpen, searchQ, setSearchQ, q, visibleTools, visibleGallery, popularUninstalled } = useConnectorFilters(tools, uninstalledIntegrations);

  useEffect(() => {
    dispatch(fetchTools());
    dispatch(fetchBuiltinTools());
    dispatch(fetchBuiltinPermissions());
  }, [dispatch]);

  const {
    coreTools, deferredTools, browserTools, browserDelegationTools, browserActionTools,
    groupedCore, groupedDeferred, coreSectionEnabled, deferredSectionEnabled, browserSectionEnabled,
  } = useBuiltinSections(builtinTools, builtinPermissions);

  const toggleCategory = (cat: string) => setCollapsedCategories((p) => ({ ...p, [cat]: !p[cat] }));
  const toggleBuiltinExpand = (name: string) => setExpandedBuiltin((p) => (p === name ? null : name));
  // The Add menu closes itself now (ToolsAddMenu), so the hook's closeMenu hook-in is a no-op.
  const a = useToolsActions({ items, allTools, regServersRaw, closeMenu: () => {} });

  useEffect(() => { if (expandToolId) a.setExpandedToolId(expandToolId); }, [expandToolId]);

  const regServers = useCuratedRegistry(regServersRaw, a.regSource);

  return (
    <Box sx={{ px: 3, pt: 1, pb: 3, height: '100%', overflow: 'auto' }}>
      {/* claude.ai's Connectors page grammar: filter pills left, Add right, one table below. */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {([['all', 'All'], ['connected', 'Connected'], ['not-connected', 'Not connected']] as const).map(([value, label]) => (
            <Box
              key={value}
              role="button"
              onClick={() => setConnFilter(value)}
              sx={{
                px: 1.5, py: 0.4, borderRadius: 999, cursor: 'pointer', userSelect: 'none',
                fontSize: '0.8125rem', fontWeight: 600, lineHeight: 1.6,
                color: connFilter === value ? c.text.primary : c.text.tertiary,
                bgcolor: connFilter === value ? c.bg.secondary : 'transparent',
                '&:hover': { color: c.text.primary },
              }}
            >
              {label}
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {searchOpen ? (
          <TextField
            autoFocus
            size="small"
            placeholder="Search connectors..."
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onBlur={() => { if (!searchQ.trim()) setSearchOpen(false); }}
            sx={{ width: 240, '& .MuiOutlinedInput-root': { fontSize: '0.875rem', borderRadius: 999, '& input': { py: 0.6 } } }}
          />
        ) : (
          <IconButton size="small" onClick={() => setSearchOpen(true)} sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
            <SearchIcon sx={{ fontSize: 19 }} />
          </IconButton>
        )}
        <ToolsAddMenu
          devMode={!!devMode}
          onBrowseConnectors={onBrowseConnectors}
          onOpenCreate={a.openCreate}
          onOpenRegistry={a.openRegistryBrowser}
          onSnackbar={(message, severity) => a.setSnackbar({ open: true, message, severity: severity === 'error' ? 'error' : undefined })}
        />
        </Box>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 1 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} variant="card" height={72} />
          ))}
        </Box>
      ) : (
        <>
        {connFilter === 'all' && !q && (
          <PopularConnectorsRow integrations={popularUninstalled} loading={a.integrationLoading} onConnect={a.handleIntegrationToggle} />
        )}
        <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: '12px', overflow: 'hidden', bgcolor: c.bg.surface }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px 200px', gap: 2, px: 2, py: 1.1, borderBottom: `1px solid ${c.border.subtle}` }}>
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.8125rem' }}>Connector</Typography>
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.8125rem' }}>Type</Typography>
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.8125rem', textAlign: 'right' }}>Status</Typography>
          </Box>
          {connFilter === 'all' && !q && (
            <>
      {coreTools.length > 0 && (
        <ToolSection label="Core Tools" icon={<LockIcon sx={{ fontSize: 14, color: c.text.tertiary }} />} count={coreTools.length} open={coreSectionOpen} onToggle={() => setCoreSectionOpen((v) => !v)} grouped={groupedCore} collapsedCategories={collapsedCategories} toggleCategory={toggleCategory} expandedBuiltin={expandedBuiltin} toggleBuiltinExpand={toggleBuiltinExpand} builtinPermissions={builtinPermissions} onPermissionChange={a.handleBuiltinPermissionChange} onCategoryPermissionChange={a.handleBuiltinCategoryPermissionChange} enabled={coreSectionEnabled} onEnabledChange={(v) => a.handleSectionEnabledChange(coreTools, v)} />
      )}

      {deferredTools.length > 0 && (
        <ToolSection label="Extended Tools" icon={<HourglassEmptyIcon sx={{ fontSize: 14, color: c.text.tertiary }} />} count={deferredTools.length} open={deferredSectionOpen} onToggle={() => setDeferredSectionOpen((v) => !v)} grouped={groupedDeferred} collapsedCategories={collapsedCategories} toggleCategory={toggleCategory} expandedBuiltin={expandedBuiltin} toggleBuiltinExpand={toggleBuiltinExpand} deferred builtinPermissions={builtinPermissions} onPermissionChange={a.handleBuiltinPermissionChange} onCategoryPermissionChange={a.handleBuiltinCategoryPermissionChange} enabled={deferredSectionEnabled} onEnabledChange={(v) => a.handleSectionEnabledChange(deferredTools, v)} />
      )}

      {browserTools.length > 0 && (
        <BrowserPermissionCard
          open={browserSectionOpen}
          enabled={browserSectionEnabled}
          onToggleOpen={() => setBrowserSectionOpen((v) => !v)}
          browserTools={browserTools}
          browserDelegationTools={browserDelegationTools}
          browserActionTools={browserActionTools}
          browserCollapsed={browserCollapsed}
          setBrowserCollapsed={setBrowserCollapsed}
          builtinPermissions={builtinPermissions}
          onSectionEnabledChange={a.handleSectionEnabledChange}
          onCategoryPermissionChange={a.handleBuiltinCategoryPermissionChange}
          onPermissionChange={a.handleBuiltinPermissionChange}
        />
      )}
            </>
          )}
              {visibleTools.map((tool) => (
                <CustomToolCard
                  key={tool.id}
                  tool={tool}
                  ig={getIntegrationForTool(tool)}
                  isExpanded={a.expandedToolId === tool.id}
                  onToggleExpand={(toolId, wasExpanded) => a.setExpandedToolId(wasExpanded ? null : toolId)}
                  expandedServices={a.expandedServices}
                  setExpandedServices={a.setExpandedServices}
                  expandedSchema={a.expandedSchema}
                  setExpandedSchema={a.setExpandedSchema}
                  devMode={devMode}
                  integrationLoading={a.integrationLoading}
                  discovering={a.discovering}
                  onPermissionChange={a.handlePermissionChange}
                  onGroupPermissionChange={a.handleGroupPermissionChange}
                  onBulkReadOnly={a.handleBulkReadOnly}
                  onResetPermissions={a.handleResetPermissions}
                  onDiscover={a.handleDiscover}
                  onIntegrationToggle={a.handleIntegrationToggle}
                  onOAuthConnect={a.handleOAuthConnect}
                  onDeviceCodeConnect={a.handleDeviceCodeConnect}
                  onM365Disconnect={a.handleM365Disconnect}
                  onDisconnectIntegration={a.handleDisconnectIntegration}
                  onOpenCredentialsDialog={a.openCredentialsDialog}
                  onEdit={a.openEdit}
                  onDelete={a.handleDelete}
                />
              ))}
              {visibleGallery.map((ig) => (
                <IntegrationGalleryCard
                  key={ig.id}
                  integration={ig}
                  isLoading={!!a.integrationLoading[ig.id]}
                  onToggle={a.handleIntegrationToggle}
                />
              ))}
          {connFilter !== 'all' && visibleTools.length === 0 && visibleGallery.length === 0 && (
            <Box sx={{ px: 2, py: 4, textAlign: 'center' }}>
              <Typography sx={{ fontSize: '0.875rem', color: c.text.ghost }}>Nothing {connFilter === 'connected' ? 'connected' : 'disconnected'} yet.</Typography>
            </Box>
          )}
        </Box>
        </>
      )}

      <Box sx={{ mt: 3 }}>
        <AgentWorkflowsSection />
      </Box>

      <ToolDialogs
        {...a}
        onSave={a.handleSave}
        onMcpConfigSave={a.handleMcpConfigSave}
        onSlackAutoConnect={a.handleSlackAutoConnect}
        onCredentialsSave={a.handleCredentialsSave}
      />


      <RegistryBrowserDialog
        open={a.registryOpen}
        onClose={() => a.setRegistryOpen(false)}
        regStats={regStats}
        regSource={a.regSource}
        devMode={devMode}
        regQuery={a.regQuery}
        onRegSearch={a.handleRegSearch}
        regSort={a.regSort}
        onRegSort={a.handleRegSort}
        onRegSourceFilter={a.handleRegSourceFilter}
        regLoading={regLoading}
        regServers={regServers}
        regTotal={regTotal}
        allTools={allTools}
        expandedServer={a.expandedServer}
        onExpandServer={(srv, next) => {
          a.setExpandedServer(next);
          if (next && devMode) {
            dispatch(clearDetail());
            dispatch(fetchServerDetail(srv.name));
          }
        }}
        regDetail={regDetail}
        regDetailLoading={regDetailLoading}
        onInstall={a.handleInstall}
        onEditInstall={a.handleEditInstall}
        onLoadMore={a.handleLoadMore}
      />

      <Snackbar
        open={a.snackbar.open}
        autoHideDuration={3000}
        onClose={() => a.setSnackbar({ open: false, message: '' })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => a.setSnackbar({ open: false, message: '' })} severity={a.snackbar.severity || 'success'} sx={{ bgcolor: a.snackbar.severity === 'error' ? '#2e1a1a' : c.status.successBg, color: a.snackbar.severity === 'error' ? '#f87171' : c.status.success, border: `1px solid ${a.snackbar.severity === 'error' ? '#ef444440' : `${c.status.success}40`}` }}>
          {a.snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Tools;
