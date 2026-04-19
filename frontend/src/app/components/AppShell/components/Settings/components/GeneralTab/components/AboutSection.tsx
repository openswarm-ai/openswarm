import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import DownloadIcon from '@mui/icons-material/Download';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { UseSettingsReturn } from './hooks/useSettings';

const AboutSection: React.FC<{ s: UseSettingsReturn }> = ({ s }) => {
  const { c, sectionSx, rowSx, rowLastSx, labelSx, descSx,
          updateStatus, appVersion, availableVersion, downloadPercent, updateError,
          handleCheckForUpdates, handleDownloadUpdate, handleInstallUpdate } = s;
  return (
    <>
      <Typography sx={{ ...sectionSx, mt: 3 }}>About</Typography>
      <Box sx={rowSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography sx={labelSx}>Version</Typography>
            <Typography sx={{ ...descSx, fontFamily: c.font.mono }}>
              {appVersion ?? '—'}
            </Typography>
          </Box>
        </Box>
      </Box>
      <Box sx={rowLastSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: updateStatus === 'downloading' ? 1 : 0 }}>
          <Box>
            <Typography sx={labelSx}>Software update</Typography>
            <Typography sx={descSx}>
              {updateStatus === 'checking' && 'Checking for updates…'}
              {updateStatus === 'not-available' && 'You\'re on the latest version.'}
              {updateStatus === 'available' && `Version ${availableVersion} is available.`}
              {updateStatus === 'downloading' && `Downloading update… ${Math.round(downloadPercent)}%`}
              {updateStatus === 'downloaded' && `Version ${availableVersion} is ready to install.`}
              {updateStatus === 'error' && (updateError || 'Update check failed.')}
              {updateStatus === 'idle' && 'Check for new versions of OpenSwarm.'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, ml: 2 }}>
            {updateStatus === 'checking' && (
              <CircularProgress size={18} sx={{ color: c.text.tertiary }} />
            )}
            {updateStatus === 'not-available' && (
              <CheckCircleOutlineIcon sx={{ fontSize: 18, color: c.status.success }} />
            )}
            {updateStatus === 'error' && (
              <ErrorOutlineIcon sx={{ fontSize: 18, color: c.status.error }} />
            )}
            {(updateStatus === 'idle' || updateStatus === 'not-available' || updateStatus === 'error') && (
              <Button
                variant="outlined"
                size="small"
                onClick={handleCheckForUpdates}
                startIcon={<SystemUpdateAltIcon sx={{ fontSize: 15 }} />}
                sx={{
                  color: c.text.secondary,
                  borderColor: c.border.medium,
                  textTransform: 'none',
                  fontSize: '0.8rem',
                  whiteSpace: 'nowrap',
                  '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
                }}
              >
                Check for Updates
              </Button>
            )}
            {updateStatus === 'available' && (
              <Button
                variant="outlined"
                size="small"
                onClick={handleDownloadUpdate}
                startIcon={<DownloadIcon sx={{ fontSize: 15 }} />}
                sx={{
                  color: c.accent.primary,
                  borderColor: c.accent.primary,
                  textTransform: 'none',
                  fontSize: '0.8rem',
                  whiteSpace: 'nowrap',
                  '&:hover': { bgcolor: `${c.accent.primary}10` },
                }}
              >
                Download
              </Button>
            )}
            {updateStatus === 'downloaded' && (
              <Button
                variant="contained"
                size="small"
                onClick={handleInstallUpdate}
                startIcon={<RestartAltIcon sx={{ fontSize: 15 }} />}
                sx={{
                  bgcolor: c.accent.primary,
                  '&:hover': { bgcolor: c.accent.pressed },
                  textTransform: 'none',
                  fontSize: '0.8rem',
                  whiteSpace: 'nowrap',
                  borderRadius: 1.5,
                }}
              >
                Restart &amp; Update
              </Button>
            )}
          </Box>
        </Box>
        {updateStatus === 'downloading' && (
          <LinearProgress
            variant="determinate"
            value={downloadPercent}
            sx={{
              height: 3,
              borderRadius: 2,
              bgcolor: `${c.accent.primary}20`,
              '& .MuiLinearProgress-bar': { bgcolor: c.accent.primary, borderRadius: 2 },
            }}
          />
        )}
      </Box>
    </>
  );
};

export default AboutSection;
