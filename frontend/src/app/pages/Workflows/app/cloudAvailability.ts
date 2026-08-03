import type { CloudStatus, CloudStatusReady } from './cloudApi';

// One probe, three honest outcomes plus "still asking". Anything we have not heard back about is
// `unknown`, never a refusal: a hiccup that renders as "not entitled" is a paywall built out of a
// dropped packet.
export type CloudProbe =
  | { phase: 'checking' }
  | { phase: 'unreachable' }
  | { phase: 'answered'; status: CloudStatus };

export type CloudAvailability =
  | { kind: 'checking' }
  | { kind: 'unknown'; detail: string | null }
  | { kind: 'blocked'; reason: string; action: 'sign_in' | 'plans' | 'connect' | null }
  | { kind: 'available' };

const PLAN_REQUIRED = 'Cloud runs come with Pro and up. On this plan, workflows run on this device.';

function blockedForAccount(status: CloudStatusReady): CloudAvailability | null {
  if (status.limits.workflows === 0) {
    return { kind: 'blocked', reason: PLAN_REQUIRED, action: 'plans' };
  }
  // A workflow already up there is holding one of the slots, so its own slot must not read as full.
  const holdsASlot = status.hosted !== null;
  if (!holdsASlot && status.usage.workflows_enabled >= status.limits.workflows) {
    return {
      kind: 'blocked',
      reason: `${status.usage.workflows_enabled} of ${status.limits.workflows} cloud workflows used. Turn one off to move this one up.`,
      action: null,
    };
  }
  return null;
}

/** Whether the Cloud choice can be offered, and if not, the sentence that says why.
 *  Reasons about the workflow itself come first: telling someone to upgrade for a job the runner
 *  could never do is a sale, not an answer. */
export function cloudAvailability(probe: CloudProbe): CloudAvailability {
  if (probe.phase === 'checking') return { kind: 'checking' };
  if (probe.phase === 'unreachable') return { kind: 'unknown', detail: null };
  const status = probe.status;
  if (!status.schedule_supported && status.schedule_reason) {
    return { kind: 'blocked', reason: status.schedule_reason, action: null };
  }
  if (status.state === 'unknown') return { kind: 'unknown', detail: status.detail };
  if (status.state === 'signed_out') {
    return {
      kind: 'blocked',
      reason: 'Sign in to your OpenSwarm account to run workflows in the cloud.',
      action: 'sign_in',
    };
  }
  if (status.capability && !status.capability.ok && status.capability.reason) {
    return { kind: 'blocked', reason: status.capability.reason, action: null };
  }
  // Before the plan, deliberately. Someone whose only provider is an API key cannot run in the
  // cloud at any price, so leading them to the pricing page would sell them a thing that still
  // would not work.
  if (status.credential && status.credential.state !== 'ready' && status.credential.reason) {
    return { kind: 'blocked', reason: status.credential.reason, action: 'connect' };
  }
  return blockedForAccount(status) ?? { kind: 'available' };
}

/** The account-wide ceiling, said so plainly nobody reads it as this one workflow's count.
 *  Null whenever we are unsure of the numbers, or cloud is not on the table for this workflow. */
export function usageText(probe: CloudProbe, availability: CloudAvailability): string | null {
  if (probe.phase !== 'answered' || probe.status.state !== 'ready') return null;
  const onCloud = probe.status.target === 'cloud';
  if (!onCloud && availability.kind !== 'available') return null;
  const { usage, limits } = probe.status;
  if (limits.runs_per_month === 0) return null;
  return `Your plan: ${usage.runs_this_month} of ${limits.runs_per_month} cloud runs this month`;
}
