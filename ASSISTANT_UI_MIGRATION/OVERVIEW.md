# assistant-ui + Tool UI Migration Plan

## Goal

Replace the custom chat UI in `frontend/src/app/pages/AgentChat/` with [assistant-ui](https://www.assistant-ui.com/) (React chat primitives) and [Tool UI](https://www.tool-ui.com/) (tool call rendering components). This replaces ~5,800 lines of custom chat code with maintained, accessible, schema-driven components.

## Decisions

- **Tailwind + MUI coexist**: Tailwind is added for assistant-ui/Tool UI; MUI stays for non-chat pages (Dashboard, Settings, etc.)
- **Clean swap**: No feature flag — old code is replaced directly
- **No custom styling**: Use default assistant-ui/Tool UI appearance as-is (no theming to match MUI)
- **SkillBuilderChat**: Included in migration
- **Sub-agent rendering**: Kept as-is, wired into toolkit as custom tool UIs

## Architecture: Before → After

### Before
```
AgentChat.tsx
├── useAgentChat.ts (WS lifecycle, session state)
├── useMessageRendering.ts (branch resolution, render items)
├── ChatInput.tsx + CommandPicker (custom contentEditable + @/slash picker)
├── MessageBubble → UserBubbleContent / AssistantBubbleContent (custom markdown)
├── MessageActionBar (copy/edit/regen/branch)
├── BranchNavigator (custom branch picker)
├── ToolCallBubble + toolCallColors + toolCallUtils (custom terminal rendering)
├── ToolGroupBubble (custom accordion)
├── ApprovalBar / BatchApprovalBar / QuestionForm (custom HITL)
├── GmailCard / McpServiceCards (custom MCP rendering)
├── BrowserAgentInlineFeed (custom progress feed)
├── DiffViewer (custom diff rendering)
└── ThinkingBubble (custom reasoning display)
```

### After
```
AgentChat.tsx
├── AssistantRuntimeProvider + ExternalStoreRuntime (bridges Redux + WS)
├── OpenSwarmThread (assistant-ui Thread + Message + ActionBar + BranchPicker)
├── OpenSwarmComposer (assistant-ui Composer + ComposerMentionPopover)
├── Toolkit registry
│   ├── native-tools.tsx → Tool UI Terminal, CodeBlock, CodeDiff
│   ├── approval-tools.tsx → Tool UI ApprovalCard, QuestionFlow, OptionList
│   ├── mcp-tools.tsx → Tool UI MessageDraft, DataTable, ProgressTracker
│   └── custom-tools.tsx → AgentToolBubble, ViewBubble (kept as-is)
├── ModelModeSelector (kept, MUI)
├── MessageQueue (kept, MUI)
└── ChatHeader (kept, MUI)
```

## Phases & Dependency Graph

```
┌─────────────────────────────────────┐
│  PHASE 1 — Sequential (blocking)   │
│  Agent 1: Foundation & Packages     │
└──────────────┬──────────────────────┘
               │
     ┌─────────┼──────────┬──────────────┬──────────────┐
     │         │          │              │              │
     ▼         ▼          ▼              ▼              ▼
┌─────────┐┌─────────┐┌──────────┐┌──────────┐┌──────────────┐
│ Agent 2 ││ Agent 3 ││ Agent 4  ││ Agent 5  ││   Agent 6    │
│ Thread  ││Composer ││ Tool UI: ││ Tool UI: ││  Tool UI:    │
│   &     ││   &     ││ Native   ││Approvals ││  MCP Cards   │
│Messages ││Mentions ││  Tools   ││   &      ││  & Browser   │
│         ││         ││          ││Questions ││    Feed      │
└────┬────┘└────┬────┘└────┬─────┘└────┬─────┘└──────┬───────┘
     │         │          │            │             │
     │    PHASE 2 — All 5 agents run in parallel     │
     │         │          │            │             │
     └─────────┴──────────┴────────────┴─────────────┘
                           │
               ┌───────────▼───────────────┐
               │  PHASE 3 — Sequential     │
               │  Agent 7: Integration,    │
               │  SkillBuilderChat &       │
               │  Cleanup                  │
               └───────────────────────────┘
```

## Agent Summary

| Agent | Plan File | Phase | What It Does |
|-------|-----------|-------|-------------|
| 1 | `MIGRATION_AGENT_1.md` | 1 (sequential) | Install Tailwind, shadcn, assistant-ui, Tool UI packages. Create ExternalStoreRuntime adapter, toolkit skeleton, new directory structure. Scaffold `AgentChat.tsx` with provider wrapper. |
| 2 | `MIGRATION_AGENT_2.md` | 2 (parallel) | Replace message list with `Thread`. Replace bubbles with `Message` primitives. Replace `MessageActionBar` → `ActionBar`, `BranchNavigator` → `BranchPicker`, `ThinkingBubble` → `Reasoning`. |
| 3 | `MIGRATION_AGENT_3.md` | 2 (parallel) | Replace `ChatInput` + `CommandPicker` with `Composer` + `ComposerMentionPopover`. Create `MentionAdapter` for templates/skills/modes/tools/files. |
| 4 | `MIGRATION_AGENT_4.md` | 2 (parallel) | Register Tool UI components for native tools: `Terminal` (bash), `CodeBlock` (file read), `CodeDiff` (edit/diff). Replace `ToolCallBubble`, `toolCallColors`, `toolCallUtils`. |
| 5 | `MIGRATION_AGENT_5.md` | 2 (parallel) | Register Tool UI components for approvals: `ApprovalCard`, `QuestionFlow`, `OptionList`. Replace `ApprovalBar`, `BatchApprovalBar`, `QuestionForm`, `ToolPreview`. |
| 6 | `MIGRATION_AGENT_6.md` | 2 (parallel) | Register Tool UI for MCP services: `MessageDraft` (Gmail), `DataTable` (Calendar/Drive), `ProgressTracker` (browser feed). Wire `AgentToolBubble` and `ViewBubble` as custom toolkit entries. |
| 7 | `MIGRATION_AGENT_7.md` | 3 (sequential) | Wire all pieces in `AgentChat.tsx`. Migrate `SkillBuilderChat`. Delete all dead files. Verify build. |

## File Ownership (Parallel Safety)

During Phase 2, each agent only touches files it owns. No conflicts.

| Agent | Creates | Modifies | Deletes |
|-------|---------|----------|---------|
| 2 | `thread/` directory | Nothing shared | `MessageBubble`, `UserBubbleContent`, `AssistantBubbleContent`, `MessageActionBar`, `BranchNavigator`, `ThinkingBubble`, `MessageImageThumbnails`, `messageBubbleUtils`, `useMessageRendering` |
| 3 | `composer/` directory | Nothing shared | `ChatInput`, `useChatSubmit`, `CommandPicker`, `commandPickerTypes`, `useCommandPickerItems`, `CommandPickerIcons`, `SlashCommandPicker`, `AttachmentChips`, `ImageAttachments`, `richEditorUtils`, `RichPromptEditor` |
| 4 | `toolkit/native-tools.tsx` | Nothing shared | `ToolCallBubble`, `toolCallColors`, `toolCallUtils`, `ElapsedTimer`, `ToolGroupBubble` |
| 5 | `toolkit/approval-tools.tsx` | Nothing shared | `ApprovalBar`, `BatchApprovalBar`, `QuestionForm`, `ToolPreview`, `approvalUtils` |
| 6 | `toolkit/mcp-tools.tsx`, `toolkit/custom-tools.tsx` | Nothing shared | `GmailCard`, `McpServiceCards`, `BrowserAgentInlineFeed`, `BrowserFeedEntryRow`, `browserFeedUtils`, `DiffViewer` |
| 7 | (integration) | `AgentChat.tsx`, `SkillBuilderChat.tsx` | Remaining dead imports/files |

## Key Technical Notes

### ExternalStoreRuntime Adapter

The runtime adapter (`runtime/useOpenSwarmRuntime.ts`) bridges Redux ↔ assistant-ui:
- **Messages**: Read from `session.messages` + `session.streamingMessage` in Redux
- **isRunning**: Derived from `session.status === 'running'`
- **onNew**: Dispatches `sendMessage` thunk → WebSocket
- **onEdit**: Dispatches `editMessage` thunk → REST API
- **onCancel**: Dispatches `stopAgent` thunk → REST API
- **Branches**: Mapped from `session.branches` + `session.active_branch_id`

### Message Format Conversion

Redux `AgentMessage` → assistant-ui format:
- `role: 'user'` → `{ role: 'user', content: [{ type: 'text', text }] }`
- `role: 'assistant'` → `{ role: 'assistant', content: [{ type: 'text', text }] }`
- `role: 'tool_call'` → `{ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, args }] }`
- `role: 'tool_result'` → `{ role: 'tool', content: [{ type: 'tool-result', toolCallId, result }] }`

### Tailwind + MUI Coexistence

Tailwind is configured with a prefix or scoped to assistant-ui components to avoid conflicts with MUI's global styles. The `important` selector strategy or Tailwind's `prefix` option may be needed.

### Tool UI Registration Pattern

All Tool UI components are registered in toolkit files. Each toolkit file exports a partial `Toolkit` object. The `toolkit/index.ts` merges them:

```typescript
import { nativeToolkit } from './native-tools';
import { approvalToolkit } from './approval-tools';
import { mcpToolkit } from './mcp-tools';
import { customToolkit } from './custom-tools';

export const toolkit: Toolkit = {
  ...nativeToolkit,
  ...approvalToolkit,
  ...mcpToolkit,
  ...customToolkit,
};
```

## Lines of Code Impact (Estimated)

| Category | Lines |
|----------|-------|
| Deleted (old components) | ~5,800 |
| New bridge/adapter code | ~600–800 |
| Tool UI components (installed, not authored) | ~2,000 (maintained externally) |
| **Net reduction in authored code** | **~5,000** |

## Estimated Effort

| Phase | Agents | Estimated Time |
|-------|--------|---------------|
| Phase 1 | Agent 1 | 1–2 hours |
| Phase 2 | Agents 2–6 (parallel) | 2–4 hours each, ~4 hours wall clock |
| Phase 3 | Agent 7 | 1–2 hours |
| **Total wall clock** | | **~6–8 hours** |
