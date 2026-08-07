import { getToolLabelWithInput } from '@/app/pages/AgentChat/parsing/toolLabels';

export interface AgentLiveStep {
  label: string;
  done: boolean;
}

// UI/meta tools are not "steps" a bystander cares about; the checklist is real work only.
const HIDDEN_TOOLS = /(^|__)(ShowUI|AskUI|AskUserQuestion|TodoWrite|MCPSearch|MCPActivate)$/i;

/** The collapsed card's transition phase when the agent made no TodoWrite plan: the current turn's
    tool activity as a simple checklist, done steps checked, the live one last. */
export function extractLiveSteps(messages: Array<{ role: string; content: unknown; hidden?: boolean }>): AgentLiveStep[] | null {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].hidden) { start = i + 1; break; }
  }
  const steps: AgentLiveStep[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool_call') continue;
    const body = (typeof m.content === 'object' && m.content !== null ? m.content : {}) as { tool?: unknown; input?: unknown };
    const tool = String(body.tool || '');
    if (!tool || HIDDEN_TOOLS.test(tool)) continue;
    const done = messages[i + 1]?.role === 'tool_result';
    // MCP names arrive prefixed ("web__WebSearch"); the checklist speaks the bare action's language.
    const bare = tool.replace(/^.*__/, '');
    const lbl = getToolLabelWithInput(bare, body.input, (m as { id?: string }).id);
    const label = done ? lbl.past : lbl.present;
    // Consecutive same-verb steps merge so "Read a file" x8 doesn't fill the card.
    const prev = steps[steps.length - 1];
    if (prev && prev.label === label) { prev.done = prev.done && done; continue; }
    steps.push({ label, done });
  }
  return steps.length ? steps : null;
}
