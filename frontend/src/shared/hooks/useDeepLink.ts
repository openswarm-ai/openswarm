import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { activateSubscription, activateSignin } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import { fetchTools } from '@/shared/state/toolsSlice';
import { API_BASE } from '@/shared/config';
import { report } from '@/shared/serviceClient';

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
    // Both listeners are optional — useDeepLink no-ops in browser/web context
    // where window.openswarm is undefined.
    if (!api) return;

    const unsubscribe = api.onAuthUrl?.((rawUrl: string) => {
      try {
        // openswarm://auth?token=...  (host = "auth", search carries fields).
        // Two flavors land here, distinguished by the `signin` flag:
        //   - signin=true  → free-tier sign-in (Google OAuth / magic link)
        //   - (default)    → Stripe checkout subscription activation
        // Note: the bearer-handoff page in lib/authMint.ts (cloud) POSTs
        // directly to localhost so this deep-link path is currently a
        // backstop for older flows. Both branches here remain wired up.
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
        const isSignin = url.searchParams.get('signin') === 'true';
        const signinMethodRaw = url.searchParams.get('signin_method');
        const email = url.searchParams.get('email');
        const plan = url.searchParams.get('plan');
        const expires = url.searchParams.get('expires');

        if (isSignin) {
          const signinMethod: 'google' | 'magic_link' =
            signinMethodRaw === 'magic_link' ? 'magic_link' : 'google';
          report('signin', 'deep_link_received', { method: signinMethod });

          dispatch(activateSignin({ token, signin_method: signinMethod, email }))
            .unwrap()
            .then((res) => {
              report('signin', 'activated', { method: res.signin_method, plan: res.plan });
              dispatch(fetchModels());
            })
            .catch((err) => {
              console.error('[deep-link] Sign-in activation failed:', err);
              report('signin', 'activation_failed', {
                message: String(err).slice(0, 120),
              });
            });
          return;
        }

        report('subscription', 'deep_link_received', {
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
            report('subscription', 'activated', { plan: res.plan });
            // Re-fetch the model list so the Claude models (via OpenSwarm
            // Pro proxy) show up in the chat picker right away.
            dispatch(fetchModels());
          })
          .catch((err) => {
            console.error('[deep-link] Activation failed:', err);
            report('subscription', 'activation_failed', {
              message: String(err).slice(0, 120),
            });
          });
      } catch (e) {
        console.error('[deep-link] Failed to parse URL', rawUrl, e);
      }
    });

    // OAuth claim deep-link listener. The Electron main process routes
    // openswarm://oauth/{provider}/complete to its own IPC channel so we
    // can claim tokens immediately rather than routing through Settings.
    let unsubscribeOauth: (() => void) | undefined;
    if (api?.onOauthClaim) {
      unsubscribeOauth = api.onOauthClaim(async (rawUrl: string) => {
        try {
          const url = new URL(rawUrl);
          // Expected: openswarm://oauth/{provider}/complete?session_id=...&tool_id=...
          if (url.host !== 'oauth' || !url.pathname.endsWith('/complete')) {
            console.warn('[deep-link] Unexpected oauth-claim URL:', rawUrl);
            return;
          }
          const sessionId = url.searchParams.get('session_id');
          const toolId = url.searchParams.get('tool_id');
          if (!sessionId || !toolId) {
            console.warn('[deep-link] Missing session_id or tool_id in', rawUrl);
            return;
          }

          report('oauth', 'deep_link_received', { provider: url.pathname.split('/')[1] || 'unknown' });

          const resp = await fetch(`${API_BASE}/tools/oauth/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, tool_id: toolId }),
          });
          if (!resp.ok) {
            const text = await resp.text();
            console.error('[deep-link] OAuth claim failed:', resp.status, text);
            report('oauth', 'claim_failed', { status: resp.status });
            return;
          }
          report('oauth', 'claim_succeeded');
          // Refresh tools so the UI reflects the newly-connected tool.
          dispatch(fetchTools());
        } catch (e) {
          console.error('[deep-link] OAuth claim threw:', e);
        }
      });
    }

    return () => {
      unsubscribe?.();
      unsubscribeOauth?.();
    };
  }, [dispatch]);
}
