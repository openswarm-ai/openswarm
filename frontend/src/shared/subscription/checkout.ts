import { trackEvent } from '@/shared/analytics';

export type OpenSwarmPlan = 'pro' | 'pro_plus' | 'ultra';
export type BillingInterval = 'monthly' | 'annual';
export type CheckoutSource = 'settings' | 'onboarding' | 'upgrade_cta';

interface SubscribeOptions {
  wasSubscribed?: boolean;
}

// Kicks off a Stripe Checkout session for the given plan + interval and opens
// the returned URL in the user's default browser (or a new tab fallback).
// All subscribe CTAs across Settings, Onboarding, and the 429 error card go
// through this helper so analytics shape and error handling stay consistent.
export async function subscribeToPlan(
  plan: OpenSwarmPlan,
  billingInterval: BillingInterval,
  source: CheckoutSource,
  opts: SubscribeOptions = {},
): Promise<void> {
  trackEvent('subscription.subscribe_clicked', {
    source,
    plan,
    billing_interval: billingInterval,
    was_subscribed: !!opts.wasSubscribed,
  });

  try {
    const r = await fetch('https://api.openswarm.com/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, billing_interval: billingInterval }),
    });
    if (!r.ok) {
      console.error(`Checkout request failed: ${r.status}`);
      return;
    }
    const { url } = await r.json();
    if (!url) return;

    trackEvent('subscription.checkout_opened', {
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
