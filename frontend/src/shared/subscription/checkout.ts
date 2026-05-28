import { report } from '@/shared/serviceClient';

export type OpenSwarmPlan = 'pro' | 'pro_plus' | 'ultra';
export type BillingInterval = 'monthly' | 'annual';
export type CheckoutSource = 'settings' | 'onboarding' | 'upgrade_cta';

interface SubscribeOptions {
  wasSubscribed?: boolean;
}

/** Create a Stripe Checkout session and open the URL externally; used by all subscribe CTAs. */
export async function subscribeToPlan(
  plan: OpenSwarmPlan,
  billingInterval: BillingInterval,
  source: CheckoutSource,
  opts: SubscribeOptions = {},
): Promise<void> {
  report('subscription', 'subscribe_clicked', {
    source,
    plan,
    billing_interval: billingInterval,
    was_subscribed: !!opts.wasSubscribed,
  });

  try {
    // Cloud uses "yearly", UI uses "annual"; normalize at the boundary.
    const wireInterval = billingInterval === 'annual' ? 'yearly' : billingInterval;

    // app_install_id lets the cloud attribute Stripe checkout to install_tokens for affiliate payout.
    let appInstallId: string | null = null;
    try {
      const api = (window as any).openswarm;
      const state = await api?.getInstallState?.();
      if (state && typeof state.app_install_id === 'string') {
        appInstallId = state.app_install_id;
      }
    } catch {}

    const body: Record<string, unknown> = { plan, billing_interval: wireInterval };
    if (appInstallId) body.app_install_id = appInstallId;

    const r = await fetch('https://api.openswarm.com/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error(`Checkout request failed: ${r.status}`);
      return;
    }
    const { url } = await r.json();
    if (!url) return;

    report('subscription', 'checkout_opened', {
      source,
      plan,
      billing_interval: billingInterval,
    });

    const api = (window as any).openswarm;
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  } catch (e) {
    console.error('Failed to create checkout session:', e);
  }
}
