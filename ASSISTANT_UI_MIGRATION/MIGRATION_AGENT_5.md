# Migration Agent 5: Tool Toolkit — Approvals & Questions

## Objective

Register Tool UI components (`ApprovalCard`, `QuestionFlow`, `OptionList`) in the toolkit for rendering HITL approval requests and user questions. Replace `ApprovalBar`, `BatchApprovalBar`, `QuestionForm`, `ToolPreview`, and `approvalUtils`.

## Prerequisites

- **Agent 1 must be complete.** Tool UI components must be installed in `src/components/tool-ui/`, and the toolkit skeleton must exist at `toolkit/approval-tools.tsx`.

## Constraints

- **No custom styling**: Use default Tool UI ApprovalCard/QuestionFlow/OptionList appearance.
- **Only modify `toolkit/approval-tools.tsx`** and create any helpers needed within it. Do NOT modify `AgentChat.tsx`, `thread/`, `composer/`, or other toolkit files.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`. Use it for assistant-ui API lookups.

## Key Files to Read First

Understand what you're replacing:
- `frontend/src/app/pages/AgentChat/ApprovalBar.tsx` — single tool approval (195 lines)
- `frontend/src/app/pages/AgentChat/BatchApprovalBar.tsx` — mass approve/deny (179 lines)
- `frontend/src/app/pages/AgentChat/QuestionForm.tsx` — AskUserQuestion with options/multi-select/free-text (238 lines)
- `frontend/src/app/pages/AgentChat/ToolPreview.tsx` — code preview of bash/read/write/edit/grep args (140 lines)
- `frontend/src/app/pages/AgentChat/approvalUtils.tsx` — MCP tool metadata, integration icons (139 lines)

Also read the installed Tool UI schemas:
- `src/components/tool-ui/approval-card/schema.ts`
- `src/components/tool-ui/question-flow/schema.ts`
- `src/components/tool-ui/option-list/schema.ts`

## Background: How Approvals Work in This App

The backend sends `approval_request` events over WebSocket. These are stored in `session.pending_approvals` in Redux:

```typescript
interface ApprovalRequest {
  id: string;
  session_id: string;
  tool_name: string;       // e.g. "Bash", "mcp__google-gmail__sendEmail"
  tool_input: Record<string, any>;  // the tool args needing approval
  created_at: string;
}
```

The user approves or denies via `handleApprove(requestId, updatedInput?)` or `handleDeny(requestId, message?)` which dispatches to the backend.

Special case: `tool_name === 'AskUserQuestion'` renders a `QuestionForm` instead of an approval bar. The `tool_input` contains:
```typescript
{
  question: string;
  options?: Array<{ id, label, description? }>;
  allow_multiple?: boolean;
  allow_free_text?: boolean;
}
```

The user's response is sent back via `onApprove(requestId, { answer: selectedOptions })`.

## Step-by-Step

### 1. Read Tool UI component schemas

Read the installed schema files to understand each component's props:
- `src/components/tool-ui/approval-card/schema.ts` — `ApprovalCard` props
- `src/components/tool-ui/question-flow/schema.ts` — `QuestionFlow` props
- `src/components/tool-ui/option-list/schema.ts` — `OptionList` props

### 2. Understand the rendering context

Approvals are NOT standard tool call results — they're rendered in a separate area below the message list in `AgentChat.tsx` (lines 199-205). They come from `session.pending_approvals`, not from the message stream.

This means approvals might not fit neatly into the toolkit registration pattern (which is for rendering tool call results inside the message thread). Instead, they may need to be rendered as standalone components in the approval area.

**Two approaches**:

**Approach A — Keep approvals as standalone components**: Create wrapper components in `toolkit/approval-tools.tsx` that use Tool UI's `ApprovalCard`, `QuestionFlow`, and `OptionList` internally. These are rendered in the approval area of `AgentChat.tsx` (Agent 7 wires this in).

**Approach B — Render approvals as tool call parts in the thread**: Map `pending_approvals` to tool messages in the runtime adapter, so they appear inline in the message thread. The toolkit renderers handle them.

Go with **Approach A** — it's simpler and matches the existing UX where approvals appear as a bar between the messages and the composer. The components just change from custom MUI to Tool UI.

### 3. Create approval wrapper components

#### SingleApproval → ApprovalCard

Map from `ApprovalRequest` to `ApprovalCard` props:

```tsx
import { ApprovalCard } from '@/components/tool-ui/approval-card';

export const ToolApproval: React.FC<{
  request: ApprovalRequest;
  onApprove: (id: string) => void;
  onDeny: (id: string, message?: string) => void;
}> = ({ request, onApprove, onDeny }) => {
  const parsedTool = parseMcpToolName(request.tool_name);
  
  return (
    <ApprovalCard
      id={request.id}
      title={parsedTool.isMcp ? parsedTool.displayName : `Run ${request.tool_name}`}
      description={getApprovalDescription(request)}
      metadata={buildMetadata(request.tool_input)}
      variant={isDangerous(request.tool_name) ? 'destructive' : 'default'}
      confirmLabel="Approve"
      cancelLabel="Deny"
      onConfirm={() => onApprove(request.id)}
      onCancel={() => onDeny(request.id)}
    />
  );
};
```

The `metadata` prop accepts key-value pairs, which maps well to showing the tool input args:
```typescript
function buildMetadata(toolInput: Record<string, any>): Array<{ key: string; value: string }> {
  return Object.entries(toolInput)
    .filter(([, v]) => v != null)
    .slice(0, 5)
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value.slice(0, 100) : JSON.stringify(value).slice(0, 100),
    }));
}
```

#### QuestionForm → QuestionFlow + OptionList

When `tool_name === 'AskUserQuestion'`, render a `QuestionFlow` (if multi-step) or `OptionList` (if single question with options):

```tsx
import { OptionList } from '@/components/tool-ui/option-list';
import { QuestionFlow } from '@/components/tool-ui/question-flow';

export const ToolQuestion: React.FC<{
  request: ApprovalRequest;
  onApprove: (id: string, updatedInput?: Record<string, any>) => void;
  onDeny: (id: string) => void;
}> = ({ request, onApprove, onDeny }) => {
  const { question, options, allow_multiple, allow_free_text } = request.tool_input;
  
  if (options?.length > 0) {
    return (
      <OptionList
        id={request.id}
        options={options.map(opt => ({
          id: opt.id || opt.value || opt.label,
          label: opt.label || opt.text,
          description: opt.description,
        }))}
        selectionMode={allow_multiple ? 'multi' : 'single'}
        actions={[
          { id: 'confirm', label: 'Submit' },
          { id: 'cancel', label: 'Skip', variant: 'secondary' },
        ]}
        onAction={(actionId, selection) => {
          if (actionId === 'confirm') {
            onApprove(request.id, { answer: selection });
          } else {
            onDeny(request.id);
          }
        }}
      />
    );
  }
  
  // Free text question without options — render a simple card
  // (or use a text input approach)
};
```

#### BatchApprovalBar → composed ApprovalCards

When `session.pending_approvals.length > 1`, render a batch approval UI. Options:
- Render multiple `ApprovalCard` instances stacked
- Add a "Approve All" / "Deny All" header above them

### 4. Port MCP tool metadata

The existing `approvalUtils.tsx` has `parseMcpToolName()` and `useMcpToolMeta()` that look up MCP tool metadata (integration icons, descriptions) from the Redux store. Port these utility functions into the approval-tools file or a local helper.

**Important**: `parseMcpToolName` is also used by Agent 6 (for MCP service cards) and Agent 4 (in toolCallUtils). If you extract it, put it in a shared location that other agents can access, or duplicate the logic since it's small.

### 5. Handle ToolPreview replacement

`ToolPreview.tsx` renders a preview of tool arguments for native tools (showing the bash command, file path, edit diff, etc.). With Tool UI, this preview is naturally handled by the metadata display in `ApprovalCard`.

For more detailed previews (like showing the full bash command or code diff), you can nest a Tool UI `Terminal` or `CodeBlock` inside the approval area. But for now, the metadata key-value pairs should be sufficient.

## Files Created / Modified

| File | Action | Description |
|------|--------|-------------|
| `toolkit/approval-tools.tsx` | **Fill in** (was stub) | Approval renderers: `ToolApproval`, `ToolQuestion`, batch wrapper |

## Files Deleted (by this agent)

| File | Lines | Replaced By |
|------|-------|------------|
| `ApprovalBar.tsx` | 195 | `ToolApproval` using `ApprovalCard` |
| `BatchApprovalBar.tsx` | 179 | Batch wrapper using composed `ApprovalCard` |
| `QuestionForm.tsx` | 238 | `ToolQuestion` using `OptionList` / `QuestionFlow` |
| `ToolPreview.tsx` | 140 | `ApprovalCard` metadata + optional nested Terminal/CodeBlock |
| `approvalUtils.tsx` | 139 | Utility functions ported to `approval-tools.tsx` |

**Important**: Before deleting `approvalUtils.tsx`, check if other files import `parseMcpToolName` from it. If `ToolCallBubble.tsx` or `McpServiceCards.tsx` imports it, leave the file until Agent 7 cleanup, or extract the shared function.

**Total deleted: ~891 lines**

## Files NOT Modified

- `AgentChat.tsx` — Agent 7 wires the new approval components into the approval area
- `thread/`, `composer/` — owned by Agents 2 and 3
- Other toolkit files — owned by Agents 4 and 6

## Verification Checklist

- [ ] `toolkit/approval-tools.tsx` exports `approvalToolkit` and approval wrapper components
- [ ] `ToolApproval` renders an `ApprovalCard` with title, description, metadata
- [ ] Native tool approvals show tool name and key input args
- [ ] MCP tool approvals show the integration name and action
- [ ] Destructive variant is used for dangerous tools (e.g. Bash with `rm`, `delete`)
- [ ] `ToolQuestion` renders `OptionList` for questions with options
- [ ] Multi-select works for `allow_multiple: true` questions
- [ ] Free-text questions render an input field
- [ ] Approve/Deny callbacks work correctly
- [ ] Batch approval renders multiple cards or a batch wrapper
- [ ] No TypeScript errors
- [ ] Deleted files don't break other imports
