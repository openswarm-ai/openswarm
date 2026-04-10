import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import DashboardIcon from '@mui/icons-material/Dashboard';
import PsychologyIcon from '@mui/icons-material/Psychology';
import BuildIcon from '@mui/icons-material/Build';
import TuneIcon from '@mui/icons-material/Tune';
import ViewQuiltIcon from '@mui/icons-material/ViewQuilt';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import ExtensionIcon from '@mui/icons-material/Extension';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CloseIcon from '@mui/icons-material/Close';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Settings from '@/app/pages/Settings/Settings';
import DynamicIsland from '@/app/components/DynamicIsland';
import Dashboard from '@/app/pages/Dashboard/Dashboard';
import DashboardHost from '@/app/components/Layout/DashboardHost';
import { useLastDashboardId } from '@/shared/hooks/useLastDashboardId';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { API_BASE } from '@/shared/config';
import { fetchDashboards, createDashboard, renameDashboard } from '@/shared/state/dashboardsSlice';
import { addBrowserCard, addBrowserTab } from '@/shared/state/dashboardLayoutSlice';
import { setPendingBrowserUrl } from '@/shared/state/tempStateSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { setInstalling } from '@/shared/state/updateSlice';
import { findBrowserByWebContentsId } from '@/shared/browserRegistry';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 220;
const SIDEBAR_WIDTH_KEY = 'openswarm-sidebar-width';
const UPDATE_DISMISS_KEY = 'openswarm-update-dismissed';

const CUSTOMIZATION_ITEMS = [
  { label: 'Skills', path: '/skills', icon: <PsychologyIcon />, onboarding: 'sidebar-skills' },
  { label: 'Actions', path: '/actions', icon: <BuildIcon />, onboarding: 'sidebar-actions' },
  { label: 'Modes', path: '/modes', icon: <TuneIcon />, onboarding: 'sidebar-modes' },
];

const CUSTOMIZATION_PATHS = new Set(CUSTOMIZATION_ITEMS.map((i) => i.path));



/** Cute slime with × eyes and a red error badge — warning banner icon. */
const ErrorSlime: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" style={{ flexShrink: 0 }}>
    {/* Body — smooth dome blob sitting on a wobbly base */}
    <path
      d="M4 20 Q4 7 14 7 Q24 7 24 20 Q22 22 19 21.5 Q16 23 14 22 Q12 23 9 21.5 Q6 22 4 20Z"
      fill="#E8927A"
    />
    {/* Subtle highlight on top of the dome */}
    <ellipse cx="11" cy="11" rx="3.5" ry="2" fill="#F0A68E" opacity="0.6" />
    {/* × left eye */}
    <line x1="9.5" y1="13" x2="11.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="11.5" y1="13" x2="9.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    {/* × right eye */}
    <line x1="16.5" y1="13" x2="18.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="18.5" y1="13" x2="16.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    {/* Small frown */}
    <path d="M12 18.5 Q14 17.5 16 18.5" stroke="#4a2020" strokeWidth="1" strokeLinecap="round" fill="none" />
    {/* Red error badge — top right */}
    <circle cx="22" cy="5" r="4" fill="#ef4444" stroke="rgba(0,0,0,0.15)" strokeWidth="0.5" />
    <text x="22" y="6.8" textAnchor="middle" fontSize="5.5" fill="white" fontWeight="bold" fontFamily="sans-serif">!</text>
  </svg>
);

const AppShell: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [dashboardsExpanded, setDashboardsExpanded] = useState(true);
  const [appsExpanded, setAppsExpanded] = useState(true);
  const [customizationExpanded, setCustomizationExpanded] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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

  // ---- Warning banner: no internet / no model connected ----
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [hasActiveSubscription, setHasActiveSubscription] = useState<boolean | null>(null); // null = still checking
  // Narrow selectors — only re-render when an API key field actually changes,
  // not on every settings update (theme toggle, system prompt edit, etc.).
  const anthropicKey = useAppSelector((s) => s.settings.data.anthropic_api_key);
  const openaiKey = useAppSelector((s) => s.settings.data.openai_api_key);
  const googleKey = useAppSelector((s) => s.settings.data.google_api_key);
  const openrouterKey = useAppSelector((s) => s.settings.data.openrouter_api_key);

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

  // Check subscription status once on mount (and re-check when an API key changes)
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/agents/subscriptions/status`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const connections = data.providers?.connections || [];
        setHasActiveSubscription(
          data.running && connections.some((p: any) => p.isActive),
        );
      })
      .catch(() => {
        if (!cancelled) setHasActiveSubscription(false);
      });
    return () => { cancelled = true; };
  }, [anthropicKey]);

  const hasAnyApiKey = !!(anthropicKey || openaiKey || googleKey || openrouterKey);
  const hasModelConnected = hasAnyApiKey || hasActiveSubscription === true;
  // Don't flash the banner while the subscription check is in flight
  const showWarningBanner = !isOnline || (hasActiveSubscription !== null && !hasModelConnected);

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

  const dashboardItems = useAppSelector((state) => state.dashboards.items);
  const dashboardList = Object.values(dashboardItems).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  const outputItems = useAppSelector((state) => state.outputs.items);
  const appsList = Object.values(outputItems).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  useEffect(() => {
    dispatch(fetchDashboards());
    dispatch(fetchOutputs());
  }, [dispatch]);

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

  // Sticky last-visited dashboard id — survives navigation away from /dashboard/:id
  // so the Dashboard component can stay mounted with stable props.
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
    if (trimmed && trimmed !== dashboardItems[id]?.name) {
      dispatch(renameDashboard({ id, name: trimmed }));
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
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: c.bg.page }}>
      {/* Draggable title bar */}
      <Box
        sx={{
          height: 38,
          flexShrink: 0,
          bgcolor: c.bg.secondary,
          borderBottom: `0.5px solid ${c.border.medium}`,
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
            sx={{
              WebkitAppRegion: 'no-drag',
              color: c.text.tertiary,
              p: 0.5,
              borderRadius: 1,
              '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
            }}
          >
            <ViewSidebarOutlinedIcon sx={{ fontSize: 18 }} />
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
              '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
            }}
          >
            <ArrowBackOutlinedIcon sx={{ fontSize: 18 }} />
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
              '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
            }}
          >
            <ArrowForwardOutlinedIcon sx={{ fontSize: 18 }} />
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
            sx={{ width: 16, height: 16, borderRadius: 0.5, opacity: 0.6 }}
          />
          <Typography
            sx={{
              color: c.text.tertiary,
              fontSize: '0.72rem',
              fontWeight: 500,
              letterSpacing: 0.3,
              lineHeight: 1,
            }}
          >
            OpenSwarm
          </Typography>
        </Box>
      </Box>

      {/* Warning banner: no internet or no model connected */}
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
          <Typography sx={{ fontSize: '0.78rem', color: '#ef4444', flex: 1, fontWeight: 500, letterSpacing: '0.01em' }}>
            {!isOnline
              ? 'No internet connection — agents cannot reach AI models or external services'
              : (
                <>
                  No AI model connected —{' '}
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
            {updateStatus === 'downloaded' && `OpenSwarm ${availableVersion} is ready to install`}
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
        <Box sx={{ flex: 1, overflow: 'auto', pt: 0.5, '&::-webkit-scrollbar': { width: 0 } }}>
          {/* Dashboards section */}
          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={handleDashboardsClick}
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isDashboardRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isDashboardRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isDashboardRoute ? c.accent.primary : c.text.tertiary, minWidth: 32 }}>
                <DashboardIcon sx={{ fontSize: 20 }} />
              </ListItemIcon>
              <ListItemText
                primary="Dashboards"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isDashboardRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.82rem',
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
                  <AddIcon sx={{ fontSize: 15 }} />
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
                  borderLeft: `1px solid ${c.border.medium}`,
                  maxHeight: 240,
                  overflow: 'auto',
                  '&::-webkit-scrollbar': { width: 3 },
                  '&::-webkit-scrollbar-track': { background: 'transparent' },
                  '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 4 },
                  scrollbarWidth: 'thin',
                  scrollbarColor: `${c.border.medium} transparent`,
                }}
              >
                {dashboardList.map((entry) => {
                  const isActive = activeDashboardId === entry.id;
                  const isRenaming = renamingDashboardId === entry.id;
                  return (
                    <Box
                      key={entry.id}
                      onClick={() => handleDashboardItemClick(entry.id)}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 1,
                        py: isRenaming ? 0.25 : 0.5,
                        ml: '-0.5px',
                        cursor: isRenaming ? 'default' : 'pointer',
                        borderLeft: isActive ? `1.5px solid ${c.accent.primary}` : '1.5px solid transparent',
                        bgcolor: isActive ? `${c.accent.primary}0C` : 'transparent',
                        '&:hover': { bgcolor: `${c.text.tertiary}0A` },
                        transition: 'background-color 0.12s, border-color 0.12s',
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
                            fontSize: '0.78rem',
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
                            fontSize: '0.78rem',
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

          {/* Divider */}
          <Box sx={{ mx: 1.5, my: 0.5, borderTop: `0.5px solid ${c.border.subtle}` }} />

          {/* Customization section */}
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
              sx={{
                borderRadius: 1.5,
                py: 0.6,
                px: 1.25,
                bgcolor: isCustomizationRoute ? `${c.accent.primary}12` : 'transparent',
                '&:hover': { bgcolor: isCustomizationRoute ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                transition: 'background-color 0.15s',
              }}
            >
              <ListItemIcon sx={{ color: isCustomizationRoute ? c.accent.primary : c.text.tertiary, minWidth: 32 }}>
                <ExtensionIcon sx={{ fontSize: 20 }} />
              </ListItemIcon>
              <ListItemText
                primary="Customization"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isCustomizationRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.82rem',
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
              <Box sx={{ ml: 2, mt: 0.25, mb: 0.5, borderLeft: `1px solid ${c.border.medium}` }}>
                {CUSTOMIZATION_ITEMS.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    {({ isActive }) => (
                      <Box
                        data-onboarding={item.onboarding}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75,
                          pl: 1.25,
                          pr: 1,
                          py: 0.5,
                          ml: '-0.5px',
                          cursor: 'pointer',
                          borderLeft: isActive ? `1.5px solid ${c.accent.primary}` : '1.5px solid transparent',
                          bgcolor: isActive ? `${c.accent.primary}0C` : 'transparent',
                          '&:hover': { bgcolor: `${c.text.tertiary}0A` },
                          transition: 'background-color 0.12s, border-color 0.12s',
                        }}
                      >
                        <Typography
                          sx={{
                            color: isActive ? c.text.secondary : c.text.ghost,
                            fontSize: '0.78rem',
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
                    )}
                  </NavLink>
                ))}
              </Box>
            </Collapse>
          </Box>

          {/* Divider */}
          <Box sx={{ mx: 1.5, my: 0.5, borderTop: `0.5px solid ${c.border.subtle}` }} />

          {/* Apps section */}
          <Box sx={{ px: 1, mb: 0.25 }}>
            <ListItemButton
              onClick={handleAppsClick}
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
              <ListItemIcon sx={{ color: isAppsRoute ? c.accent.primary : c.text.tertiary, minWidth: 32 }}>
                <ViewQuiltIcon sx={{ fontSize: 20 }} />
              </ListItemIcon>
              <ListItemText
                primary="Apps"
                sx={{
                  '& .MuiListItemText-primary': {
                    color: isAppsRoute ? c.text.primary : c.text.muted,
                    fontSize: '0.82rem',
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
                  <AddIcon sx={{ fontSize: 15 }} />
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
                  borderLeft: `1px solid ${c.border.medium}`,
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
                        ml: '-0.5px',
                        cursor: 'pointer',
                        borderLeft: isActive ? `1.5px solid ${c.accent.primary}` : '1.5px solid transparent',
                        bgcolor: isActive ? `${c.accent.primary}0C` : 'transparent',
                        '&:hover': { bgcolor: `${c.text.tertiary}0A` },
                        transition: 'background-color 0.12s, border-color 0.12s',
                      }}
                    >
                      <Typography
                        sx={{
                          color: isActive ? c.text.secondary : c.text.ghost,
                          fontSize: '0.78rem',
                          fontWeight: isActive ? 500 : 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {app.name}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

        </Box>

        {/* Settings */}
        <Box
          sx={{
            px: 1,
            py: 1,
            borderTop: `0.5px solid ${c.border.subtle}`,
          }}
        >
          <ListItemButton
            onClick={() => dispatch(openSettingsModal())}
            sx={{
              borderRadius: 1.5,
              py: 0.6,
              px: 1.25,
              '&:hover': { bgcolor: `${c.text.tertiary}0A` },
              transition: 'background-color 0.15s',
            }}
          >
            <ListItemIcon sx={{ color: c.text.tertiary, minWidth: 32, position: 'relative' }}>
              <SettingsIcon sx={{ fontSize: 20 }} />
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
                  fontSize: '0.82rem',
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
          width: 6,
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

      <Box sx={{ flex: 1, overflow: 'hidden', bgcolor: c.bg.page, position: 'relative' }}>
        {/* Non-dashboard routes render here. Hidden when the dashboard view is active
            so the persistent Dashboard layered above can take over the visible area. */}
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

        {/* Persistent Dashboard layer — always mounted once a dashboard has been visited.
            Hidden via CSS when on other routes so webviews and dashboard state survive
            route navigation. The Dashboard component reads its dashboardId from the
            sticky lastDashboardId hook so its dashboardId useEffect doesn't re-fire on
            incidental URL changes. */}
        {lastDashboardId && (
          <DashboardHost visible={isDashboardViewActive}>
            <Dashboard dashboardId={lastDashboardId} isActive={isDashboardViewActive} />
          </DashboardHost>
        )}
      </Box>
      </Box>

      <Settings />

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
          {updateStatus === 'downloaded' && `OpenSwarm ${availableVersion} downloaded — restart to update`}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default AppShell;
