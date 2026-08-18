import { handleAgentSessionEvent } from './agentSessionEvents';
import { handleAgentStreamEvent } from './agentStreamEvents';
import { handleDashboardBrowserEvent } from './dashboardBrowserEvents';
import { handleOutputEvent } from './outputEvents';
import { handleSettingsEvent } from './settingsEvents';
import { handleWorkflowEvent } from './workflowEvents';
import type { WSEvent } from './types';
import type { WsEventHandlerContext } from './eventHandlerTypes';

export function handleWsEvent(msg: WSEvent, context: WsEventHandlerContext): boolean {
  const streamResult = handleAgentStreamEvent(msg, context);
  if (streamResult !== null) return streamResult;

  const agentResult = handleAgentSessionEvent(msg);
  if (agentResult !== null) return agentResult;

  const outputResult = handleOutputEvent(msg);
  if (outputResult !== null) return outputResult;

  const workflowResult = handleWorkflowEvent(msg);
  if (workflowResult !== null) return workflowResult;

  const dashboardResult = handleDashboardBrowserEvent(msg);
  if (dashboardResult !== null) return dashboardResult;

  const settingsResult = handleSettingsEvent(msg);
  if (settingsResult !== null) return settingsResult;

  return true;
}
