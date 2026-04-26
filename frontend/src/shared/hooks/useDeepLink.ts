import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { activateSubscription } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import { trackEvent } from '@/shared/analytics';

// Listens for openswarm://auth?token=...&plan=...&expires=... URLs coming
// from the Electron main process via window.openswarm.onAuthUrl. Parses the
// payload and dispatches activateSubscription so the backend validates and
// persists the bearer.
//
// Safe no-op in web/browser contexts where window.openswarm isn't defined.
export function useDeepLink(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const api = (window as any).openswarm as OpenSwarmAPI | undefined;
    if (!api?.onAuthUrl) return;

    const unsubscribe = api.onAuthUrl((rawUrl: string) => {
      try {
        // openswarm://auth?token=...  (host = "auth", search carries fields)
        const url = new URL(rawUrl);
        if (url.host !== 'auth' && url.pathname !== '//auth' && url.pathname !== '/auth') {
          console.warn('[deep-link] Unknown openswarm:// host:', url.host);
          return;
        }
        const token = url.searchParams.get('token');
        if (!token) {
          console.warn('[deep-link] Missing token in', rawUrl);
          return;
        }
        const plan = url.searchParams.get('plan');
        const expires = url.searchParams.get('expires');

        trackEvent('subscription.deep_link_received', {
          plan: plan ?? 'unknown',
        });

        dispatch(
          activateSubscription({
            token,
            plan,
            expires,
          }),
        )
          .unwrap()
          .then((res) => {
            trackEvent('subscription.activated', { plan: res.plan });
            // Re-fetch the model list so the Claude models (via OpenSwarm
            // Pro proxy) show up in the chat picker right away.
            dispatch(fetchModels());
          })
          .catch((err) => {
            console.error('[deep-link] Activation failed:', err);
            trackEvent('subscription.activation_failed', {
              message: String(err).slice(0, 120),
            });
          });
      } catch (e) {
        console.error('[deep-link] Failed to parse URL', rawUrl, e);
      }
    });

    return unsubscribe;
  }, [dispatch]);
}
