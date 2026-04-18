import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppDispatch } from '@/shared/hooks';
import { CREATE_DASHBOARD } from '@/shared/backend-bridge/apps/dashboards';
import { addBrowserCard, addBrowserTab } from '@/shared/state/dashboardLayoutSlice';
import { setPendingBrowserUrl } from '@/shared/state/tempStateSlice';
import { findBrowserByWebContentsId } from '@/shared/browserRegistry';

export function useUrlInterception(dashboardList: { id: string }[]) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();

  const openUrlInBrowser = useCallback((url: string, webContentsId?: number) => {
    const dashMatch = location.pathname.match(/^\/dashboard\/(.+)/);
    if (dashMatch) {
      if (webContentsId != null) {
        const browserId = findBrowserByWebContentsId(webContentsId);
        if (browserId) {
          dispatch(addBrowserTab({ browserId, url, makeActive: true }));
          return;
        }
      }
      dispatch(addBrowserCard({ url }));
    } else {
      dispatch(setPendingBrowserUrl(url));
      const lastId = (window as any).__openswarm_last_dashboard_id as string | undefined;
      const firstDashboard = dashboardList[0];
      const targetId = lastId || firstDashboard?.id;
      if (targetId) {
        navigate(`/dashboard/${targetId}`);
      } else {
        dispatch(CREATE_DASHBOARD('Untitled Dashboard')).then((result: any) => {
          if (CREATE_DASHBOARD.fulfilled.match(result)) {
            navigate(`/dashboard/${result.payload.id}`);
          }
        });
      }
    }
  }, [location.pathname, dashboardList, dispatch, navigate]);

  useEffect(() => {
    let lastUrl = '';
    let lastTime = 0;

    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      if (href.startsWith('http://localhost:')) return;

      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      if (href === lastUrl && now - lastTime < 1000) return;
      lastUrl = href;
      lastTime = now;

      openUrlInBrowser(href);
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [openUrlInBrowser]);

  useEffect(() => {
    const w = window as any;
    if (!w.openswarm?.onWebviewNewWindow) return;
    let lastUrl = '';
    let lastTime = 0;
    return w.openswarm.onWebviewNewWindow((url: string, webContentsId: number) => {
      const now = Date.now();
      if (url === lastUrl && now - lastTime < 1000) return;
      lastUrl = url;
      lastTime = now;
      openUrlInBrowser(url, webContentsId);
    });
  }, [openUrlInBrowser]);
}
