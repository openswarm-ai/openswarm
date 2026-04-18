import { useRef, useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import {
  registerWebview, // only used in this file, maybe an aNr opportunity? -HD
  unregisterWebview, // only used in this file, maybe an aNr opportunity? -HD
  setActiveTab as setRegistryActiveTab,
  type BrowserWebview,
} from '@/shared/browserRegistry';
import {
  updateBrowserTabUrl,
  updateBrowserTabTitle,
  updateBrowserTabFavicon,
  type BrowserTab,
} from '@/shared/state/dashboardLayoutSlice';
import type { TabLocalState } from '../TabLocalState';

export type WebviewElement = BrowserWebview;

export const isElectron = navigator.userAgent.includes('Electron');

export const chromeUserAgent = navigator.userAgent
  .replace(/\s*Electron\/\S+/, '')
  .replace(/\s*OpenSwarm\/\S+/, '');

export const webviewPreloadPath: string | undefined = isElectron
  ? (window as any).openswarm?.getWebviewPreloadPath?.()
  : undefined;

export function useWebviewLifecycle(
  browserId: string,
  tabs: BrowserTab[],
  activeTabId: string,
  updateTabLocal: (tabId: string, update: Partial<TabLocalState>) => void,
) {
  const dispatch = useAppDispatch();
  const webviewMap = useRef<Map<string, WebviewElement>>(new Map());
  const initializedTabs = useRef(new Set<string>());

  useEffect(() => {
    setRegistryActiveTab(browserId, activeTabId);
  }, [browserId, activeTabId]);

  const tabIdKey = tabs.map((t) => t.id).join(',');
  useEffect(() => {
    if (!isElectron) return;
    const cleanups: (() => void)[] = [];

    for (const tab of tabs) {
      const wv = webviewMap.current.get(tab.id);
      if (!wv) continue;
      const tabId = tab.id;

      registerWebview(browserId, tabId, wv);

      if (!initializedTabs.current.has(tabId)) {
        initializedTabs.current.add(tabId);
        const targetUrl = tab.url;
        const doLoad = () => { wv.loadURL(targetUrl).catch(() => {}); };
        // @ts-expect-error webview addEventListener supports options
        wv.addEventListener('dom-ready', doLoad, { once: true });
        cleanups.push(() => wv.removeEventListener('dom-ready', doLoad));
      }

      const onNavigate = () => {
        const newUrl = wv.getURL();
        dispatch(updateBrowserTabUrl({ browserId, tabId, url: newUrl }));
        updateTabLocal(tabId, { canGoBack: wv.canGoBack(), canGoForward: wv.canGoForward() });
      };
      const onTitleUpdate = () => {
        dispatch(updateBrowserTabTitle({ browserId, tabId, title: wv.getTitle() }));
      };
      const onLoadStart = () => updateTabLocal(tabId, { loading: true });
      const onLoadStop = () => { updateTabLocal(tabId, { loading: false }); onNavigate(); onTitleUpdate(); };
      const onFaviconUpdate = (e: any) => {
        const favicons = e.favicons || (e.detail && e.detail.favicons);
        if (favicons?.[0]) {
          dispatch(updateBrowserTabFavicon({ browserId, tabId, favicon: favicons[0] }));
        }
      };

      wv.addEventListener('did-navigate', onNavigate);
      wv.addEventListener('did-navigate-in-page', onNavigate);
      wv.addEventListener('page-title-updated', onTitleUpdate);
      wv.addEventListener('did-start-loading', onLoadStart);
      wv.addEventListener('did-stop-loading', onLoadStop);
      wv.addEventListener('page-favicon-updated', onFaviconUpdate);

      cleanups.push(() => {
        unregisterWebview(browserId, tabId);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
        wv.removeEventListener('page-title-updated', onTitleUpdate);
        wv.removeEventListener('did-start-loading', onLoadStart);
        wv.removeEventListener('did-stop-loading', onLoadStop);
        wv.removeEventListener('page-favicon-updated', onFaviconUpdate);
      });
    }

    return () => cleanups.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIdKey, browserId, dispatch, updateTabLocal]);

  return webviewMap;
}
