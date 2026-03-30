# Migration Agent 2: Thread & Message Rendering

## Objective

Replace the custom message list, scroll viewport, message bubbles, action bar, branch picker, thinking indicator, and image rendering with assistant-ui's `Thread`, `Message`, `ActionBar`, `BranchPicker`, and `Reasoning` primitives.

## Prerequisites

- **Agent 1 must be complete.** The ExternalStoreRuntime adapter, toolkit skeleton, and `AssistantRuntimeProvider` wrapper must exist.

## Constraints

- **No custom styling**: Use default assistant-ui appearance. Do not add CSS to match MUI theme.
- **Only modify files in the `thread/` directory** and the files listed under "Files Deleted." Do NOT modify `AgentChat.tsx`, `toolkit/`, `composer/`, or any file owned by another agent.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`. Use `assistantUIDocs` and `assistantUIExamples` tools to look up current API docs.

## Key Files to Read First

Understand what you're replacing:
- `frontend/src/app/pages/AgentChat/useMessageRendering.ts` — branch resolution, render items
- `frontend/src/app/pages/AgentChat/MessageBubble.tsx` — routes to User/Assistant bubbles
- `frontend/src/app/pages/AgentChat/UserBubbleContent.tsx` — user message with context pills, images, editing
- `frontend/src/app/pages/AgentChat/AssistantBubbleContent.tsx` — markdown rendering
- `frontend/src/app/pages/AgentChat/MessageActionBar.tsx` — copy/edit/regenerate/branch actions
- `frontend/src/app/pages/AgentChat/BranchNavigator.tsx` — branch picker arrows
- `frontend/src/app/pages/AgentChat/ThinkingBubble.tsx` — thinking/reasoning display
- `frontend/src/app/pages/AgentChat/MessageImageThumbnails.tsx` — image display in messages
- `frontend/src/app/pages/AgentChat/AttachedContextSection.tsx` — context pills in user messages

## Step-by-Step

### 1. Look up assistant-ui docs

Use the `assistantUIDocs` MCP tool to read these pages:
- `primitives/thread` — Thread primitives (viewport, messages, scroll)
- `primitives/message` — Message primitives (root, content, parts)
- `primitives/action-bar` — ActionBar primitives (copy, edit, reload, speak)
- `primitives/branch-picker` — BranchPicker primitives (prev/next/count)
- `ui/thread` — Pre-built Thread component
- `ui/markdown` — Markdown component
- `ui/reasoning` — Reasoning/thinking UI
- `guides/branching` — How branching works

### 2. Build OpenSwarmThread

Create `frontend/src/app/pages/AgentChat/thread/OpenSwarmThread.tsx`.

This is the main thread component that replaces the scroll container + message render loop in `AgentChat.tsx`. It should:

1. Use `ThreadPrimitive.Root` and `ThreadPrimitive.Viewport` for the scrollable container with auto-scroll
2. Use `ThreadPrimitive.Messages` to render the message list
3. Provide custom `UserMessage` and `AssistantMessage` components

```tsx
import { ThreadPrimitive } from '@assistant-ui/react';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

export const OpenSwarmThread = () => {
  return (
    <ThreadPrimitive.Root>
      <ThreadPrimitive.Viewport>
        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage }}
        />
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom />
    </ThreadPrimitive.Root>
  );
};
```

### 3. Build UserMessage component

Create `thread/UserMessage.tsx`.

This replaces `UserBubbleContent.tsx`. It should:
- Use `MessagePrimitive.Root` and `MessagePrimitive.Content`
- Render user text content
- Render attached context paths (files, directories) as chips/badges
- Render attached images using `MessagePrimitive.Attachments` or custom rendering
- Support inline editing via `MessagePrimitive.EditComposer` (or however assistant-ui handles edit)
- Show the `ActionBar` (copy, edit) on hover

For context pills and attached skills, read the existing `AttachedContextSection.tsx` and `UserBubbleContent.tsx` to understand the data shape. These are in `message.context_paths` and `message.attached_skills`.

Note: The ExternalStoreRuntime adapter (from Agent 1) should include these in the converted message format. If they're not accessible via assistant-ui's message API, render them by reading from Redux directly using the message ID.

### 4. Build AssistantMessage component

Create `thread/AssistantMessage.tsx`.

This replaces `AssistantBubbleContent.tsx`. It should:
- Use `MessagePrimitive.Root` and `MessagePrimitive.Content`
- Render markdown content using assistant-ui's `MarkdownText` or `@assistant-ui/react-markdown`
- Render tool calls inline (assistant-ui handles this automatically when tools are registered in the toolkit)
- Show the `ActionBar` (copy, regenerate, branch) on hover
- Show the `BranchPicker` when the message has sibling branches

Use assistant-ui's `makeMarkdownText` or the `Markdown` component from `@assistant-ui/react-markdown`. Look up the current API in the docs.

### 5. Build ActionBar

Create `thread/MessageActions.tsx` (or inline in UserMessage/AssistantMessage).

This replaces `MessageActionBar.tsx`. Use assistant-ui's `ActionBarPrimitive`:
- `ActionBarPrimitive.Copy` — copy message text
- `ActionBarPrimitive.Edit` — edit user message
- `ActionBarPrimitive.Reload` — regenerate assistant message (maps to your "Regenerate" button)

For the "Branch chat" action, this is custom. Use a custom button inside the ActionBar that calls the existing `duplicateSession` thunk. You can use `useMessage` hook to get the current message context.

### 6. Build BranchPicker

Create `thread/BranchPicker.tsx` (or inline in AssistantMessage).

This replaces `BranchNavigator.tsx`. Use assistant-ui's `BranchPickerPrimitive`:
- `BranchPickerPrimitive.Previous`
- `BranchPickerPrimitive.Number` / `BranchPickerPrimitive.Count`
- `BranchPickerPrimitive.Next`

The ExternalStoreRuntime adapter (Agent 1) should expose branch data. If not, this may need coordination with Agent 1's runtime adapter to ensure branches are surfaced correctly.

### 7. Handle thinking/reasoning display

Create `thread/ThinkingIndicator.tsx` (or use assistant-ui's built-in).

This replaces `ThinkingBubble.tsx`. Check if assistant-ui's `Thread` automatically shows a loading indicator when `isRunning` is true. If so, the default behavior may be sufficient. If a custom thinking bubble is needed, use assistant-ui's reasoning or chain-of-thought UI.

### 8. Handle streaming messages

The ExternalStoreRuntime adapter should handle streaming state. When `session.streamingMessage` exists in Redux, the runtime should surface it as a message with `status: 'in_progress'`. assistant-ui will automatically animate streaming text.

Verify that the streaming cursor / token animation works correctly with the runtime adapter from Agent 1.

## Files Created

| File | Description |
|------|-------------|
| `thread/OpenSwarmThread.tsx` | Main thread component (replaces scroll container + message loop) |
| `thread/UserMessage.tsx` | User message rendering |
| `thread/AssistantMessage.tsx` | Assistant message with markdown, tool calls |
| `thread/MessageActions.tsx` | Action bar (copy, edit, regenerate, branch) |
| `thread/BranchPicker.tsx` | Branch navigation |
| `thread/ThinkingIndicator.tsx` | Thinking/loading state (if needed beyond defaults) |

All files go in `frontend/src/app/pages/AgentChat/thread/`.

## Files Deleted (by this agent)

These files are replaced by the new thread components. Delete them:

| File | Lines | Replaced By |
|------|-------|------------|
| `MessageBubble.tsx` | 99 | `UserMessage.tsx` + `AssistantMessage.tsx` |
| `UserBubbleContent.tsx` | 152 | `UserMessage.tsx` |
| `AssistantBubbleContent.tsx` | 128 | `AssistantMessage.tsx` |
| `MessageActionBar.tsx` | 153 | `MessageActions.tsx` |
| `BranchNavigator.tsx` | 60 | `BranchPicker.tsx` |
| `ThinkingBubble.tsx` | 55 | `ThinkingIndicator.tsx` or built-in |
| `MessageImageThumbnails.tsx` | 108 | Handled in `UserMessage.tsx` via Attachment primitives |
| `messageBubbleUtils.ts` | 54 | No longer needed |
| `useMessageRendering.ts` | 196 | Thread handles message list rendering |

**Total deleted: ~1,005 lines**

## Files NOT Modified

- `AgentChat.tsx` — Agent 7 wires in `OpenSwarmThread`
- Anything in `composer/`, `toolkit/`, or shared state

## Verification Checklist

- [ ] `OpenSwarmThread` renders a scrollable message list
- [ ] User messages display text content
- [ ] Assistant messages render markdown correctly
- [ ] Tool call messages are rendered (even if just as fallback text — toolkit fills in later)
- [ ] ActionBar shows copy/edit/regenerate on hover
- [ ] BranchPicker shows navigation when branches exist
- [ ] Streaming messages animate token-by-token
- [ ] Auto-scroll to bottom works on new messages
- [ ] Scroll-to-bottom button appears when scrolled up
- [ ] No TypeScript errors
- [ ] All deleted files are removed
