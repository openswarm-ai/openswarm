import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import HomeIcon from '@mui/icons-material/Home';
import FavoriteIcon from '@mui/icons-material/Favorite';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import { NavLink, useLocation } from 'react-router-dom';
import { useClaudeTokens, useThemeMode } from '@/shared/styles/ThemeContext';

const NAV_ITEMS = [
  { path: '/', label: 'Home', icon: HomeIcon },
  { path: '/health', label: 'Health', icon: FavoriteIcon },
];

const SIDEBAR_WIDTH_EXPANDED = 240;
const SIDEBAR_WIDTH_COLLAPSED = 64;

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ collapsed, onToggle }) => {
  const c = useClaudeTokens();
  const { mode, toggleMode } = useThemeMode();
  const location = useLocation();

  const width = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <Box
      component="nav"
      sx={{
        width,
        minWidth: width,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: c.bg.secondary,
        borderRight: `1px solid ${c.border.subtle}`,
        transition: c.transition,
        overflow: 'hidden',
      }}
    >
      <Box
        onClick={onToggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: collapsed ? 0 : 2.5,
          py: 2.5,
          justifyContent: collapsed ? 'center' : 'flex-start',
          minHeight: 64,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <Box
          component="img"
          src="/logo.png"
          alt="OpenSwarm"
          sx={{ width: 28, height: 28, objectFit: 'contain', flexShrink: 0 }}
        />
        {!collapsed && (
          <Typography
            sx={{
              fontWeight: 700,
              fontSize: '0.95rem',
              color: c.text.primary,
              fontFamily: c.font.serif,
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
            }}
          >
            OpenSwarm
          </Typography>
        )}
      </Box>

      <List sx={{ flex: 1, px: collapsed ? 1 : 1.5, pt: 0.5 }}>
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const isActive =
            path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

          const button = (
            <ListItemButton
              key={path}
              component={NavLink}
              to={path}
              sx={{
                borderRadius: 2,
                mb: 0.5,
                py: 0.75,
                px: collapsed ? 0 : undefined,
                justifyContent: collapsed ? 'center' : 'flex-start',
                bgcolor: isActive ? `${c.accent.primary}0F` : 'transparent',
                '&:hover': { bgcolor: `${c.accent.primary}08` },
                transition: c.transition,
              }}
            >
              <ListItemIcon
                sx={{
                  color: isActive ? c.accent.primary : c.text.tertiary,
                  minWidth: collapsed ? 'auto' : 36,
                  justifyContent: 'center',
                }}
              >
                <Icon sx={{ fontSize: 20 }} />
              </ListItemIcon>
              {!collapsed && (
                <ListItemText
                  primary={label}
                  sx={{
                    '& .MuiListItemText-primary': {
                      color: isActive ? c.text.primary : c.text.muted,
                      fontSize: '0.875rem',
                      fontWeight: isActive ? 500 : 400,
                      fontFamily: c.font.serif,
                      whiteSpace: 'nowrap',
                    },
                  }}
                />
              )}
            </ListItemButton>
          );

          return collapsed ? (
            <Tooltip key={path} title={label} placement="right">
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </List>

      <Box
        sx={{
          px: collapsed ? 1 : 2.5,
          py: 2,
          borderTop: `1px solid ${c.border.subtle}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
        }}
      >
        <Tooltip title={mode === 'light' ? 'Dark mode' : 'Light mode'} placement={collapsed ? 'right' : 'top'}>
          <IconButton
            onClick={toggleMode}
            size="small"
            sx={{
              color: c.text.tertiary,
              '&:hover': { color: c.accent.primary, bgcolor: `${c.accent.primary}0A` },
              transition: c.transition,
            }}
          >
            {mode === 'light' ? (
              <DarkModeIcon sx={{ fontSize: 18 }} />
            ) : (
              <LightModeIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </Tooltip>
        {!collapsed && (
          <Typography
            sx={{
              fontSize: '0.75rem',
              color: c.text.ghost,
              fontFamily: c.font.mono,
              ml: 1,
            }}
          >
            {mode === 'light' ? 'Light' : 'Dark'}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export { SIDEBAR_WIDTH_EXPANDED, SIDEBAR_WIDTH_COLLAPSED };
export default Sidebar;
