import type { AgentMessage } from '@/shared/state/agentsSlice';
import type { ToolPair } from '../tool-bubbles/ToolCallBubble';
import type { RenderItem, ToolGroup, ToolGroupEntry } from '../tool-bubbles/ToolGroupBubble';
import { isShowUiPair, isAskUiPair, callToolUseId, resultToolUseId } from '../tool-ui/showUiPayload';
import { isNarration } from '../parsing/isNarration';

// Live-updating cards: repeated ShowUI calls with the SAME component+props.id are one card that
// UPDATES IN PLACE at its first position (progress advances, data refreshes), never a stack of
// stale snapshots. Pre-scan maps each id key to its first slot and its latest call+result.
function indexShowUiCards(messages: AgentMessage[]) {
  const firstCallIdByKey = new Map<string, string>();
  const latestByKey = new Map<string, { call: AgentMessage; result: AgentMessage | null }>();
  const keyByCallId = new Map<string, string>();
  for (let s = 0; s < messages.length; s++) {
    const m = messages[s];
    const mc = m.content;
    if (m.role !== 'tool_call' || typeof mc !== 'object' || !/(^|__)ShowUI$/.test(String(mc?.tool || ''))) continue;
    const input = mc?.input as { component?: unknown; props?: { id?: unknown } } | undefined;
    const compId = input?.props?.id;
    if (!input?.component || typeof compId !== 'string' || !compId) continue;
    const key = `${input.component}:${compId}`;
    keyByCallId.set(m.id, key);
    if (!firstCallIdByKey.has(key)) firstCallIdByKey.set(key, m.id);
    const next = messages[s + 1];
    latestByKey.set(key, { call: m, result: next && next.role === 'tool_result' ? next : null });
  }
  return { firstCallIdByKey, latestByKey, keyByCallId };
}

// Index pairing mispairs any parallel batch (first-completing result lands on the first call, killing a live AskUI card, ENG-232); pair by tool_use_id when the result carries one, index only for legacy unkeyed results.
function pairCalls(allCalls: AgentMessage[], results: AgentMessage[]): ToolPair[] {
  const resultById = new Map<string, AgentMessage>();
  for (const r of results) {
    const rid = resultToolUseId(r);
    if (rid && !resultById.has(rid)) resultById.set(rid, r);
  }
  return allCalls.map((call, idx) => {
    const byId = resultById.get(callToolUseId(call));
    const indexed = results[idx] || null;
    return {
      type: 'tool_pair' as const,
      id: `pair-${call.id}`,
      call,
      result: byId ?? (indexed && !resultToolUseId(indexed) ? indexed : null),
    };
  });
}

interface NoteMark { afterCall: number; msg: AgentMessage }

// Folded narration goes back at its original position among the visible pairs.
function foldNotes(allPairs: ToolPair[], noteMarks: NoteMark[]): ToolGroupEntry[] | undefined {
  if (noteMarks.length === 0) return undefined;
  const entries: ToolGroupEntry[] = [];
  let noteIdx = 0;
  const noteText = (m: AgentMessage) => (typeof m.content === 'string' ? m.content : '');
  allPairs.forEach((pair, idx) => {
    while (noteIdx < noteMarks.length && noteMarks[noteIdx].afterCall <= idx) {
      entries.push({ kind: 'note', id: `note-${noteMarks[noteIdx].msg.id}`, text: noteText(noteMarks[noteIdx].msg) });
      noteIdx++;
    }
    if (!isShowUiPair(pair) && !isAskUiPair(pair)) entries.push({ kind: 'pair', pair });
  });
  while (noteIdx < noteMarks.length) {
    entries.push({ kind: 'note', id: `note-${noteMarks[noteIdx].msg.id}`, text: noteText(noteMarks[noteIdx].msg) });
    noteIdx++;
  }
  return entries;
}

function groupLabel(calls: AgentMessage[]): string {
  const toolNames = new Set(calls.map((m) => (typeof m.content === 'object' ? m.content.tool : '')));
  return toolNames.size === 1 ? calls[0].content?.tool || 'Tool calls' : `${calls.length} tool calls`;
}

// Groups the active-branch messages into the transcript's render items: tool phases fold into groups
// (with narration absorbed on a finished session), ShowUI/AskUI pairs surface as inline components with
// in-place updates, plain messages pass through. Pure; the hook memoizes it. Lifted from AgentChat.
export function buildRenderItems(activeBranchMessages: AgentMessage[], sessionRunning: boolean): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  const { firstCallIdByKey, latestByKey, keyByCallId } = indexShowUiCards(activeBranchMessages);
  // Narration that led INTO a tool phase; folds into that phase's group on a finished session.
  let leadNotes: AgentMessage[] = [];
  while (i < activeBranchMessages.length) {
    const msg = activeBranchMessages[i];
    if (msg.role === 'tool_call' || msg.role === 'tool_result') {
      const group: AgentMessage[] = [];
      // On a finished session the whole tool PHASE folds into one quiet row: short narration
      // LEADING INTO or BETWEEN tool runs is absorbed (readable on expand), only the final
      // answer stays out. While running, narration streams visibly, so the phase never folds live.
      const noteMarks: NoteMark[] = leadNotes.map((m) => ({ afterCall: 0, msg: m }));
      leadNotes = [];
      let callsSoFar = 0;
      while (i < activeBranchMessages.length) {
        const m = activeBranchMessages[i];
        if (m.role === 'tool_call' || m.role === 'tool_result') {
          group.push(m);
          if (m.role === 'tool_call') callsSoFar++;
          i++;
          continue;
        }
        if (!sessionRunning && m.role === 'assistant') {
          let j = i;
          while (j < activeBranchMessages.length && activeBranchMessages[j].role === 'assistant') j++;
          const next = activeBranchMessages[j];
          const absorbable = activeBranchMessages.slice(i, j).every((a) => isNarration(a.content));
          // A long or structured message is the answer, not narration. Absorbing it hides the whole deliverable in a grey tool row and strips its markdown, which is worse than showing one redundant line.
          if (next && absorbable && (next.role === 'tool_call' || next.role === 'tool_result')) {
            for (let k = i; k < j; k++) {
              if (!activeBranchMessages[k].hidden) noteMarks.push({ afterCall: callsSoFar, msg: activeBranchMessages[k] });
            }
            i = j;
            continue;
          }
        }
        break;
      }

      const allCalls = group.filter((m) => m.role === 'tool_call');
      const results = group.filter((m) => m.role === 'tool_result');
      const allPairs = pairCalls(allCalls, results);

      // ShowUI/AskUI calls render as inline components, never buried inside a collapsed group.
      // They typically cap a run of work, so the quiet group row stays above the widget.
      const showUiPairs = allPairs.filter((p) => isShowUiPair(p) || isAskUiPair(p));
      const pairs = allPairs.filter((p) => !isShowUiPair(p) && !isAskUiPair(p));
      const calls = pairs.map((p) => p.call);
      const groupEntries = foldNotes(allPairs, noteMarks);

      const mcpServers = new Set(
        calls.map((m) => {
          const tool = typeof m.content === 'object' ? m.content.tool || '' : '';
          const match = tool.match(/^mcp__([^_]+(?:-[^_]+)*)__/);
          return match ? match[1] : '';
        }).filter(Boolean)
      );
      // Only wrap MCP calls in a group when there's more than one; a lone call would just double up the group header on top of its own (e.g. "Browser Navigation 1/1" over "Opened a browser"), so render it bare instead.
      const allSameMcp = mcpServers.size === 1 && pairs.length > 1;

      if (allSameMcp) {
        const mcpServer = [...mcpServers][0];
        items.push({
          type: 'tool_group',
          id: `group-${group[0].id}`,
          pairs,
          label: groupLabel(calls),
          callCount: calls.length,
          mcpServer,
          entries: groupEntries,
        } satisfies ToolGroup);
      } else if (sessionRunning && pairs.length <= 2 && !groupEntries) {
        // Live turns keep bare rows for streaming detail; finished transcripts always rest as the quiet group row.
        items.push(...pairs);
      } else if (pairs.length > 0) {
        items.push({
          type: 'tool_group',
          id: `group-${group[0].id}`,
          pairs,
          label: groupLabel(calls),
          callCount: calls.length,
          entries: groupEntries,
        } satisfies ToolGroup);
      } else if (noteMarks.length > 0) {
        // Phase held only ShowUI/AskUI pairs: narration has no group to fold into, keep it visible.
        for (const nm of noteMarks) items.push(nm.msg);
      }
      for (const p of showUiPairs) {
        const key = keyByCallId.get(p.call.id);
        if (!key || isAskUiPair(p)) {
          items.push(p);
          continue;
        }
        // Later updates render nowhere themselves; the first slot always shows the latest call
        // under a STABLE key so React updates the mounted component instead of remounting it.
        if (p.call.id !== firstCallIdByKey.get(key)) continue;
        const latest = latestByKey.get(key);
        items.push({
          type: 'tool_pair' as const,
          id: `showui-${key}`,
          call: latest ? latest.call : p.call,
          result: latest ? latest.result : p.result,
        });
      }
    } else {
      if (!sessionRunning && msg.role === 'assistant') {
        let j = i;
        while (j < activeBranchMessages.length && activeBranchMessages[j].role === 'assistant') j++;
        const next = activeBranchMessages[j];
        if (next && (next.role === 'tool_call' || next.role === 'tool_result')) {
          leadNotes = activeBranchMessages.slice(i, j).filter((m) => !m.hidden);
          i = j;
          continue;
        }
      }
      if (!msg.hidden) {
        items.push(msg);
      }
      i++;
    }
  }
  return items;
}
