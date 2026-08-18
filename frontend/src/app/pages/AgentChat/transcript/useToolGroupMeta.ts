import { useEffect, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { generateGroupMeta, type AgentSession } from '@/shared/state/agentsSlice';
import { parseMcpToolName, getMcpInputSummary } from '@/shared/mcpToolMeta';
import { type RenderItem, type ToolGroup, isToolGroup } from '../tool-bubbles/ToolGroupBubble';

// Tool-group label generation (AGENTCHAT_SPLIT_PLAN follow-up): request a friendly group label once per
// group as it appears, then refine it once when every call in the group has a result. The requested/
// refined sets are refs so re-renders never duplicate a request. Lifted verbatim from AgentChat.
export function useToolGroupMeta(
  id: string | undefined,
  isDraft: boolean,
  renderItems: RenderItem[],
  toolGroupMeta: AgentSession['tool_group_meta'] | undefined,
) {
  const dispatch = useAppDispatch();
  const groupMetaRequestedRef = useRef<Set<string>>(new Set());
  const groupMetaRefinedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!id || isDraft) return;
    const toolGroups = renderItems.filter(isToolGroup) as ToolGroup[];
    const meta = toolGroupMeta ?? {};

    for (const group of toolGroups) {
      const allDone = group.pairs.every((p) => p.result !== null);

      if (!groupMetaRequestedRef.current.has(group.id) && !meta[group.id]) {
        groupMetaRequestedRef.current.add(group.id);
        const toolCalls = group.pairs.map((p) => {
          const c = p.call.content;
          const tool = typeof c === 'object' ? c.tool || '' : '';
          const input = typeof c === 'object' ? c.input : '';
          const mcp = parseMcpToolName(tool);
          const friendly = mcp.isMcp ? getMcpInputSummary(input, mcp.action, mcp.serverSlug) : '';
          const summary = friendly || (typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120));
          return { tool, input_summary: summary };
        });
        dispatch(generateGroupMeta({ sessionId: id, groupId: group.id, toolCalls }));
      }

      if (allDone && meta[group.id] && !meta[group.id].is_refined && !groupMetaRefinedRef.current.has(group.id)) {
        groupMetaRefinedRef.current.add(group.id);
        const toolCalls = group.pairs.map((p) => {
          const c = p.call.content;
          const tool = typeof c === 'object' ? c.tool || '' : '';
          const input = typeof c === 'object' ? c.input : '';
          const mcp = parseMcpToolName(tool);
          const friendly = mcp.isMcp ? getMcpInputSummary(input, mcp.action, mcp.serverSlug) : '';
          const summary = friendly || (typeof input === 'string' ? input.slice(0, 120) : JSON.stringify(input).slice(0, 120));
          return { tool, input_summary: summary };
        });
        const resultsSummary = group.pairs
          .filter((p) => p.result)
          .map((p) => {
            const rc = p.result!.content;
            const text = typeof rc === 'string' ? rc : typeof rc === 'object' && rc?.text ? rc.text : JSON.stringify(rc);
            return text.slice(0, 150);
          });
        dispatch(generateGroupMeta({ sessionId: id, groupId: group.id, toolCalls, resultsSummary, isRefinement: true }));
      }
    }
  }, [renderItems, id, isDraft, toolGroupMeta, dispatch]);
}
