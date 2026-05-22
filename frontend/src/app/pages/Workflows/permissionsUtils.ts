import type { Workflow, PermissionTier } from '@/shared/state/workflowsSlice';

// Pre-save validation. Returns the first user-visible reason save should
// be blocked, or null when the draft is good to ship. Phone numbers on
// text/call tiers must be non-empty and at least 7 digits so the eventual
// SMS/voice bridge has something usable to dial.
export function validateDraft(draft: Workflow): string | null {
  for (const tier of (draft.permissions || [])) {
    if (tier.kind === 'notify') continue;
    const cleaned = (tier.phone || '').replace(/[^\d+]/g, '');
    if (!cleaned) {
      return tier.kind === 'text'
        ? 'Add a phone number for the text-me tier.'
        : 'Add a phone number for the call-me tier.';
    }
    if (cleaned.replace(/^\+/, '').length < 7) {
      return `Phone number looks too short (${tier.kind} tier).`;
    }
  }
  return null;
}

// Walk the existing permissions list and produce the next tier in the
// chain (notify -> text -> call). Returns null if we're already at call,
// which the UI uses to hide the "+ add backup" affordance.
export function nextTierAfter(tiers: PermissionTier[]): PermissionTier | null {
  const last = tiers.length ? tiers[tiers.length - 1].kind : 'notify';
  if (last === 'notify') return { kind: 'text', after_minutes: 5, phone: '' };
  if (last === 'text') return { kind: 'call', after_minutes: 60, phone: '' };
  return null;
}
