import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import Settings from '@/app/pages/Settings/Settings';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { LIST_DASHBOARDS } from '@/shared/backend-bridge/apps/dashboards';
import { LIST_APPS } from '@/shared/backend-bridge/apps/app_builder';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useUpdateNotification } from './hooks/useUpdateNotification';
import { useSidebarResize } from './hooks/useSidebarResize';
import { useUrlInterception } from './hooks/useUrlInterception';
import TitleBar from './TitleBar';
import Sidebar from './Sidebar';
import UpdateBanner from './UpdateBanner';

const AppShell: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const {
    updateStatus, availableVersion, downloadPercent,
    snackbarDismissed, setSnackbarDismissed,
    showUpdateDot, showUpdateBanner, showUpdateSnackbar,
    handleDismissBanner, handleDownloadUpdate, handleInstallUpdate,
  } = useUpdateNotification();

  const { sidebarWidth, handleResizeStart, handleResizeDoubleClick } = useSidebarResize();

  const dashboardItems = useAppSelector((s) => s.dashboards.items);
  const dashboardList = Object.values(dashboardItems).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  useUrlInterception(dashboardList);

  useEffect(() => {
    dispatch(LIST_DASHBOARDS());
    dispatch(LIST_APPS());
  }, [dispatch]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: c.bg.page }}>
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((p) => !p)}
      />

      {showUpdateBanner && (
        <UpdateBanner
          updateStatus={updateStatus}
          availableVersion={availableVersion}
          downloadPercent={downloadPercent}
          onDownload={handleDownloadUpdate}
          onInstall={handleInstallUpdate}
          onDismiss={handleDismissBanner}
        />
      )}

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!sidebarCollapsed && (
          <>
            <Box sx={{
              width: sidebarWidth, flexShrink: 0, bgcolor: c.bg.secondary,
              display: 'flex', flexDirection: 'column',
            }}>
              <Sidebar showUpdateDot={showUpdateDot} />
            </Box>
            <Box
              onMouseDown={handleResizeStart}
              onDoubleClick={handleResizeDoubleClick}
              sx={{
                width: 6, flexShrink: 0, cursor: 'col-resize',
                position: 'relative', zIndex: 10,
                '&::after': {
                  content: '""', position: 'absolute', top: 0, bottom: 0,
                  left: '50%', transform: 'translateX(-50%)', width: 2,
                  bgcolor: 'transparent', transition: 'background-color 0.2s',
                },
                '&:hover::after': { bgcolor: c.border.strong },
                '&:active::after': { bgcolor: `${c.accent.primary}40` },
              }}
            />
          </>
        )}
        <Box sx={{ flex: 1, overflow: 'hidden', bgcolor: c.bg.page }}>
          <Outlet />
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
              <Button size="small" onClick={() => setSnackbarDismissed(true)}
                sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.8rem', minWidth: 'auto' }}>
                Dismiss
              </Button>
              {updateStatus === 'available' && (
                <Button size="small" variant="contained" onClick={handleDownloadUpdate} sx={{
                  bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed },
                  textTransform: 'none', fontSize: '0.8rem', borderRadius: 1.5, minWidth: 'auto',
                }}>
                  Download
                </Button>
              )}
              {updateStatus === 'downloaded' && (
                <Button size="small" variant="contained" onClick={handleInstallUpdate} sx={{
                  bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed },
                  textTransform: 'none', fontSize: '0.8rem', borderRadius: 1.5, minWidth: 'auto',
                }}>
                  Restart & Update
                </Button>
              )}
            </Box>
          }
          sx={{
            bgcolor: c.bg.surface, color: c.text.primary,
            border: `1px solid ${c.border.medium}`, boxShadow: c.shadow.md,
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
