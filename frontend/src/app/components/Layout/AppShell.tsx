import React, { useState, useEffect, useRef, useCallback, startTransition, useMemo } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import Box from '@mui/material/Box';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import InputBase from '@mui/material/InputBase';
// One outlined icon language for the sidebar: thin monoline glyphs (not the
// filled Material clip-art) so the rail reads as designed, not assembled.
import { LayoutDashboard } from 'lucide-react';
import PsychologyIcon from '@mui/icons-material/PsychologyOutlined';
import BuildIcon from '@mui/icons-material/BuildOutlined';
import TuneIcon from '@mui/icons-material/TuneOutlined';
import { LayoutGrid } from 'lucide-react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Settings as LucideSettings } from 'lucide-react';
import { Palette } from 'lucide-react';
import { ArrowLeft, ArrowRight, Plus } from 'lucide-react';
import { AnimatedPanelLeft } from './animatedIcons';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CloseIcon from '@mui/icons-material/Close';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
// Settings modal lazy-loaded so its 2.3K LOC + Stripe/OAuth helpers don't ship on first paint.
const Settings = React.lazy(() => import('@/app/pages/Settings/Settings'));
import DynamicIsland from '@/app/components/overlays/DynamicIsland';
import Dashboard from '@/app/pages/Dashboard/Dashboard';
import DashboardHost from '@/app/components/Layout/DashboardHost';
import { useLastDashboardId } from '@/shared/hooks/useLastDashboardId';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { shallowEqual } from 'react-redux';
import { fetchDashboards, createDashboard, renameDashboard } from '@/shared/state/dashboardsSlice';
import { Typewriter } from '@/app/components/feedback/Animated';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { addBrowserCard, addBrowserTab } from '@/shared/state/dashboardLayoutSlice';
import { setPendingBrowserUrl } from '@/shared/state/tempStateSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { setInstalling } from '@/shared/state/updateSlice';
import { findBrowserByWebContentsId } from '@/shared/browserRegistry';
import { byPreviewRecency } from '@/shared/previewOrder';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ErrorSlime } from '@/app/components/feedback/ErrorSlime';

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 400;
// 260 matches Claude.ai's nav-sidebar width: roomy enough that names don't truncate.
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_WIDTH_KEY = 'openswarm-sidebar-width';
const UPDATE_DISMISS_KEY = 'openswarm-update-dismissed';

const CUSTOMIZATION_ITEMS = [
  { label: 'Skills', path: '/skills', icon: <PsychologyIcon />, onboarding: 'sidebar-skills' },
  { label: 'Actions', path: '/actions', icon: <BuildIcon />, onboarding: 'sidebar-actions' },
  { label: 'Modes', path: '/modes', icon: <TuneIcon />, onboarding: 'sidebar-modes' },
];

const CUSTOMIZATION_PATHS = new Set(CUSTOMIZATION_ITEMS.map((i) => i.path));

const AppShell: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigateRaw = useNavigate();
  // startTransition wrapper: route swap becomes non-urgent so click handler returns immediately; eliminates the "click, wait, page appears" gap on slow routes.
  const navigate = useMemo(() => {
    const fn = (...args: Parameters<typeof navigateRaw>) => {
      startTransition(() => {
        (navigateRaw as any)(...args);
      });
    };
    return fn as typeof navigateRaw;
  }, [navigateRaw]);
  const location = useLocation();
  const [dashboardsExpanded, setDashboardsExpanded] = useState(true);
  const [appsExpanded, setAppsExpanded] = useState(true);
  // Collapsed by default: config rows are progressive disclosure, not daily nav. Onboarding reads data-expanded and clicks to open when it needs them.
  const [customizationExpanded, setCustomizationExpanded] = useState(false);
  // Starts collapsed so a fresh boot lands on a clean canvas; the toggle brings it back.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [renamingDashboardId, setRenamingDashboardId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (stored) {
        const w = Number(stored);
        if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) return w;
      }
    } catch {}
    return SIDEBAR_DEFAULT;
  });
  const isResizing = useRef(false);

  const updateStatus = useAppSelector((state) => state.update.status);
  const availableVersion = useAppSelector((state) => state.update.availableVersion);
  const downloadPercent = useAppSelector((state) => state.update.downloadPercent);
  const installing = useAppSelector((state) => state.update.installing);

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try { return localStorage.getItem(UPDATE_DISMISS_KEY); } catch { return null; }
  });
  const [snackbarDismissed, setSnackbarDismissed] = useState(false);

  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // /agents/models intersects BUILTIN_MODELS with API keys + 9Router state; non-empty means at least one usable model.
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);
  const hasModelConnected = Object.keys(modelsByProvider).length > 0;
  // Wait for initial fetch to land before flashing the banner.
  const showWarningBanner = !isOnline || (modelsLoaded && !hasModelConnected);

  const bannerDismissedForVersion = availableVersion != null && dismissedVersion === availableVersion;
  const isUpdateActionable = updateStatus === 'available' || updateStatus === 'downloaded' || updateStatus === 'downloading';

  const showUpdateDot = (updateStatus === 'available' || updateStatus === 'downloaded') && !bannerDismissedForVersion;
  const showUpdateBanner = isUpdateActionable && !bannerDismissedForVersion;
  const showUpdateSnackbar = (updateStatus === 'available' || updateStatus === 'downloaded') && !bannerDismissedForVersion && !snackbarDismissed;

  const handleDismissBanner = useCallback(() => {
    if (availableVersion) {
      try { localStorage.setItem(UPDATE_DISMISS_KEY, availableVersion); } catch {}
      setDismissedVersion(availableVersion);
    }
  }, [availableVersion]);

  const handleDownloadUpdate = useCallback(async () => {
    try { await (window as any).openswarm?.downloadUpdate(); } catch {}
  }, []);

  const handleInstallUpdate = useCallback(() => {
    if (installing) return;
    dispatch(setInstalling());
    (window as any).openswarm?.installUpdate();
  }, [installing, dispatch]);

  // shallowEqual on top-level Immer dicts: nested mutations bump the dict reference, causing AppShell to re-render on every rename/output bump despite identical structure.
  const dashboardItems = useAppSelector(
    (state) => state.dashboards.items,
    shallowEqual,
  );
  const dashboardList = React.useMemo(
    () => Object.values(dashboardItems).sort(byPreviewRecency),
    [dashboardItems],
  );

  const outputItems = useAppSelector(
    (state) => state.outputs.items,
    shallowEqual,
  );
  const appsList = React.useMemo(
    () => Object.values(outputItems).sort(byPreviewRecency),
    [outputItems],
  );

  useEffect(() => {
    dispatch(fetchDashboards());
    dispatch(fetchOutputs());
  }, [dispatch]);

  // Idle-prefetch the lazy Settings chunk so click-to-open is instant; requestIdleCallback avoids fighting first-paint.
  useEffect(() => {
    const ric = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1500));
    const handle = ric(() => {
      import('@/app/pages/Settings/Settings').catch(() => {});
    }, { timeout: 3000 });
    return () => {
      const cic = (window as any).cancelIdleCallback || clearTimeout;
      try { cic(handle); } catch {}
    };
  }, []);

  const openUrlInBrowser = useCallback((url: string, webContentsId?: number) => {
    const dashMatch = location.pathname.match(/^\/dashboard\/(.+)/);
    if (dashMatch) {
      if (webContentsId != null) {
        const browserId = findBrowserByWebContentsId(webContentsId);
        if (browserId) {
          dispatch(addBrowserTab({ browserId, url, makeActive: true }));
          return;
        }
      }
      dispatch(addBrowserCard({ url }));
    } else {
      dispatch(setPendingBrowserUrl(url));
      const lastId = (window as any).__openswarm_last_dashboard_id as string | undefined;
      const firstDashboard = dashboardList[0];
      const targetId = lastId || firstDashboard?.id;
      if (targetId) {
        navigate(`/dashboard/${targetId}`);
      } else {
        dispatch(createDashboard('Untitled Dashboard')).then((result: any) => {
          if (createDashboard.fulfilled.match(result)) {
            navigate(`/dashboard/${result.payload.id}`);
          }
        });
      }
    }
  }, [location.pathname, dashboardList, dispatch, navigate]);

  useEffect(() => {
    let lastUrl = '';
    let lastTime = 0;

    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      if (href.startsWith('http://localhost:')) return;

      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      if (href === lastUrl && now - lastTime < 1000) return;
      lastUrl = href;
      lastTime = now;

      openUrlInBrowser(href);
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [openUrlInBrowser]);

  useEffect(() => {
    const w = window as any;
    if (!w.openswarm?.onWebviewNewWindow) return;
    let lastUrl = '';
    let lastTime = 0;
    return w.openswarm.onWebviewNewWindow((url: string, webContentsId: number) => {
      const now = Date.now();
      if (url === lastUrl && now - lastTime < 1000) return;
      lastUrl = url;
      lastTime = now;
      openUrlInBrowser(url, webContentsId);
    });
  }, [openUrlInBrowser]);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const { sessionId, dashboardId } = detail as { sessionId?: string; dashboardId?: string };
      if (!sessionId) return;
      if (dashboardId) {
        navigate(`/dashboard/${dashboardId}`);
      }
      dispatch(setPendingFocusAgentId(sessionId));
    };
    window.addEventListener('openswarm:notification-click', handler as EventListener);
    return () => window.removeEventListener('openswarm:notification-click', handler as EventListener);
  }, [navigate, dispatch]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)));
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleResizeDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
  }, []);

  const isDashboardRoute = location.pathname === '/' || location.pathname.startsWith('/dashboard/');
  const isDashboardViewActive = location.pathname.startsWith('/dashboard/');
  const isAppsRoute = location.pathname === '/apps' || location.pathname.startsWith('/apps/');
  const isCustomizationRoute = location.pathname === '/customization' || CUSTOMIZATION_PATHS.has(location.pathname);
  const activeDashboardId = location.pathname.startsWith('/dashboard/')
    ? location.pathname.split('/dashboard/')[1]
    : null;

  const [lastDashboardId, setLastDashboardId] = useLastDashboardId();
  const activeAppId = location.pathname.startsWith('/apps/')
    ? location.pathname.split('/apps/')[1]
    : null;

  const handleDashboardsClick = () => {
    if (isDashboardRoute && location.pathname === '/') {
      setDashboardsExpanded((prev) => !prev);
    } else {
      navigate('/');
      setDashboardsExpanded(true);
    }
  };

  const handleDashboardItemClick = (dashboardId: string) => {
    if (renamingDashboardId === dashboardId) return;
    navigate(`/dashboard/${dashboardId}`);
  };

  const handleStartDashboardRename = (id: string, currentName: string) => {
    setRenamingDashboardId(id);
    setRenameValue(currentName);
  };

  const handleDashboardRenameSubmit = (id: string) => {
    const trimmed = renameValue.trim();
    const previousName = dashboardItems[id]?.name;
    if (trimmed && trimmed !== previousName) {
      dispatch(renameDashboard({ id, name: trimmed, previousName }));
    }
    setRenamingDashboardId(null);
  };

  const handleCreateDashboard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await dispatch(createDashboard('Untitled Dashboard'));
    if (createDashboard.fulfilled.match(result)) {
      navigate(`/dashboard/${result.payload.id}`);
    }
  };

  const handleAppsClick = () => {
    if (isAppsRoute && location.pathname === '/apps') {
      setAppsExpanded((prev) => !prev);
    } else {
      navigate('/apps');
      setAppsExpanded(true);
    }
  };

  const handleCreateApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate('/apps/new');
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: c.bg.secondary }}>
      <Box
        sx={{
          height: 38,
          flexShrink: 0,
          bgcolor: 'transparent',
          display: 'flex',
          alignItems: 'center',
          position: 'relative',
          overflow: 'visible',
          WebkitAppRegion: 'drag',
          userSelect: 'none',
          pl: '78px',
          gap: 0.25,
        }}
      >
        <Tooltip title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
          <IconButton
            size="small"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            // Onboarding runtime reads aria-expanded to detect a collapsed sidebar.
            data-onboarding="sidebar-toggle"
            aria-expanded={!sidebarCollapsed}
            sx={{
              WebkitAppRegion: 'no-drag',
              color: c.text.tertiary,
              p: 0.5,
              borderRadius: 1,
              '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
            }}
          >
            <AnimatedPanelLeft size={18} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Back">
          <IconButton
            size="small"
            onClick={() => navigate(-1)}
            sx={{
              WebkitAppRegion: 'no-drag',
              color: c.text.tertiary,
              p: 0.5,
              borderRadius: 1,
              '& svg': { transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)' },
              '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
              '&:hover svg': { transform: 'translateX(-2px)' },
            }}
          >
            <ArrowLeft size={18} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Forward">
          <IconButton
            size="small"
            onClick={() => navigate(1)}
            sx={{
              WebkitAppRegion: 'no-drag',
              color: c.text.tertiary,
              p: 0.5,
              borderRadius: 1,
              '& svg': { transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)' },
              '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
              '&:hover svg': { transform: 'translateX(2px)' },
            }}
          >
            <ArrowRight size={18} />
          </IconButton>
        </Tooltip>

        <DynamicIsland />

        <Box sx={{ flex: 1 }} />

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            pr: 1.5,
            WebkitAppRegion: 'no-drag',
          }}
        >
          <Box
            component="img"
            src="./logo.png"
            alt="OpenSwarm"
            sx={{ width: 20, height: 20, borderRadius: 0.5, opacity: 0.85 }}
          />
          <Typography
            sx={{
              color: c.text.secondary,
              fontSize: '0.9rem',
              fontWeight: 600,
              letterSpacing: 0.2,
              lineHeight: 1,
            }}
          >
            OpenSwarm
          </Typography>
        </Box>
      </Box>

      <Collapse in={showWarningBanner} timeout={350} unmountOnExit>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 0.6,
            bgcolor: 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.18)',
            flexShrink: 0,
            animation: showWarningBanner ? 'warning-fade-in 0.4s ease-out' : undefined,
            '@keyframes warning-fade-in': {
              from: { opacity: 0 },
              to: { opacity: 1 },
            },
          }}
        >
          <ErrorSlime size={22} />
          <Typography sx={{ fontSize: '0.86rem', color: '#ef4444', flex: 1, fontWeight: 500, letterSpacing: '0.01em' }}>
            {!isOnline
              ? 'No internet connection; agents cannot reach AI models or external services'
              : (
                <>
                  No AI model connected.{' '}
                  <Box
                    component="span"
                    onClick={() => dispatch(openSettingsModal('models'))}
                    sx={{
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      fontWeight: 600,
                      '&:hover': { opacity: 0.8 },
                      transition: 'opacity 0.15s',
                    }}
                  >
                    Configure models
                  </Box>
                  {' '}to get started
                </>
              )}
          </Typography>
        </Box>
      </Collapse>

      {showUpdateBanner && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 0.5,
            bgcolor: `${c.accent.primary}14`,
            borderBottom: `1px solid ${c.accent.primary}30`,
            flexShrink: 0,
          }}
        >
          <SystemUpdateAltIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.8rem', color: c.text.secondary, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {updateStatus === 'available' && `OpenSwarm ${availableVersion} is available`}
            {updateStatus === 'downloading' && `Downloading OpenSwarm ${availableVersion}…`}
            {updateStatus === 'downloaded' && `OpenSwarm ${availableVersion} will install when you quit`}
          </Typography>
          {updateStatus === 'downloading' && (
            <LinearProgress
              variant="determinate"
              value={downloadPercent}
              sx={{
                width: 120,
                height: 3,
                flexShrink: 0,
                borderRadius: 2,
                bgcolor: `${c.accent.primary}20`,
                '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary, borderRadius: 2 },
              }}
            />
          )}
          {updateStatus === 'downloading' && (
            <Typography sx={{ fontSize: '0.72rem', color: c.text.tertiary, flexShrink: 0 }}>
              {Math.round(downloadPercent)}%
            </Typography>
          )}
          {updateStatus === 'available' && (
            <Button
              size="small"
              variant="contained"
              onClick={handleDownloadUpdate}
              sx={{
                bgcolor: c.accent.primary,
                '&:hover': { bgcolor: c.accent.pressed },
                textTransform: 'none',
                fontSize: '0.75rem',
                fontWeight: 600,
                borderRadius: 1.5,
                minWidth: 'auto',
                py: 0.25,
                px: 1.5,
                lineHeight: 1.5,
                flexShrink: 0,
              }}
            >
              Download
            </Button>
          )}
          {updateStatus === 'downloaded' && (
            <Button
              size="small"
              variant="contained"
              onClick={handleInstallUpdate}
              disabled={installing}
              startIcon={installing ? <CircularProgress size={12} sx={{ color: '#fff' }} /> : undefined}
              sx={{
                bgcolor: c.accent.primary,
                '&:hover': { bgcolor: c.accent.pressed },
                '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.7 },
                textTransform: 'none',
                fontSize: '0.75rem',
                fontWeight: 600,
                borderRadius: 1.5,
                minWidth: 'auto',
                py: 0.25,
                px: 1.5,
                lineHeight: 1.5,
                flexShrink: 0,
              }}
            >
              {installing ? 'Restarting…' : 'Restart & Update'}
            </Button>
          )}
          <IconButton
            size="small"
            onClick={handleDismissBanner}
            sx={{ color: c.text.tertiary, p: 0.25, flexShrink: 0, '&:hover': { color: c.text.secondary } }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      )}

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {!sidebarCollapsed && (
      <>
      <Box
        sx={{
          width: sidebarWidth,
          flexShrink: 0,
          bgcolor: c.bg.secondary,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box sx={{
          flex: 1,
          overflow: 'auto',
          pt: 0.5,
          '&::-webkit-scrollbar': { width: 0 },
          // Tactile hover: the leading section icon springs once on row-hover, then settles.
          // Interaction-only, never ambient. Scoped to ListItemIcon so the +/chevron stay put.
          '& .MuiListItemIcon-root svg': {
            transition: 'transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1)',
          },
          // Per-glyph hover choreography: each section icon reacts in its own way,
          // springy then settles. Interaction-only, never ambient.
          '& [data-onboarding="sidebar-dashboards"]:hover .MuiListItemIcon-root svg': {
            transform: 'scale(1.14)',
          },
          '& [data-onboarding="sidebar-customization"]:hover .MuiListItemIcon-root svg': {
            transform: 'rotate(-14deg) scale(1.06)',
          },
          '& [data-onboarding="sidebar-apps"]:hover .MuiListItemIcon-root svg': {
            transform: 'rotate(8deg) scale(1.08)',
          },
        }}>
          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={handleDashboardsClick}
              data-onboarding="sidebar-dashboards"
              // Onboarding reads expanded so it skips the click step (re-click would collapse).
              data-expanded={dashboardsExpanded ? 'true' : 'false'}
              aria-expanded={dashboardsExpanded}
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isDashboardRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isDashboardRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isDashboardRoute ? c.accent.primary : c.text.tertiary, minWidth: 28 }}>
                <LayoutDashboard size={18} />
              </ListItemIcon>
              <ListItemText
                primary="Dashboards"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isDashboardRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.9rem',
                    fontWeight: isDashboardRoute ? 600 : 400,
                  },
                }}
              />
              <Tooltip title="New dashboard" placement="right">
                <IconButton
                  size="small"
                  onClick={handleCreateDashboard}
                  sx={{
                    color: c.text.ghost,
                    p: 0.25,
                    mr: 0.25,
                    borderRadius: 1,
                    '&:hover': { color: c.accent.primary, bgcolor: `${c.accent.primary}14` },
                  }}
                >
                  <Plus size={15} />
                </IconButton>
              </Tooltip>
              {dashboardList.length > 0 && (
                <ExpandMoreIcon
                  sx={{
                    color: c.text.ghost,
                    fontSize: 16,
                    transition: 'transform 0.2s',
                    transform: dashboardsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                />
              )}
            </ListItemButton>

            <Collapse in={dashboardsExpanded && dashboardList.length > 0} timeout={200}>
              <Box
                sx={{
                  ml: 2,
                  mt: 0.25,
                  mb: 0.5,
                  maxHeight: 240,
                  overflow: 'auto',
                  '&::-webkit-scrollbar': { width: 3 },
                  '&::-webkit-scrollbar-track': { background: 'transparent' },
                  '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 4 },
                  scrollbarWidth: 'thin',
                  scrollbarColor: `${c.border.medium} transparent`,
                }}
              >
                {dashboardList.map((entry, idx) => {
                  const isActive = activeDashboardId === entry.id;
                  const isRenaming = renamingDashboardId === entry.id;
                  return (
                    <Box
                      key={entry.id}
                      // First row gets generic "first" alias so onboarding can teach "click into a dashboard" without a specific id.
                      data-onboarding={
                        idx === 0 ? 'dashboard-row-first' : `dashboard-row-${entry.id}`
                      }
                      onClick={() => handleDashboardItemClick(entry.id)}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 1,
                        py: isRenaming ? 0.25 : 0.5,
                        mx: 0.5,
                        cursor: isRenaming ? 'default' : 'pointer',
                        // Finder-style selection: the rounded fill is the one active cue, no rail marker.
                        borderRadius: `${c.radius.md}px`,
                        bgcolor: isActive ? `${c.accent.primary}40` : 'transparent',
                        '&:hover': { bgcolor: isActive ? `${c.accent.primary}55` : `${c.text.tertiary}0A` },
                        transition: 'background-color 0.12s',
                      }}
                    >
                      {isRenaming ? (
                        <InputBase
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleDashboardRenameSubmit(entry.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleDashboardRenameSubmit(entry.id);
                            if (e.key === 'Escape') setRenamingDashboardId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => e.target.select()}
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: '0.86rem',
                            fontWeight: isActive ? 500 : 400,
                            color: isActive ? c.text.secondary : c.text.ghost,
                            py: 0,
                            px: 0.5,
                            borderRadius: 0.75,
                            border: `1px solid ${c.accent.primary}80`,
                            bgcolor: `${c.bg.page}`,
                            '& input': {
                              padding: '1px 0',
                            },
                          }}
                        />
                      ) : (
                        <Typography
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            handleStartDashboardRename(entry.id, entry.name);
                          }}
                          sx={{
                            color: isActive ? c.text.secondary : c.text.ghost,
                            fontSize: '0.86rem',
                            fontWeight: isActive ? 500 : 400,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {entry.name}
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

          {/* Sections separate with air, not lines. */}
          <Box sx={{ my: 0.75 }} />

          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={() => {
                if (isCustomizationRoute) {
                  setCustomizationExpanded((prev) => !prev);
                } else {
                  navigate('/customization');
                  setCustomizationExpanded(true);
                }
              }}
              data-onboarding="sidebar-customization"
              data-expanded={customizationExpanded ? 'true' : 'false'}
              aria-expanded={customizationExpanded}
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isCustomizationRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isCustomizationRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isCustomizationRoute ? c.accent.primary : c.text.tertiary, minWidth: 28 }}>
                <Palette size={18} />
              </ListItemIcon>
              <ListItemText
                primary="Customization"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isCustomizationRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.9rem',
                    fontWeight: isCustomizationRoute ? 600 : 400,
                  },
                }}
              />
              <ExpandMoreIcon
                sx={{
                  color: c.text.ghost,
                  fontSize: 16,
                  transition: 'transform 0.2s',
                  transform: customizationExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </ListItemButton>

            <Collapse in={customizationExpanded} timeout={200}>
              <Box sx={{ ml: 2, mt: 0.25, mb: 0.5 }}>
                {CUSTOMIZATION_ITEMS.map((item) => {
                  // Manual click handler instead of NavLink: NavLink's internal navigate bypasses our startTransition wrapper.
                  const isActive = location.pathname === item.path;
                  return (
                    <Box
                      key={item.path}
                      data-onboarding={item.onboarding}
                      onClick={() => navigate(item.path)}
                      onMouseEnter={() => {
                        // Hover-prefetch lazy chunk so click is ~0ms (see Main.tsx for path -> import map).
                        const fn = (window as any).__openswarmPrefetchRoute;
                        if (typeof fn === 'function') fn(item.path);
                      }}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 1,
                        py: 0.5,
                        mx: 0.5,
                        cursor: 'pointer',
                        // 25% accent alpha needed for readable contrast on dark-mode bg.secondary; 10% muddied to grey.
                        borderRadius: `${c.radius.md}px`,
                        bgcolor: isActive ? `${c.accent.primary}40` : 'transparent',
                        '&:hover': { bgcolor: isActive ? `${c.accent.primary}55` : `${c.text.tertiary}0A` },
                        transition: 'background-color 0.12s',
                      }}
                    >
                      <Typography
                        sx={{
                          color: isActive ? c.text.secondary : c.text.ghost,
                          fontSize: '0.86rem',
                          fontWeight: isActive ? 500 : 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {item.label}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

          {/* Sections separate with air, not lines. */}
          <Box sx={{ my: 0.75 }} />

          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={handleAppsClick}
              onMouseEnter={() => {
                const fn = (window as any).__openswarmPrefetchRoute;
                if (typeof fn === 'function') fn('/apps');
              }}
              data-onboarding="sidebar-apps"
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isAppsRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isAppsRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isAppsRoute ? c.accent.primary : c.text.tertiary, minWidth: 28 }}>
                <LayoutGrid size={18} />
              </ListItemIcon>
              <ListItemText
                primary="Apps"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isAppsRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.9rem',
                    fontWeight: isAppsRoute ? 600 : 400,
                  },
                }}
              />
              <Tooltip title="New app" placement="right">
                <IconButton
                  size="small"
                  onClick={handleCreateApp}
                  sx={{
                    color: c.text.ghost,
                    p: 0.25,
                    mr: 0.25,
                    borderRadius: 1,
                    '&:hover': { color: c.accent.primary, bgcolor: `${c.accent.primary}14` },
                  }}
                >
                  <Plus size={15} />
                </IconButton>
              </Tooltip>
              {appsList.length > 0 && (
                <ExpandMoreIcon
                  sx={{
                    color: c.text.ghost,
                    fontSize: 16,
                    transition: 'transform 0.2s',
                    transform: appsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                />
              )}
            </ListItemButton>

            <Collapse in={appsExpanded && appsList.length > 0} timeout={200}>
              <Box
                sx={{
                  ml: 2,
                  mt: 0.25,
                  mb: 0.5,
                  maxHeight: 240,
                  overflow: 'auto',
                  '&::-webkit-scrollbar': { width: 3 },
                  '&::-webkit-scrollbar-track': { background: 'transparent' },
                  '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 4 },
                  scrollbarWidth: 'thin',
                  scrollbarColor: `${c.border.medium} transparent`,
                }}
              >
                {appsList.map((app) => {
                  const isActive = activeAppId === app.id;
                  return (
                    <Box
                      key={app.id}
                      onClick={() => navigate(`/apps/${app.id}`)}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 1,
                        py: 0.5,
                        mx: 0.5,
                        cursor: 'pointer',
                        borderRadius: `${c.radius.md}px`,
                        bgcolor: isActive ? `${c.accent.primary}40` : 'transparent',
                        '&:hover': { bgcolor: isActive ? `${c.accent.primary}55` : `${c.text.tertiary}0A` },
                        transition: 'background-color 0.12s',
                      }}
                    >
                      <Typewriter value={app.name || 'Untitled App'} enabled={!!app.name && app.name !== 'Untitled App'}>
                        {(t) => (
                          <Typography
                            sx={{
                              color: isActive ? c.text.secondary : c.text.ghost,
                              fontSize: '0.86rem',
                              fontWeight: isActive ? 500 : 400,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            {t}
                          </Typography>
                        )}
                      </Typewriter>
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

        </Box>

        <Box
          sx={{
            px: 1,
            py: 1.25,
          }}
        >
          <ListItemButton
            onClick={() => dispatch(openSettingsModal())}
            data-onboarding="sidebar-settings-button"
            sx={{
              borderRadius: 1.5,
              py: 0.6,
              px: 1.25,
              '& .MuiListItemIcon-root svg': { transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)' },
              '&:hover': { bgcolor: `${c.text.tertiary}0A` },
              '&:hover .MuiListItemIcon-root svg': { transform: 'rotate(90deg)' },
              transition: 'background-color 0.15s',
            }}
          >
            <ListItemIcon sx={{ color: c.text.tertiary, minWidth: 28, position: 'relative' }}>
              <LucideSettings size={18} />
              {showUpdateDot && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: 2,
                    right: 10,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    bgcolor: c.accent.primary,
                    border: `1.5px solid ${c.bg.secondary}`,
                  }}
                />
              )}
            </ListItemIcon>
            <ListItemText
              primary="Settings"
              sx={{
                '& .MuiListItemText-primary': {
                  color: c.text.muted,
                  fontSize: '0.9rem',
                  fontWeight: 400,
                },
              }}
            />
          </ListItemButton>
        </Box>
      </Box>
      <Box
        onMouseDown={handleResizeStart}
        onDoubleClick={handleResizeDoubleClick}
        sx={{
          // 6px hit-target at -3px margin overlaps the seam so the drag region doesn't read as a visible empty strip.
          width: 6,
          marginLeft: '-3px',
          marginRight: '-3px',
          flexShrink: 0,
          cursor: 'col-resize',
          position: 'relative',
          zIndex: 10,
          '&::after': {
            content: '""',
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 2,
            bgcolor: 'transparent',
            transition: 'background-color 0.2s',
          },
          '&:hover::after': {
            bgcolor: c.border.strong,
          },
          '&:active::after': {
            bgcolor: `${c.accent.primary}40`,
          },
        }}
      />
      </>
      )}

      <Box sx={{
        flex: 1,
        overflow: 'hidden',
        bgcolor: c.bg.page,
        position: 'relative',
        // Float the content as a rounded inset panel ("column pill"): the chrome
        // (bg.secondary) frames it, so there are no divider lines, just air + radius.
        mt: '6px',
        mr: '6px',
        mb: '6px',
        ml: '6px',
        borderRadius: '14px',
      }}>
        {/* Hidden (not unmounted) when the dashboard view is active so the persistent Dashboard layered above can take over. */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            visibility: isDashboardViewActive ? 'hidden' : 'visible',
            pointerEvents: isDashboardViewActive ? 'none' : 'auto',
          }}
        >
          <Outlet />
        </Box>

        {/* CSS-hidden on other routes so webviews + state survive nav. */}
        {lastDashboardId && (
          <DashboardHost visible={isDashboardViewActive}>
            <Dashboard dashboardId={lastDashboardId} isActive={isDashboardViewActive} />
          </DashboardHost>
        )}
      </Box>
      </Box>

      <React.Suspense fallback={null}>
        <Settings />
      </React.Suspense>

      <Snackbar
        open={showUpdateSnackbar}
        autoHideDuration={10000}
        onClose={() => setSnackbarDismissed(true)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="info"
          icon={updateStatus === 'downloaded'
            ? <RestartAltIcon sx={{ fontSize: 18 }} />
            : <SystemUpdateAltIcon sx={{ fontSize: 18 }} />
          }
          action={
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                size="small"
                onClick={() => setSnackbarDismissed(true)}
                sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.8rem', minWidth: 'auto' }}
              >
                Dismiss
              </Button>
              {updateStatus === 'available' && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleDownloadUpdate}
                  sx={{
                    bgcolor: c.accent.primary,
                    '&:hover': { bgcolor: c.accent.pressed },
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    borderRadius: 1.5,
                    minWidth: 'auto',
                  }}
                >
                  Download
                </Button>
              )}
              {updateStatus === 'downloaded' && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleInstallUpdate}
                  disabled={installing}
                  startIcon={installing ? <CircularProgress size={12} sx={{ color: '#fff' }} /> : undefined}
                  sx={{
                    bgcolor: c.accent.primary,
                    '&:hover': { bgcolor: c.accent.pressed },
                    '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.7 },
                    textTransform: 'none',
                    fontSize: '0.8rem',
                    borderRadius: 1.5,
                    minWidth: 'auto',
                  }}
                >
                  {installing ? 'Restarting…' : 'Restart & Update'}
                </Button>
              )}
            </Box>
          }
          sx={{
            bgcolor: c.bg.surface,
            color: c.text.primary,
            border: `1px solid ${c.border.medium}`,
            boxShadow: c.shadow.md,
            '& .MuiAlert-icon': { color: c.accent.primary },
          }}
        >
          {updateStatus === 'available' && `OpenSwarm ${availableVersion} is available`}
          {updateStatus === 'downloaded' && `OpenSwarm ${availableVersion} downloaded; restart to update`}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default AppShell;
