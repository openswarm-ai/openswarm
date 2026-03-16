import React, { useState, useEffect } from 'react';
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
import DashboardIcon from '@mui/icons-material/Dashboard';
import DescriptionIcon from '@mui/icons-material/Description';
import PsychologyIcon from '@mui/icons-material/Psychology';
import BuildIcon from '@mui/icons-material/Build';
import TuneIcon from '@mui/icons-material/Tune';
import TerminalIcon from '@mui/icons-material/Terminal';
import ViewQuiltIcon from '@mui/icons-material/ViewQuilt';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import Settings from '@/app/pages/Settings/Settings';
import GlobalApprovalOverlay from '@/app/components/GlobalApprovalOverlay';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchDashboards, createDashboard } from '@/shared/state/dashboardsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const NAV_ITEMS = [
  { label: 'Templates', path: '/templates', icon: <DescriptionIcon /> },
  { label: 'Skills', path: '/skills', icon: <PsychologyIcon /> },
  { label: 'Tools', path: '/tools', icon: <BuildIcon /> },
  { label: 'Modes', path: '/modes', icon: <TuneIcon /> },
  { label: 'Commands', path: '/commands', icon: <TerminalIcon /> },
  { label: 'Views', path: '/views', icon: <ViewQuiltIcon /> },
];


const AppShell: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [dashboardsExpanded, setDashboardsExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const updateStatus = useAppSelector((state) => state.update.status);
  const availableVersion = useAppSelector((state) => state.update.availableVersion);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);

  const showUpdateDot = updateStatus === 'available' || updateStatus === 'downloaded';
  const showUpdateBanner = updateStatus === 'downloaded' && !updateBannerDismissed;

  const dashboardItems = useAppSelector((state) => state.dashboards.items);
  const dashboardList = Object.values(dashboardItems).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  useEffect(() => {
    dispatch(fetchDashboards());
  }, [dispatch]);

  const isDashboardRoute = location.pathname === '/' || location.pathname.startsWith('/dashboard/');
  const activeDashboardId = location.pathname.startsWith('/dashboard/')
    ? location.pathname.split('/dashboard/')[1]
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
    navigate(`/dashboard/${dashboardId}`);
  };

  const handleCreateDashboard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await dispatch(createDashboard('Untitled Dashboard'));
    if (createDashboard.fulfilled.match(result)) {
      navigate(`/dashboard/${result.payload.id}`);
    }
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
            sx={{ width: 18, height: 18, borderRadius: 0.5, opacity: 0.7 }}
          />
          <Typography
            sx={{
              color: c.text.tertiary,
              fontSize: '0.75rem',
              fontWeight: 500,
              letterSpacing: 0.3,
              lineHeight: 1,
            }}
          >
            OpenSwarm
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {!sidebarCollapsed && (
      <Box
        sx={{
          width: 220,
          flexShrink: 0,
          bgcolor: c.bg.secondary,
          borderRight: `0.5px solid ${c.border.subtle}`,
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
                        {entry.name}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
          </Box>

          {/* Divider */}
          <Box sx={{ mx: 1.5, my: 0.5, borderTop: `0.5px solid ${c.border.subtle}` }} />

          {/* Nav items */}
          <Box sx={{ px: 1 }}>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                {({ isActive }) => (
                  <ListItemButton
                    sx={{
                      borderRadius: 1.5,
                      py: 0.6,
                      px: 1.25,
                      mb: 0.25,
                      bgcolor: isActive ? `${c.accent.primary}12` : 'transparent',
                      '&:hover': { bgcolor: isActive ? `${c.accent.primary}18` : `${c.text.tertiary}0A` },
                      transition: 'background-color 0.15s',
                    }}
                  >
                    <ListItemIcon
                      sx={{ color: isActive ? c.accent.primary : c.text.tertiary, minWidth: 32 }}
                    >
                      {React.cloneElement(item.icon, { sx: { fontSize: 20 } })}
                    </ListItemIcon>
                    <ListItemText
                      primary={item.label}
                      sx={{
                        '& .MuiListItemText-primary': {
                          color: isActive ? c.text.primary : c.text.muted,
                          fontSize: '0.82rem',
                          fontWeight: isActive ? 600 : 400,
                        },
                      }}
                    />
                  </ListItemButton>
                )}
              </NavLink>
            ))}
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
      )}

      <Box sx={{ flex: 1, overflow: 'hidden', bgcolor: c.bg.page }}>
        <Outlet />
      </Box>
      </Box>

      <Settings />
      <GlobalApprovalOverlay />

      <Snackbar
        open={showUpdateBanner}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="info"
          icon={<RestartAltIcon sx={{ fontSize: 18 }} />}
          action={
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                size="small"
                onClick={() => setUpdateBannerDismissed(true)}
                sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.8rem', minWidth: 'auto' }}
              >
                Later
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => (window as any).openswarm?.installUpdate()}
                sx={{
                  bgcolor: c.accent.primary,
                  '&:hover': { bgcolor: c.accent.pressed },
                  textTransform: 'none',
                  fontSize: '0.8rem',
                  borderRadius: 1.5,
                  minWidth: 'auto',
                }}
              >
                Restart
              </Button>
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
          OpenSwarm {availableVersion} downloaded — restart to update
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default AppShell;
