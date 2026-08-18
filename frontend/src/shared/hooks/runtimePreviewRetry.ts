export interface RuntimeStatusPayload {
  frontend_url?: string | null;
  is_new_mode?: boolean;
  running?: boolean;
}

export type RuntimeAttachmentState = 'none' | 'possible' | 'confirmed';

export interface RuntimeRequestPlan {
  action: 'restart' | 'start';
  retryingPossibleAttachment: boolean;
}

export function planRuntimeRequest(
  retryAttempt: boolean,
  attachmentState: RuntimeAttachmentState,
): RuntimeRequestPlan {
  return {
    action: retryAttempt && attachmentState !== 'none' ? 'restart' : 'start',
    retryingPossibleAttachment: retryAttempt && attachmentState === 'possible',
  };
}

export function shouldStartAfterAmbiguousRestart(
  plan: RuntimeRequestPlan,
  status: RuntimeStatusPayload,
): boolean {
  return plan.action === 'restart'
    && plan.retryingPossibleAttachment
    && status.running === false
    && !!status.is_new_mode;
}
