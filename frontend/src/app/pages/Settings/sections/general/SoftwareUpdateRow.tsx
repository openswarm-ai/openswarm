import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DownloadIcon from '@mui/icons-material/Download';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { setChecking, setUpdateError, setInstalling } from '@/shared/state/updateSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { SettingsStyles } from '../settingsStyles';

/** The breadcrumb's last stop: a pill-shaped relaunch row pinned to the top of Advanced while an update sits downloaded. */
export const UpdateReadyBanner: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const updateStatus = useAppSelector((s) => s.update.status);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const installing = useAppSelector((s) => s.update.installing);
  if (updateStatus !== 'downloaded') return null;
  const install = () => {
    if (installing) return;
    dispatch(setInstalling());
    (window as any).openswarm?.installUpdate();
  };
  return (
    <Box
      onClick={install}
      role="button"
      aria-label="Relaunch to update"
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.25,
        px: 1.75, py: 1.25, mb: 2,
        borderRadius: '999px',
        border: `1px solid ${c.accent.primary}`,
        bgcolor: `${c.accent.primary}14`,
        cursor: installing ? 'default' : 'pointer',
        transition: 'background-color 0.15s ease',
        '&:hover': { bgcolor: `${c.accent.primary}22` },
      }}
    >
      <RestartAltIcon sx={{ fontSize: 18, color: c.accent.primary, flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary, lineHeight: 1.25 }}>
          {installing ? 'Relaunching…' : 'Relaunch to update'}
        </Typography>
        <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>
          {availableVersion ? `Version ${availableVersion} is downloaded and ready.` : 'The update is downloaded and ready.'}
        </Typography>
      </Box>
      {installing && <CircularProgress size={16} sx={{ color: c.accent.primary, ml: 'auto', flexShrink: 0 }} />}
    </Box>
  );
};

const SoftwareUpdateRow: React.FC<{ styles: SettingsStyles }> = ({ styles }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { rowLastSx, labelSx, descSx } = styles;
  const updateStatus = useAppSelector((s) => s.update.status);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const downloadPercent = useAppSelector((s) => s.update.downloadPercent);
  const updateError = useAppSelector((s) => s.update.error);
  const installing = useAppSelector((s) => s.update.installing);

  const handleCheckForUpdates = async () => {
    dispatch(setChecking());
    const timeout = setTimeout(() => {
      dispatch(setUpdateError('Update check timed out. Please try again.'));
    }, 15000);
    try {
      await (window as any).openswarm?.checkForUpdates();
    } catch {
      /* error handled via IPC event listener */
    } finally {
      clearTimeout(timeout);
    }
  };

  const handleDownloadUpdate = async () => {
    try {
      await (window as any).openswarm?.downloadUpdate();
    } catch {
      /* error handled via IPC event listener */
    }
  };

  const handleInstallUpdate = () => {
    if (installing) return;
    dispatch(setInstalling());
    (window as any).openswarm?.installUpdate();
  };

  return (
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
                fontSize: '0.8125rem',
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
                fontSize: '0.8125rem',
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
              disabled={installing}
              startIcon={installing
                ? <CircularProgress size={14} sx={{ color: '#fff' }} />
                : <RestartAltIcon sx={{ fontSize: 15 }} />}
              sx={{
                bgcolor: c.accent.primary,
                '&:hover': { bgcolor: c.accent.pressed },
                '&.Mui-disabled': { bgcolor: c.accent.primary, color: '#fff', opacity: 0.7 },
                textTransform: 'none',
                fontSize: '0.8125rem',
                whiteSpace: 'nowrap',
                borderRadius: 1.5,
              }}
            >
              {installing ? 'Restarting…' : 'Restart & Update'}
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
  );
};

export default SoftwareUpdateRow;
