import React from 'react';
import Box from '@mui/material/Box';
import type { AgentMessage, AgentSession } from '@/shared/state/agentsSlice';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { openCardContextMenu, isNativeMenuTarget, type CardMenuRow } from '../../Dashboard/desktop/openCardContextMenu';
import MessageBubble from '../bubbles/MessageBubble';
import BurstRevealBubble from '../bubbles/BurstRevealBubble';
import CompactionMarker from '../bubbles/CompactionMarker';
import MessageActionBar from '../shell/MessageActionBar';
import ToolCallBubble from '../tool-bubbles/ToolCallBubble';
import ToolGroupBubble, { type RenderItem, isToolGroup, isToolPair } from '../tool-bubbles/ToolGroupBubble';
import ToolUiBubble from '../tool-ui/ToolUiBubble';
import AskUiBubble from '../tool-ui/AskUiBubble';
import { isShowUiPair, isAskUiPair, isDeadAskResult } from '../tool-ui/showUiPayload';

// Everything one transcript item's inner content needs, as a single structured view model built fresh
// each render by AgentChat (same staleness semantics as the previously-inline closures). The
// data-window-item-id measurement wrapper around this content belongs to MessageListBody (mechanism).
export interface TranscriptItemVm {
  session: AgentSession;
  id: string | undefined;
  c: ReturnType<typeof useClaudeTokens>;
  renderItems: RenderItem[];
  sessionRunning: boolean;
  awaitingResponse: boolean;
  justStreamedId: string | null;
  // Only the LATEST unanswered question is live (the backend parks one component); older pending asks render as quiet rows.
  lastPendingAskCallId: string | null;
  // Burst-reveal history set (useBurstRevealTracking): null right after open/hop, seeded by the first item render.
  seenMessageIds: React.MutableRefObject<Set<string> | null>;
  editingMessageId: string | null;
  lastAssistantIdsInTurn: Set<string>;
  branchNavLocked: boolean;
  viewportHeight: number;
  viewportWidth: number;
  scrollRoot: HTMLDivElement | null;
  getSiblingBranches: (messageId: string) => string[];
  onSaveEdit: (messageId: string, newContent: string) => void;
  onCancelEdit: () => void;
  onStartEdit: (messageId: string) => void;
  onRegenerate: (msg: AgentMessage) => void;
  onBranch: (messageId: string) => void;
  onSwitchBranch: (branchId: string) => void;
  onStreamGrew: () => void;
}

// One transcript item: a tool group, a tool pair (plain, ShowUI widget, or AskUI form), or a message
// bubble with its action bar, plus the compaction chip when this item is the compaction anchor. Lifted
// verbatim from AgentChat's render.
export function TranscriptItem({ item, vm, isLastVisibleItem }: { item: RenderItem; vm: TranscriptItemVm; isLastVisibleItem: boolean }) {
  const { session } = vm;
  const isCompactionAnchor = !!session.compacted_through_msg_id && item.id === session.compacted_through_msg_id;
  const compactionChip = isCompactionAnchor ? (
    <CompactionMarker
      key={`compaction-${item.id}`}
      collapsedCount={
        Math.max(0, vm.renderItems.findIndex((it) => it.id === session.compacted_through_msg_id) + 1)
      }
    />
  ) : null;

  if (isToolGroup(item)) {
    const groupMeta = session.tool_group_meta?.[item.id];
    // Only the newest tool row can glow as running; older groups on a live turn rest quiet.
    return (
      <>
        <ToolGroupBubble group={item} isSessionRunning={vm.sessionRunning && isLastVisibleItem} meta={groupMeta} sessionId={session.id} />
        {compactionChip}
      </>
    );
  }
  if (isToolPair(item)) {
    const isPending = item.result === null && vm.sessionRunning;
    if (isAskUiPair(item)) {
      // A dead ask (timeout prose or a validation bounce) is not answerable; rendering it full-size is the "two identical cards, only one works" dupe (ENG-232).
      // Likewise an older pending ask when a newer one is live: a quiet row instead of a second clickable form.
      const quiet = isDeadAskResult(item) || (item.result === null && vm.lastPendingAskCallId !== null && item.call.id !== vm.lastPendingAskCallId);
      return (
        <>
          {quiet
            ? <ToolCallBubble call={item.call} result={item.result} isPending={false} sessionId={session.id} suppressReveal />
            : <AskUiBubble pair={item} sessionId={session.id} isPending={isPending} suppressReveal={item.call.id === vm.justStreamedId} />}
          {compactionChip}
        </>
      );
    }
    if (isShowUiPair(item)) {
      return (
        <>
          <ToolUiBubble pair={item} sessionId={session.id} isPending={isPending} suppressReveal={item.call.id === vm.justStreamedId} sessionRunning={vm.sessionRunning} />
          {compactionChip}
        </>
      );
    }
    return (
      <>
        <ToolCallBubble call={item.call} result={item.result} isPending={isPending} sessionId={session.id} suppressReveal={item.call.id === vm.justStreamedId} />
        {compactionChip}
      </>
    );
  }
  const msg = item;
  const isEditing = vm.editingMessageId === msg.id;
  // First pass after open/hop seeds the set; later unseen assistant ids arrived live.
  if (vm.seenMessageIds.current === null) {
    vm.seenMessageIds.current = new Set(vm.renderItems.map((it) => it.id));
  }
  const burstAnimate =
    msg.role === 'assistant' &&
    typeof msg.content === 'string' &&
    !isEditing &&
    !vm.seenMessageIds.current.has(msg.id) &&
    msg.id !== vm.justStreamedId &&
    (vm.sessionRunning || vm.awaitingResponse);
  vm.seenMessageIds.current.add(msg.id);
  const siblings = vm.getSiblingBranches(msg.id);
  const hasBranches = siblings.length > 0;
  const currentBranchIdx = hasBranches
    ? siblings.indexOf(session.active_branch_id || 'main')
    : 0;
  const rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const canRegenerate = msg.role === 'assistant' && vm.lastAssistantIdsInTurn.has(msg.id);

  return (
    <Box
      onContextMenu={(e: React.MouseEvent) => {
        // ENG-148: the hover action bar's verbs, reachable by right-click on any message; typing surfaces (the edit box) keep the OS menu.
        if (isEditing || isNativeMenuTarget(e)) return;
        const selection = window.getSelection()?.toString() ?? '';
        const items: CardMenuRow[] = [];
        if (selection) items.push({ label: 'Copy selection', onClick: () => { void navigator.clipboard.writeText(selection); } });
        items.push({ label: 'Copy message', onClick: () => { void navigator.clipboard.writeText(rawText); } });
        if (msg.role === 'user') items.push({ label: 'Edit message', onClick: () => vm.onStartEdit(msg.id) });
        if (canRegenerate) {
          items.push({ kind: 'separator' });
          items.push({ label: 'Regenerate', onClick: () => vm.onRegenerate(msg) });
          items.push({ label: 'Branch chat', onClick: () => vm.onBranch(msg.id) });
        }
        openCardContextMenu(e, { items });
      }}
      sx={{
        '&:hover .msg-actions': { opacity: 1 },
        // Cheap virtualization: tells the browser to skip paint + layout for bubbles outside the scroll viewport. `contain-intrinsic-size: auto N` reserves a placeholder height so the scrollbar doesn't jump, and `auto` lets the browser remember the actual height after first render. Works alongside the container's overflow-anchor. Chrome 85+ (Electron covers this).
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 120px',
      }}
    >
      {msg.role === 'assistant' && typeof msg.content === 'string' && !isEditing ? (
        <BurstRevealBubble
          message={msg}
          animate={burstAnimate}
          onGrew={vm.onStreamGrew}
          viewportHeight={vm.viewportHeight}
          viewportWidth={vm.viewportWidth}
          scrollRoot={vm.scrollRoot}
        />
      ) : (
        <MessageBubble
          message={msg}
          editing={isEditing}
          onSaveEdit={vm.onSaveEdit}
          onCancelEdit={vm.onCancelEdit}
          viewportHeight={vm.viewportHeight}
          viewportWidth={vm.viewportWidth}
          scrollRoot={vm.scrollRoot}
        />
      )}
      {!isEditing && (msg.role === 'user' || canRegenerate) && (
        <MessageActionBar
          role={msg.role as 'user' | 'assistant'}
          sessionId={session.id}
          messageId={msg.id}
          onCopy={() => navigator.clipboard.writeText(rawText)}
          onEdit={msg.role === 'user' ? () => vm.onStartEdit(msg.id) : undefined}
          onRegenerate={msg.role === 'assistant' ? () => vm.onRegenerate(msg) : undefined}
          onBranch={msg.role === 'assistant' ? () => vm.onBranch(msg.id) : undefined}
          branchNav={
            hasBranches
              ? {
                  currentIndex: Math.max(0, currentBranchIdx),
                  totalBranches: siblings.length,
                  disabled: vm.branchNavLocked,
                  onPrevious: () => {
                    if (vm.branchNavLocked) return;
                    const prevBranch = siblings[Math.max(0, currentBranchIdx - 1)];
                    if (prevBranch && vm.id) vm.onSwitchBranch(prevBranch);
                  },
                  onNext: () => {
                    if (vm.branchNavLocked) return;
                    const nextBranch = siblings[Math.min(siblings.length - 1, currentBranchIdx + 1)];
                    if (nextBranch && vm.id) vm.onSwitchBranch(nextBranch);
                  },
                }
              : undefined
          }
        />
      )}
      {compactionChip}
    </Box>
  );
}
