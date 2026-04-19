import React from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import DynamicIsland from './DynamicIsland/DynamicIsland';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface TitleBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

const TitleBar: React.FC<TitleBarProps> = ({ sidebarCollapsed, onToggleSidebar }) => {
  const c = useClaudeTokens();
  const navigate = useNavigate();

  const navBtnSx = {
    WebkitAppRegion: 'no-drag',
    color: c.text.tertiary,
    p: 0.5,
    borderRadius: 1,
    '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}14` },
  };

  return (
    <Box sx={{
      height: 38, flexShrink: 0, bgcolor: c.bg.secondary,
      borderBottom: `0.5px solid ${c.border.medium}`,
      display: 'flex', alignItems: 'center', position: 'relative',
      overflow: 'visible', WebkitAppRegion: 'drag', userSelect: 'none',
      pl: '78px', gap: 0.25,
    }}>
      <Tooltip title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
        <IconButton size="small" onClick={onToggleSidebar} sx={navBtnSx}>
          <ViewSidebarOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Back">
        <IconButton size="small" onClick={() => navigate(-1)} sx={navBtnSx}>
          <ArrowBackOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Forward">
        <IconButton size="small" onClick={() => navigate(1)} sx={navBtnSx}>
          <ArrowForwardOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>

      <DynamicIsland />

      <Box sx={{ flex: 1 }} />

      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.75, pr: 1.5,
        WebkitAppRegion: 'no-drag',
      }}>
        <Box component="img" src="./logo.png" alt="OpenSwarm"
          sx={{ width: 16, height: 16, borderRadius: 0.5, opacity: 0.6 }} />
        <Typography sx={{
          color: c.text.tertiary, fontSize: '0.72rem', fontWeight: 500,
          letterSpacing: 0.3, lineHeight: 1,
        }}>
          OpenSwarm
        </Typography>
      </Box>
    </Box>
  );
};

export default TitleBar;
