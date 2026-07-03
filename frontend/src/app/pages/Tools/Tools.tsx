import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Menu from '@mui/material/Menu';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
import LockIcon from '@mui/icons-material/Lock';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import StorefrontIcon from '@mui/icons-material/Storefront';
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
import { Integration, INTEGRATIONS } from './integrations';
import { CATEGORY_ORDER } from './toolsHelpers';
import ToolSection from './cards/ToolSection';
import BrowserPermissionCard from './cards/BrowserPermissionCard';
import RegistryBrowserDialog from './dialogs/RegistryBrowserDialog';
import ToolDialogs from './dialogs/ToolDialogs';
import CustomToolCard from './cards/CustomToolCard';
import IntegrationGalleryCard from './cards/IntegrationGalleryCard';
import { useToolsActions } from './hooks/useToolsActions';
import { useBuiltinSections } from './hooks/useBuiltinSections';

const Tools: React.FC = () => {
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
  const [customSectionOpen, setCustomSectionOpen] = useState(true);
  const [browserSectionOpen, setBrowserSectionOpen] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState<Record<string, boolean>>({ browser_delegation: true, browser_action: true });
  const [builtinSectionOpen, setBuiltinSectionOpen] = useState(true);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

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

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => setMenuAnchor(e.currentTarget);
  const handleMenuClose = () => setMenuAnchor(null);

  const a = useToolsActions({ items, allTools, regServersRaw, closeMenu: handleMenuClose });

  // Curated whitelist matches the MCPSearch alias map in main.py (mcp-meta).
  const CURATED_MCP_NAMES = useMemo(() => new Set([
    'google-workspace', 'microsoft-365', 'slack', 'discord',
    'notion', 'airtable', 'hubspot', 'reddit', 'youtube',
  ]), []);
  const regServers = useMemo(() => {
    if (a.regSource !== 'curated') return regServersRaw;
    return regServersRaw.filter((srv: any) => {
      const id = (srv?.name || srv?.id || '').toLowerCase();
      return CURATED_MCP_NAMES.has(id);
    });
  }, [regServersRaw, a.regSource, CURATED_MCP_NAMES]);

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ color: c.text.primary, fontWeight: 700, mb: 0.5 }}>Tool Library</Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem' }}>Define and manage custom tools for your Claude Code agents.</Typography>
        </Box>
        <Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 18 }} />}
            onClick={handleMenuOpen}
            sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', borderRadius: 2 }}
          >
            New Tool
          </Button>
          <Menu
            anchorEl={menuAnchor}
            open={!!menuAnchor}
            onClose={handleMenuClose}
            PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 2, mt: 0.5, minWidth: 200 } }}
          >
            <MenuItem onClick={a.openCreate} sx={{ color: c.text.primary, fontSize: '0.88rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <BuildIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Create Custom
            </MenuItem>
            <MenuItem onClick={a.openRegistryBrowser} sx={{ color: c.text.primary, fontSize: '0.88rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <StorefrontIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Browse MCP Registry
            </MenuItem>
          </Menu>
        </Box>
      </Box>

      <Box sx={{ mb: 3 }}>
        <Box
          onClick={() => setBuiltinSectionOpen((v) => !v)}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, cursor: 'pointer', userSelect: 'none', '&:hover .section-arrow': { color: c.text.secondary } }}
        >
          {builtinSectionOpen ? <KeyboardArrowDownIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} /> : <KeyboardArrowRightIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} />}
          <LockIcon sx={{ fontSize: 14, color: c.text.tertiary }} />
          <Typography sx={{ color: c.text.muted, fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Built-in</Typography>
          <Chip label={coreTools.length + deferredTools.length + browserTools.length} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 18, minWidth: 24, '& .MuiChip-label': { px: 0.8 } }} />
        </Box>
        <Collapse in={builtinSectionOpen} timeout={0} unmountOnExit>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pl: 1 }}>

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

          </Box>
        </Collapse>
      </Box>

      <Box sx={{ mb: 2 }}>
        <Box onClick={() => setCustomSectionOpen((v) => !v)} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, cursor: 'pointer', userSelect: 'none', '&:hover .section-arrow': { color: c.text.secondary } }}>
          {customSectionOpen ? <KeyboardArrowDownIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} /> : <KeyboardArrowRightIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} />}
          <BuildIcon sx={{ fontSize: 14, color: c.text.tertiary }} />
          <Typography sx={{ color: c.text.muted, fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Connections</Typography>
          <Chip label={tools.length + uninstalledIntegrations.length} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 18, minWidth: 24, '& .MuiChip-label': { px: 0.8 } }} />
        </Box>
        <Collapse in={customSectionOpen} timeout={0} unmountOnExit>
          {loading ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pl: 1, mt: 1 }}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} variant="card" height={72} />
              ))}
            </Box>
          ) : (tools.length === 0 && uninstalledIntegrations.length === 0) ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 6, color: c.text.ghost, gap: 1.5 }}>
              <BuildIcon sx={{ fontSize: 40, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.9rem' }}>No custom tools defined yet. Create one to get started.</Typography>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pl: 1 }}>
              {uninstalledIntegrations.map((ig) => (
                <IntegrationGalleryCard
                  key={ig.id}
                  integration={ig}
                  isLoading={!!a.integrationLoading[ig.id]}
                  onToggle={a.handleIntegrationToggle}
                />
              ))}
              {tools.map((tool) => (
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
            </Box>
          )}
        </Collapse>
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
