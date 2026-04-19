import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface UpdateBannerProps {
  updateStatus: string;
  availableVersion: string | null;
  downloadPercent: number;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
}

const UpdateBanner: React.FC<UpdateBannerProps> = ({
  updateStatus, availableVersion, downloadPercent,
  onDownload, onInstall, onDismiss,
}) => {
  const c = useClaudeTokens();

  const actionBtnSx = {
    bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed },
    textTransform: 'none' as const, fontSize: '0.75rem', fontWeight: 600,
    borderRadius: 1.5, minWidth: 'auto', py: 0.25, px: 1.5,
    lineHeight: 1.5, flexShrink: 0,
  };

  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 0.5,
      bgcolor: `${c.accent.primary}14`, borderBottom: `1px solid ${c.accent.primary}30`,
      flexShrink: 0,
    }}>
      <SystemUpdateAltIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />
      <Typography sx={{
        fontSize: '0.8rem', color: c.text.secondary, flex: 1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {updateStatus === 'available' && `OpenSwarm ${availableVersion} is available`}
        {updateStatus === 'downloading' && `Downloading OpenSwarm ${availableVersion}…`}
        {updateStatus === 'downloaded' && `OpenSwarm ${availableVersion} is ready to install`}
      </Typography>
      {updateStatus === 'downloading' && (
        <LinearProgress variant="determinate" value={downloadPercent} sx={{
          width: 120, height: 3, flexShrink: 0, borderRadius: 2,
          bgcolor: `${c.accent.primary}20`,
          '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary, borderRadius: 2 },
        }} />
      )}
      {updateStatus === 'downloading' && (
        <Typography sx={{ fontSize: '0.72rem', color: c.text.tertiary, flexShrink: 0 }}>
          {Math.round(downloadPercent)}%
        </Typography>
      )}
      {updateStatus === 'available' && (
        <Button size="small" variant="contained" onClick={onDownload} sx={actionBtnSx}>
          Download
        </Button>
      )}
      {updateStatus === 'downloaded' && (
        <Button size="small" variant="contained" onClick={onInstall} sx={actionBtnSx}>
          Restart & Update
        </Button>
      )}
      <IconButton size="small" onClick={onDismiss}
        sx={{ color: c.text.tertiary, p: 0.25, flexShrink: 0, '&:hover': { color: c.text.secondary } }}>
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
};

export default UpdateBanner;
