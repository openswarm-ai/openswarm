import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch } from '@/shared/hooks';
import { fetchDashboards, createDashboard, Dashboard } from '@/shared/state/dashboardsSlice';
import { byPreviewRecency } from '@/shared/previewOrder';

// The old picker page is gone: the Spaces strip owns dashboard switching, so landing on "/" just
// drops the user into their latest dashboard (creating the first one on a fresh install). Renders
// nothing; while the backend is down the shell's warning banner is the message, and the retry loop
// self-heals the moment it answers.
const DashboardAutoEnter: React.FC = () => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const enter = async (): Promise<void> => {
      const res = await dispatch(fetchDashboards());
      if (cancelled) return;
      if (fetchDashboards.fulfilled.match(res)) {
        const list = (res.payload as Dashboard[]).slice().sort(byPreviewRecency);
        if (list.length > 0) {
          navigate(`/dashboard/${list[0].id}`, { replace: true });
          return;
        }
        const created = await dispatch(createDashboard('Untitled Dashboard'));
        if (!cancelled && createDashboard.fulfilled.match(created)) {
          navigate(`/dashboard/${created.payload.id}`, { replace: true });
          return;
        }
      }
      if (!cancelled) timer = setTimeout(enter, 3000);
    };
    enter();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [dispatch, navigate]);

  return null;
};

export default DashboardAutoEnter;
