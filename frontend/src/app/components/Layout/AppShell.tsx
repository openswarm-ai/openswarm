import React, { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
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
          width: 240,
          flexShrink: 0,
          bgcolor: c.bg.secondary,
          boxShadow: '1px 0 3px rgba(0,0,0,0.04)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <List sx={{ pt: 1, px: 1, flex: 1, overflow: 'auto'}}>
          <ListItemButton
            onClick={handleDashboardsClick}
            sx={{
              borderRadius: dashboardsExpanded ? '22px 22px 0 0' : 2,
              bgcolor: isDashboardRoute ? `${c.accent.primary}0F` : 'transparent',
              '&:hover': { bgcolor: `${c.accent.primary}08` },
            }}
          >
            <ListItemIcon sx={{ color: isDashboardRoute ? c.text.primary : c.text.tertiary, minWidth: 40 }}>
              <DashboardIcon />
            </ListItemIcon>
            <ListItemText
              primary="Dashboards"
              sx={{
                '& .MuiListItemText-primary': {
                  color: isDashboardRoute ? c.text.primary : c.text.muted,
                  fontSize: '0.875rem',
                  fontWeight: isDashboardRoute ? 500 : 400,
                },
              }}
            />
            <Tooltip title="New dashboard">
              <IconButton
                size="small"
                onClick={handleCreateDashboard}
                sx={{
                  color: c.text.ghost,
                  p: 0.25,
                  mr: 0.5,
                  '&:hover': { color: c.accent.primary },
                }}
              >
                <AddIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            {dashboardList.length > 0 && (
              <ExpandMoreIcon
                sx={{
                  color: c.text.ghost,
                  fontSize: 18,
                  transition: 'transform 0.2s',
                  transform: dashboardsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            )}
          </ListItemButton>

          <Collapse in={dashboardsExpanded && dashboardList.length > 0} timeout={200}>
            <Box
              sx={{
                pl: 0.15,
                maxHeight: 300,
                overflow: 'auto',
                '&::-webkit-scrollbar': { width: 4 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
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
                      gap: 0.5,
                      px: 1.5,
                      py: 0.75,
                      borderRadius: 0,
                      cursor: 'pointer',
                      bgcolor: isActive ? `${c.accent.primary}08` : 'transparent',
                      borderLeft: isActive ? `1.5px solid ${c.accent.primary}90` : '1.5px solid transparent',
                      '&:hover': { bgcolor: `${c.accent.primary}0C` },
                      transition: 'background-color 0.15s, border-color 0.15s',
                    }}
                  >
                    {isActive && (
                      <Box
                        sx={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          bgcolor: c.accent.primary,
                          flexShrink: 0,
                          opacity: 0.7,
                        }}
                      />
                    )}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        sx={{
                          color: isActive ? c.text.secondary : c.text.muted,
                          fontSize: '0.8rem',
                          fontWeight: isActive ? 500 : 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {entry.name}
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Collapse>

          <Box sx={{ mb: 1 }} />

          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              {({ isActive }) => (
                <ListItemButton
                  sx={{
                    borderRadius: 2,
                    mb: 1,
                    bgcolor: isActive ? `${c.accent.primary}0F` : 'transparent',
                    '&:hover': { bgcolor: `${c.accent.primary}08` },
                  }}
                >
                  <ListItemIcon
                    sx={{ color: isActive ? c.text.primary : c.text.tertiary, minWidth: 40 }}
                  >
                    {item.icon}
                  </ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    sx={{
                      '& .MuiListItemText-primary': {
                        color: isActive ? c.text.primary : c.text.muted,
                        fontSize: '0.875rem',
                        fontWeight: isActive ? 500 : 400,
                      },
                    }}
                  />
                </ListItemButton>
              )}
            </NavLink>
          ))}
        </List>

        {/* Settings */}
        <Box
          sx={{
            px: 2,
            py: 1.5,
            borderTop: `0.5px solid ${c.border.medium}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem' }}>
            Settings
          </Typography>
          <Tooltip title="Settings">
            <IconButton
              onClick={() => dispatch(openSettingsModal())}
              size="small"
              sx={{
                color: c.text.tertiary,
                '&:hover': { color: c.accent.primary, bgcolor: `${c.accent.primary}0A` },
                transition: c.transition,
              }}
            >
              <SettingsIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      )}

      <Box sx={{ flex: 1, overflow: 'hidden', bgcolor: c.bg.page }}>
        <Outlet />
      </Box>
      </Box>

      <Settings />
      <GlobalApprovalOverlay />
    </Box>
  );
};

export default AppShell;
