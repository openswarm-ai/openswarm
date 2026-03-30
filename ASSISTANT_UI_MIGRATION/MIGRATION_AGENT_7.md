# Migration Agent 7: Integration, SkillBuilderChat & Cleanup

## Objective

Wire all Phase 2 outputs together in `AgentChat.tsx`. Migrate `SkillBuilderChat.tsx`. Delete all remaining dead code. Verify the build passes and the chat is functional end-to-end.

**This agent runs last, after ALL Phase 2 agents (2–6) are complete.**

## Prerequisites

- **Agents 1–6 must ALL be complete.**
  - Agent 1: Runtime adapter, toolkit skeleton, providers exist
  - Agent 2: `thread/OpenSwarmThread.tsx` exists and works
  - Agent 3: `composer/OpenSwarmComposer.tsx` exists and works
  - Agent 4: `toolkit/native-tools.tsx` is filled in
  - Agent 5: `toolkit/approval-tools.tsx` is filled in
  - Agent 6: `toolkit/mcp-tools.tsx` and `toolkit/custom-tools.tsx` are filled in

## Constraints

- **No custom styling**: Do not add CSS to make assistant-ui/Tool UI match MUI.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`.

## Step-by-Step

### 1. Rewrite AgentChat.tsx

This is the main integration task. Replace the current `AgentChat.tsx` (250 lines) with the new structure.

The current structure:
```
AgentChat
├── ChatHeader (keep)
├── Scroll container with message render loop (REPLACE → OpenSwarmThread)
│   ├── renderItems.map (messages, tool groups, tool pairs) (REPLACE)
│   ├── Streaming message (REPLACE — handled by runtime)
│   ├── ThinkingBubble (REPLACE — handled by Thread)
│   ├── Resume bubble (KEEP)
│   └── Scroll-to-bottom button (REPLACE — Thread handles this)
├── ApprovalBar / BatchApprovalBar (REPLACE → approval-tools components)
├── Glow CTA (keep)
└── MessageQueue > ChatInput (REPLACE ChatInput → OpenSwarmComposer)
```

The new structure:
```tsx
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useOpenSwarmRuntime } from './runtime/useOpenSwarmRuntime';
import { toolkit } from './toolkit';
import { OpenSwarmThread } from './thread/OpenSwarmThread';
import { OpenSwarmComposer } from './composer/OpenSwarmComposer';
import { ToolApproval, ToolQuestion, BatchApproval } from './toolkit/approval-tools';
import ChatHeader from './ChatHeader';
import MessageQueue from './MessageQueue';

const AgentChat = ({ sessionId, ... }) => {
  const runtime = useOpenSwarmRuntime(sessionId);
  const { session, handleApprove, handleDeny, handleStop, ... } = useAgentChat({ sessionId });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box sx={{ display: 'flex', height: '100%' }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {!embedded && <ChatHeader session={session} ... />}
          
          {/* Thread replaces the scroll container + message loop */}
          <OpenSwarmThread />
          
          {/* Resume bubble (keep existing) */}
          {showResumeBubble && session.status === 'stopped' && (
            <ResumeButton onClick={handleResume} />
          )}
          
          {/* Approvals area — now using Tool UI components */}
          {session.pending_approvals.length > 1 ? (
            <BatchApproval requests={session.pending_approvals} onApprove={handleApprove} onDeny={handleDeny} />
          ) : (
            session.pending_approvals.map((req) => (
              req.tool_name === 'AskUserQuestion'
                ? <ToolQuestion key={req.id} request={req} onApprove={handleApprove} onDeny={handleDeny} />
                : <ToolApproval key={req.id} request={req} onApprove={handleApprove} onDeny={handleDeny} />
            ))
          )}
          
          {/* Composer replaces ChatInput */}
          {isGlowing ? (
            <GlowCTA onClick={onDismissGlow} />
          ) : (
            <MessageQueue ...>
              <OpenSwarmComposer
                mode={mode}
                onModeChange={handleModeChange}
                model={model}
                onModelChange={handleModelChange}
                isRunning={agentBusy}
                onStop={handleStop}
                contextEstimate={contextEstimate}
                sessionId={id}
                autoFocus={autoFocus}
              />
            </MessageQueue>
          )}
        </Box>
      </Box>
    </AssistantRuntimeProvider>
  );
};
```

### 2. Register the toolkit

Check how assistant-ui registers the toolkit. It may be via:
- `Tools` component or `useAui` hook (check current docs)
- Props on `AssistantRuntimeProvider`
- A separate context provider

Use `assistantUIDocs` to look up:
- `copilots/model-context` — how to provide tools/toolkit
- `guides/tool-ui` — how toolkit is registered

Make sure ALL toolkit entries (native + approvals + MCP + custom) are registered so tool calls render correctly.

### 3. Clean up useAgentChat hook

The `useAgentChat` hook (`hooks/useAgentChat.ts`) currently manages:
- Session state and WebSocket lifecycle (KEEP)
- Scroll container ref + scroll handlers (REMOVE — Thread handles scroll)
- `handleSend` (KEEP — still used by runtime adapter or Composer)
- Approval handlers (KEEP)
- Stop/resume handlers (KEEP)

Remove the scroll-related code:
- `scrollContainerRef` — Thread manages its own scroll
- `showScrollButton` — Thread has built-in scroll-to-bottom
- `handleScroll`, `scrollToBottom` — Thread handles these

Also remove `chatInputRef` if the Composer no longer uses it (replaced by ComposerRuntime API).

### 4. Migrate SkillBuilderChat

Read `frontend/src/app/pages/Skills/SkillBuilderChat.tsx` (403 lines).

It embeds `AgentChat` in `embedded` mode:
```tsx
<AgentChat
  sessionId={draftSessionId}
  embedded
  autoFocus
  initialContextPaths={...}
/>
```

Since `AgentChat` is being rewritten with assistant-ui, `SkillBuilderChat` should work as-is **if** the `embedded` prop behavior is preserved. Verify:
- `embedded` hides the `ChatHeader`
- The Composer still renders in embedded mode
- The Thread fills the available space

If `SkillBuilderChat` used `ChatInputHandle` ref to programmatically set content:
- Check if Agent 3 created a `useComposerHandle` hook
- Update `SkillBuilderChat` to use the new API (ComposerRuntime's `setText()`)

### 5. Delete all remaining dead files

After integration, these files should no longer be imported anywhere:

**Already deleted by Phase 2 agents** (verify they're gone):
- Agent 2: `MessageBubble`, `UserBubbleContent`, `AssistantBubbleContent`, `MessageActionBar`, `BranchNavigator`, `ThinkingBubble`, `MessageImageThumbnails`, `messageBubbleUtils`, `useMessageRendering`
- Agent 3: `ChatInput`, `useChatSubmit`, `CommandPicker`, `commandPickerTypes`, `useCommandPickerItems`, `CommandPickerIcons`, `SlashCommandPicker`, `AttachmentChips`, `ImageAttachments`
- Agent 4: `ToolCallBubble`, `toolCallColors`, `ElapsedTimer`, `ToolGroupBubble`
- Agent 5: `ApprovalBar`, `BatchApprovalBar`, `QuestionForm`, `ToolPreview`, `approvalUtils`
- Agent 6: `GmailCard`, `McpServiceCards`, `BrowserAgentInlineFeed`, `BrowserFeedEntryRow`, `browserFeedUtils`, `DiffViewer`

**Files that may have been left due to shared imports** — delete now if no longer needed:
- `toolCallUtils.ts` — functions may have been ported to toolkit files
- `richEditorUtils.ts` — functions may have been moved to RichPromptEditor
- `AttachedContextSection.tsx` — check if Thread's UserMessage uses it

Run a grep/search for any remaining imports of deleted files. Fix any broken imports.

### 6. Remove unused npm packages

After the migration, some packages may no longer be needed:
- `react-markdown` — if assistant-ui's Markdown component replaces all usage. **Check**: `RichPromptEditor` or other non-chat pages may still use it.
- `remark-gfm` — same as above

Only remove if truly unused across the entire codebase.

### 7. Clean up agentsSlice streaming reducers

The `streamStart`, `streamDelta`, `streamEnd` reducers in the agents Redux slice may be simplified since the ExternalStoreRuntime adapter handles streaming display state. However, keep them if:
- The WebSocketManager still dispatches them
- The runtime adapter reads `session.streamingMessage` from Redux

Don't remove them if removing would break the data flow. Just leave them — they're small.

### 8. Verify the build

```bash
cd frontend
npm run build
```

Fix any TypeScript errors, missing imports, or broken references.

### 9. Manual smoke test

Start the dev server and verify:
- [ ] Chat page loads
- [ ] Existing sessions show their message history
- [ ] Can type in the Composer and send a message
- [ ] `@` trigger opens the mention popover with categories
- [ ] `/` trigger opens command categories (templates, skills, modes)
- [ ] Streaming responses animate token-by-token
- [ ] Tool calls render with Terminal/CodeBlock/CodeDiff components
- [ ] MCP tool results render (Gmail, Calendar, Drive)
- [ ] Approval requests show ApprovalCard
- [ ] AskUserQuestion shows OptionList/QuestionFlow
- [ ] Branch navigation works
- [ ] Copy/edit/regenerate actions work
- [ ] Scroll-to-bottom works
- [ ] SkillBuilderChat works in embedded mode
- [ ] Dashboard page still works (no regressions)
- [ ] Settings/Modes/Templates pages still work

## Files Modified

| File | Change |
|------|--------|
| `AgentChat.tsx` | Rewritten to use assistant-ui Thread + Composer + toolkit |
| `hooks/useAgentChat.ts` | Removed scroll-related code |
| `SkillBuilderChat.tsx` | Updated to work with new AgentChat (if needed) |

## Files Deleted (remaining dead code)

| File | Reason |
|------|--------|
| `toolCallUtils.ts` | Functions ported to toolkit files |
| `richEditorUtils.ts` | Functions moved to RichPromptEditor (if still needed) |
| `AttachedContextSection.tsx` | Context rendering moved to UserMessage in Thread |
| Any other orphaned files | Verify with import search |

## Verification Checklist

- [ ] `npm run build` succeeds with no errors
- [ ] `npm run dev` starts the dev server
- [ ] Chat page renders with assistant-ui Thread
- [ ] Messages display correctly (user + assistant)
- [ ] Tool calls render with Tool UI components
- [ ] Approvals render with ApprovalCard
- [ ] Questions render with OptionList/QuestionFlow
- [ ] Composer works with Mention popover
- [ ] Streaming works
- [ ] Branching works
- [ ] SkillBuilderChat works
- [ ] No console errors
- [ ] No broken imports (grep for imports of deleted files)
- [ ] Non-chat pages (Dashboard, Settings, Modes, Templates, Tools, Views) still work
