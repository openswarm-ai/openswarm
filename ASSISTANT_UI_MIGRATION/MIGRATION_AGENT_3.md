# Migration Agent 3: Composer & Mention System

## Objective

Replace the custom `ChatInput` (contentEditable + CommandPicker) with assistant-ui's `Composer` primitives and `ComposerMentionPopover` for `@`/`/` trigger-based command picking.

## Prerequisites

- **Agent 1 must be complete.** The `AssistantRuntimeProvider`, runtime adapter, and assistant-ui packages must be installed.

## Constraints

- **No custom styling**: Use default assistant-ui Composer and Mention appearance.
- **Only modify files in the `composer/` directory** and the files listed under "Files Deleted." Do NOT modify `AgentChat.tsx`, `toolkit/`, `thread/`, or any file owned by another agent.
- **Keep `ModelModeSelector.tsx`** as-is — it's MUI and stays. The new Composer should render it in the footer area alongside the send button, similar to how it's currently positioned.
- **Keep `MessageQueue.tsx`** as-is — it wraps the composer.
- **Keep `TemplateInvokeModal.tsx`** as-is — it's triggered when a template is selected.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`. Use `assistantUIDocs` and `assistantUIExamples` tools to look up current API docs.

## Key Files to Read First

Understand what you're replacing:
- `frontend/src/app/pages/AgentChat/ChatInput.tsx` — main composer component
- `frontend/src/app/pages/AgentChat/hooks/useChatSubmit.ts` — send/paste/drop/pick logic
- `frontend/src/app/pages/AgentChat/AttachmentChips.tsx` — context path + tool chips
- `frontend/src/app/pages/AgentChat/ImageAttachments.tsx` — image thumbnails + lightbox
- `frontend/src/app/components/CommandPicker.tsx` — unified `@`/`/` command picker
- `frontend/src/app/components/commandPickerTypes.tsx` — picker types
- `frontend/src/app/components/useCommandPickerItems.tsx` — items for the picker (templates, skills, modes, tools, files)
- `frontend/src/app/components/CommandPickerIcons.tsx` — icons for picker categories
- `frontend/src/app/components/SlashCommandPicker.tsx` — legacy picker
- `frontend/src/app/components/richEditorUtils.ts` — skill pill serialize/deserialize
- `frontend/src/app/components/RichPromptEditor.tsx` — shared rich editor used in mode/template editors

Also read the assistant-ui docs:
- `ui/mention` — ComposerMentionPopover, MentionAdapter, DirectiveText
- `primitives/composer` — Composer primitives (Root, Input, Send, Attachments)
- `primitives/attachment` — Attachment primitives
- `guides/attachments` — Attachment handling

## Step-by-Step

### 1. Look up assistant-ui Mention docs

Use `assistantUIDocs` MCP tool to read:
- `ui/mention` — full Mention API
- `primitives/composer` — Composer primitives

The Mention system provides:
- `ComposerMentionPopover.Root` — wraps the composer, detects `@` trigger
- `ComposerMentionPopover` — the popover UI with categories and keyboard nav
- `LexicalComposerInput` — rich editor with inline mention chips
- Custom `MentionAdapter` — you supply the list of mentionable items

### 2. Create the MentionAdapter

Create `frontend/src/app/pages/AgentChat/composer/OpenSwarmMentionAdapter.ts`.

This replaces `useCommandPickerItems.tsx`. The adapter provides the list of mentionable items for both `@` and `/` triggers.

Read the existing `useCommandPickerItems.tsx` to understand what categories exist:
- **Templates** (triggered by `/`) — from `state.templates.items`
- **Skills** (triggered by `/`) — from `state.skills.items`
- **Modes** (triggered by `/`) — from `state.modes.items`
- **File attach** (triggered by `@`) — opens file browser
- **Web search** (triggered by `@`) — web search context
- **MCP tool groups** (triggered by `@`) — from `state.mcpRegistry`
- **View/app outputs** (triggered by `@`) — from dashboard outputs

The Mention adapter should return these as categories with items. The adapter's `search` function filters items based on the typed query.

Note: The default trigger for assistant-ui Mention is `@`. To support both `@` and `/`, you may need two `ComposerMentionPopover.Root` instances with different `trigger` props, or a single adapter that handles both (check docs for multi-trigger support).

### 3. Build OpenSwarmComposer

Create `frontend/src/app/pages/AgentChat/composer/OpenSwarmComposer.tsx`.

This replaces `ChatInput.tsx`. Structure:

```tsx
import { ComposerPrimitive } from '@assistant-ui/react';
import { ComposerMentionPopover } from '@/components/assistant-ui/composer-mention';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import ModelModeSelector from '../ModelModeSelector';

export const OpenSwarmComposer = ({ mode, onModeChange, model, onModelChange, ...props }) => {
  return (
    <ComposerMentionPopover.Root adapter={openSwarmMentionAdapter}>
      <ComposerPrimitive.Root>
        {/* Attachment display area (images, context paths) */}
        <ComposerPrimitive.Attachments />
        
        {/* Rich text input with inline mention chips */}
        <LexicalComposerInput placeholder="Agent, @ for context, / for commands" />
        
        {/* Mention popover (appears on @ or / trigger) */}
        <ComposerMentionPopover />
        
        {/* Footer: mode/model selector + send button */}
        <ModelModeSelector ... />
        <ComposerPrimitive.Send />
        <ComposerPrimitive.Cancel /> {/* Stop button when running */}
      </ComposerPrimitive.Root>
    </ComposerMentionPopover.Root>
  );
};
```

Key behaviors to implement:
- **Send**: `ComposerPrimitive.Send` calls the runtime's `onNew` which dispatches `sendMessage`
- **Stop**: `ComposerPrimitive.Cancel` calls the runtime's `onCancel` which dispatches `stopAgent`
- **Image paste/drop**: Use `ComposerPrimitive.Attachments` for drag-drop and paste handling. Check assistant-ui's attachment guide.
- **File upload**: When `@file` is selected from the mention popover, trigger the existing file upload flow (POST to `/api/settings/upload-files`)
- **Template selection**: When a template with variables is selected from `/`, open `TemplateInvokeModal`. This requires a callback on mention selection.

### 4. Handle the ChatInputHandle API

The existing `ChatInput` exposes a `ChatInputHandle` ref with `getConfig()` and `setContent()` methods. These are used by:
- `SkillBuilderChat.tsx` — to programmatically set content
- `useAgentChat.ts` — to get config before sending

With assistant-ui, programmatic control goes through the `ComposerRuntime`. Check docs at `api-reference/runtimes/composer-runtime` for `setText()`, `send()`, etc.

Create a wrapper or hook that provides equivalent functionality:
- `getConfig()` → read from composer runtime state
- `setContent()` → use `composerRuntime.setText()`

### 5. Handle attachment rendering in the composer

The current `ChatInput` renders:
- **Image thumbnails** with lightbox and remove buttons (`ImageAttachments.tsx`)
- **Context path chips** with copy-to-clipboard and remove (`AttachmentChips.tsx`)
- **Forced tool chips** (`AttachmentChips.tsx`)
- **UI element selection chips** (`AttachmentChips.tsx`)

With assistant-ui, use `ComposerPrimitive.Attachments` to render attachments. For custom chip types (context paths, forced tools, UI elements), you may need custom rendering inside the Composer area.

### 6. Handle the RichPromptEditor

`RichPromptEditor.tsx` is a shared component used outside the chat (in mode editors, template editors). It has similar `@`/`/` trigger detection and skill pill insertion.

Two options:
- **Option A**: Keep `RichPromptEditor.tsx` as-is for now (it's not in the critical chat path)
- **Option B**: Refactor it to also use `ComposerMentionPopover`

Go with **Option A** — keep it as-is. It's used in Settings/Modes pages, which are out of scope. Just make sure deleting `richEditorUtils.ts` doesn't break it. If it imports from there, extract the needed utilities.

**Important**: Before deleting `richEditorUtils.ts`, check if `RichPromptEditor.tsx` imports from it. If so, either:
- Move the needed functions into `RichPromptEditor.tsx` itself
- Keep `richEditorUtils.ts` but only with the functions `RichPromptEditor` needs

## Files Created

| File | Description |
|------|-------------|
| `composer/OpenSwarmComposer.tsx` | Main composer component |
| `composer/OpenSwarmMentionAdapter.ts` | Mention adapter for templates/skills/modes/tools/files |
| `composer/useComposerHandle.ts` | Hook providing `getConfig`/`setContent` via ComposerRuntime |

All files go in `frontend/src/app/pages/AgentChat/composer/`.

Also install the composer-mention shadcn component if not already present:
```bash
npx shadcn@latest add composer-mention
```

## Files Deleted (by this agent)

| File | Lines | Replaced By |
|------|-------|------------|
| `ChatInput.tsx` | 209 | `OpenSwarmComposer.tsx` |
| `hooks/useChatSubmit.ts` | 248 | Runtime `onNew`/`onEdit`/`onCancel` |
| `AttachmentChips.tsx` | 118 | Mention chips + Composer Attachments |
| `ImageAttachments.tsx` | 85 | Composer Attachment primitives |
| `CommandPicker.tsx` | 230 | `ComposerMentionPopover` |
| `commandPickerTypes.tsx` | 47 | `OpenSwarmMentionAdapter.ts` types |
| `useCommandPickerItems.tsx` | 225 | `OpenSwarmMentionAdapter.ts` |
| `CommandPickerIcons.tsx` | 40 | Category icons in adapter |
| `SlashCommandPicker.tsx` | 165 | `ComposerMentionPopover` |

**About `richEditorUtils.ts` (196 lines)**: Check if `RichPromptEditor.tsx` imports from it. If yes, extract only the functions `RichPromptEditor` needs into that file, then delete `richEditorUtils.ts`. If no imports, delete it entirely.

**Total deleted: ~1,367+ lines**

## Files NOT Modified

- `AgentChat.tsx` — Agent 7 wires in `OpenSwarmComposer`
- `ModelModeSelector.tsx` — kept as-is, rendered inside the new Composer
- `MessageQueue.tsx` — kept as-is, wraps the new Composer
- `TemplateInvokeModal.tsx` — kept as-is, triggered by mention selection
- Anything in `thread/`, `toolkit/`, or shared state

## Verification Checklist

- [ ] `OpenSwarmComposer` renders a text input area
- [ ] Typing `@` opens the mention popover with context categories (files, tools, etc.)
- [ ] Typing `/` opens the mention popover with command categories (templates, skills, modes)
- [ ] Keyboard navigation works (arrows, Enter, Escape)
- [ ] Selected mentions appear as inline chips in the editor
- [ ] Images can be pasted or dragged into the composer
- [ ] Send button calls the runtime's `onNew`
- [ ] Stop button appears when the agent is running and calls `onCancel`
- [ ] `ModelModeSelector` renders in the composer footer
- [ ] No TypeScript errors
- [ ] All deleted files are removed
- [ ] `RichPromptEditor` still works in Modes/Templates pages (if it existed before)
