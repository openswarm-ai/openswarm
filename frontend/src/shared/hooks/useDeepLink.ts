import { useEffect } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { activateSubscription, activateSignin } from '@/shared/state/settingsSlice';
import { fetchModels } from '@/shared/state/modelsSlice';
import { fetchTools } from '@/shared/state/toolsSlice';
import { API_BASE } from '@/shared/config';
import { report } from '@/shared/serviceClient';

/** Subscribe to openswarm:// auth/oauth deep-links from Electron main; no-op in browser. */
export function useDeepLink(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const api = (window as any).openswarm as OpenSwarmAPI | undefined;
    if (!api) return;

    const unsubscribe = api.onAuthUrl?.((rawUrl: string) => {
      try {
        // openswarm://auth?token=...; signin=true => free sign-in, else Stripe activation.
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
          // 1.0.29 only ships Google sign-in; read for forward compat.
          void signinMethodRaw;
          report('signin', 'deep_link_received', { method: 'google' });

          dispatch(activateSignin({ token, signin_method: 'google', email }))
            .unwrap()
            .then((res) => {
              report('signin', 'activated', { method: res.signin_method, plan: res.plan });
              dispatch(fetchModels());
            })
            .catch((err) => {
              console.error('[deep-link] Sign-in activation failed:', err);
              // unwrap() rejects with a SerializedError object; String() of it is "[object Object]".
              report('signin', 'activation_failed', {
                message: String(err?.message ?? err).slice(0, 120),
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
            // Refresh models so Pro-proxy Claude models appear in the picker immediately.
            dispatch(fetchModels());
          })
          .catch((err) => {
            console.error('[deep-link] Activation failed:', err);
            report('subscription', 'activation_failed', {
              message: String(err?.message ?? err).slice(0, 120),
            });
          });
      } catch (e) {
        console.error('[deep-link] Failed to parse URL', rawUrl, e);
      }
    });

    let unsubscribeOauth: (() => void) | undefined;
    if (api?.onOauthClaim) {
      unsubscribeOauth = api.onOauthClaim(async (rawUrl: string) => {
        try {
          // openswarm://oauth/{provider}/complete?session_id=...&tool_id=...
          const url = new URL(rawUrl);
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
