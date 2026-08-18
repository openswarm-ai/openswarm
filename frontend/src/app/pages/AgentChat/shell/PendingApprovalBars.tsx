import { useAppDispatch } from '@/shared/hooks';
import { handleApproval, type ApprovalRequest } from '@/shared/state/agentsSlice';
import ApprovalBar, { BatchApprovalBar } from './ApprovalBar';

// The pending-approval strip above the composer: one bar per request, or the batch bar once more than
// one is waiting. Both route through the same allow/deny thunk. Lifted verbatim from AgentChat's render.
export function PendingApprovalBars({ requests }: { requests: ApprovalRequest[] }) {
  const dispatch = useAppDispatch();
  const onApprove = (requestId: string, updatedInput?: Record<string, any>, trustPattern?: boolean, alwaysAllow?: boolean) =>
    dispatch(handleApproval({ requestId, behavior: 'allow', updatedInput, trustPattern, setAlwaysAllow: alwaysAllow }));
  const onDeny = (requestId: string, message?: string) => dispatch(handleApproval({ requestId, behavior: 'deny', message }));
  if (requests.length > 1) return <BatchApprovalBar requests={requests} onApprove={onApprove} onDeny={onDeny} />;
  return <>{requests.map((req) => <ApprovalBar key={req.id} request={req} onApprove={onApprove} onDeny={onDeny} />)}</>;
}
