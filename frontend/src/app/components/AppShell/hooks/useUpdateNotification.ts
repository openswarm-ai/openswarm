import { useState, useCallback } from 'react';
import { useAppSelector } from '@/shared/hooks';

const UPDATE_DISMISS_KEY = 'openswarm-update-dismissed';

export function useUpdateNotification() {
  const updateStatus = useAppSelector((s) => s.update.status);
  const availableVersion = useAppSelector((s) => s.update.availableVersion);
  const downloadPercent = useAppSelector((s) => s.update.downloadPercent);

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try { return localStorage.getItem(UPDATE_DISMISS_KEY); } catch { return null; }
  });
  const [snackbarDismissed, setSnackbarDismissed] = useState(false);

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
    (window as any).openswarm?.installUpdate();
  }, []);

  return {
    updateStatus,
    availableVersion,
    downloadPercent,
    snackbarDismissed,
    setSnackbarDismissed,
    showUpdateDot,
    showUpdateBanner,
    showUpdateSnackbar,
    handleDismissBanner,
    handleDownloadUpdate,
    handleInstallUpdate,
  };
}
