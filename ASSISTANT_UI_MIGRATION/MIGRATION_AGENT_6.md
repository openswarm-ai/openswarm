# Migration Agent 6: Tool Toolkit — MCP Services, Browser Feed & Custom Tools

## Objective

Register Tool UI components for MCP service results (`MessageDraft` for Gmail, `DataTable`/`ItemCarousel` for Calendar/Drive, `ProgressTracker` for browser feed). Wire existing `AgentToolBubble` (sub-agent rendering) and `ViewBubble` (iframe previews) into the toolkit as custom entries. Replace `GmailCard`, `McpServiceCards`, `BrowserAgentInlineFeed`, `BrowserFeedEntryRow`, `browserFeedUtils`, and `DiffViewer`.

## Prerequisites

- **Agent 1 must be complete.** Tool UI components must be installed in `src/components/tool-ui/`, and the toolkit skeleton must exist at `toolkit/mcp-tools.tsx` and `toolkit/custom-tools.tsx`.

## Constraints

- **No custom styling**: Use default Tool UI appearance for MessageDraft, DataTable, ProgressTracker.
- **Only modify `toolkit/mcp-tools.tsx` and `toolkit/custom-tools.tsx`**. Do NOT modify `AgentChat.tsx`, `thread/`, `composer/`, or other toolkit files.
- **Keep `AgentToolBubble.tsx` and `ViewBubble.tsx` as-is** — just wire them into the custom toolkit as renderers. Do not rewrite them.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`.

## Key Files to Read First

Understand what you're replacing:
- `frontend/src/app/pages/AgentChat/McpServiceCards.tsx` — dispatches to Gmail/Calendar/Drive/Generic cards (158 lines)
- `frontend/src/app/pages/AgentChat/GmailCard.tsx` — email list/detail rendering (136 lines)
- `frontend/src/app/pages/AgentChat/BrowserAgentInlineFeed.tsx` — browser automation feed (164 lines)
- `frontend/src/app/pages/AgentChat/BrowserFeedEntryRow.tsx` — feed entry rendering (120 lines)
- `frontend/src/app/pages/AgentChat/browserFeedUtils.ts` — browser feed utilities (129 lines)
- `frontend/src/app/pages/AgentChat/DiffViewer.tsx` — git diff panel (140 lines)

Understand what you're keeping and wiring:
- `frontend/src/app/pages/AgentChat/AgentToolBubble.tsx` — InvokeAgent/CreateAgent (193 lines) — KEEP
- `frontend/src/app/pages/AgentChat/ViewBubble.tsx` — iframe app preview (194 lines) — KEEP
- `frontend/src/app/pages/AgentChat/ViewBubbleParts.tsx` — iframe parts (136 lines) — KEEP

Also read the installed Tool UI schemas:
- `src/components/tool-ui/message-draft/schema.ts`
- `src/components/tool-ui/data-table/schema.ts`
- `src/components/tool-ui/progress-tracker/schema.ts`
- `src/components/tool-ui/item-carousel/schema.ts` (if installed)

## Background: How MCP Tool Results Work

MCP tools have names like `mcp__google-gmail__search`, `mcp__google-calendar__listEvents`, `mcp__google-drive__listFiles`. The existing `parseMcpToolName()` function (in `toolCallUtils.ts`) parses these into:
```typescript
{
  isMcp: true,
  serverSlug: 'google-gmail',
  service: 'gmail',
  actionName: 'search',
  displayName: 'Search',
}
```

The `McpResultCard` component dispatches based on `service`:
- `gmail` → `GmailCard`
- `calendar` → `CalendarCard`
- `drive` / `sheets` → `DriveCard`
- anything else → `GenericMcpCard`

## Step-by-Step

### 1. Read Tool UI component schemas

Read the installed schemas:
- `src/components/tool-ui/message-draft/schema.ts` — email/message rendering
- `src/components/tool-ui/data-table/schema.ts` — table rendering
- `src/components/tool-ui/progress-tracker/schema.ts` — step-by-step progress

### 2. Implement mcp-tools.tsx — Gmail → MessageDraft

The `GmailCard` renders:
- **Email list**: Multiple email cards with subject, from, date, snippet
- **Single email**: Subject header, from/to/date fields, labels, body (markdown), attachments

Map to Tool UI's `MessageDraft`:
```tsx
import { MessageDraft } from '@/components/tool-ui/message-draft';

// For single email results
function renderGmailResult(data: any, action: string) {
  const email = extractEmailFields(data);
  return (
    <MessageDraft
      id={`gmail-${data.id || 'result'}`}
      from={email.from}
      to={email.to}
      subject={email.subject}
      body={email.bodyPreview || email.snippet}
      // MessageDraft may have additional props for sent state, etc.
    />
  );
}
```

For **email list results** (search/list), use `DataTable`:
```tsx
import { DataTable } from '@/components/tool-ui/data-table';

function renderGmailList(messages: any[]) {
  return (
    <DataTable
      id="gmail-list"
      columns={[
        { key: 'from', label: 'From', priority: 'primary' },
        { key: 'subject', label: 'Subject' },
        { key: 'date', label: 'Date', format: { kind: 'date', dateFormat: 'relative' } },
        { key: 'snippet', label: 'Preview', truncate: true },
      ]}
      data={messages.map((msg, i) => ({
        id: String(i),
        ...extractEmailFields(msg),
      }))}
    />
  );
}
```

### 3. Implement mcp-tools.tsx — Calendar → DataTable

The `CalendarCard` renders:
- **Event list**: Cards with summary + date
- **Single event**: Summary, start, end, location, description

Map event lists to `DataTable`:
```tsx
function renderCalendarList(items: any[]) {
  return (
    <DataTable
      id="calendar-list"
      columns={[
        { key: 'summary', label: 'Event', priority: 'primary' },
        { key: 'start', label: 'Start', format: { kind: 'date', dateFormat: 'short' } },
        { key: 'end', label: 'End', format: { kind: 'date', dateFormat: 'short' } },
        { key: 'location', label: 'Location' },
      ]}
      data={items.map((item, i) => ({
        id: String(i),
        summary: item.summary || '(no title)',
        start: item.start?.dateTime || item.start?.date || '',
        end: item.end?.dateTime || item.end?.date || '',
        location: item.location || '',
      }))}
    />
  );
}
```

### 4. Implement mcp-tools.tsx — Drive → DataTable

The `DriveCard` renders file lists with name and mimeType. Map to `DataTable`:
```tsx
function renderDriveFiles(files: any[]) {
  return (
    <DataTable
      id="drive-files"
      columns={[
        { key: 'name', label: 'File', priority: 'primary' },
        { key: 'mimeType', label: 'Type' },
      ]}
      data={files.map((f, i) => ({
        id: String(i),
        name: f.name || f.id,
        mimeType: f.mimeType?.split('/').pop() || '',
      }))}
    />
  );
}
```

### 5. Implement mcp-tools.tsx — Generic MCP fallback

For MCP tools without a specific handler, render a simple key-value display. Use `DataTable` with two columns (key, value) or create a minimal fallback component.

### 6. Register MCP tool renderers in the toolkit

The challenge: MCP tool names are dynamic (`mcp__<server>__<action>`). You can't register every possible tool name in the toolkit.

**Solution**: Use a catch-all pattern. Check if assistant-ui supports a `ToolFallback` component or a wildcard toolkit entry. Look up `ui/tool-fallback` in the docs.

If the toolkit supports a fallback/default renderer:
```tsx
export const mcpToolkit = {
  // Specific MCP tools can be registered by name if desired
  // Generic fallback handles all MCP tools
  __fallback__: {
    type: "backend",
    render: ({ result, args, toolName }) => {
      const mcpInfo = parseMcpToolName(toolName);
      if (!mcpInfo.isMcp) return null; // Let other handlers deal with it
      
      switch (mcpInfo.service) {
        case 'gmail': return renderGmailResult(result, mcpInfo.actionName);
        case 'calendar': return renderCalendarResult(result, mcpInfo.actionName);
        case 'drive': return renderDriveResult(result);
        default: return renderGenericMcp(result);
      }
    },
  },
};
```

If assistant-ui doesn't support a fallback, register a `ToolFallback` component that checks if the tool name starts with `mcp__` and routes accordingly.

### 7. Implement mcp-tools.tsx — Browser Feed → ProgressTracker

The `BrowserAgentInlineFeed` renders a compact activity log of browser automation steps (navigate, click, type, screenshot) with status indicators.

Map to `ProgressTracker`:
```tsx
import { ProgressTracker } from '@/components/tool-ui/progress-tracker';

function renderBrowserFeed(entries: BrowserFeedEntry[]) {
  return (
    <ProgressTracker
      id="browser-feed"
      steps={entries.map(entry => ({
        id: entry.id,
        label: entry.action, // "navigate", "click", "type"
        description: entry.detail, // URL, selector, text
        status: entry.status === 'done' ? 'completed' 
             : entry.status === 'error' ? 'failed' 
             : entry.status === 'running' ? 'in-progress' 
             : 'pending',
      }))}
    />
  );
}
```

The browser feed data comes from Redux (via `useBrowserActivity` or similar). The renderer needs to read this data. Since it's rendered inside a tool call bubble (for `BrowserAgent` tool), the data should be accessible from the tool result or via Redux selector.

### 8. Implement mcp-tools.tsx — DiffViewer → CodeDiff

The `DiffViewer.tsx` fetches a git worktree diff from the API and renders colorized diff output. Replace with Tool UI's `CodeDiff`:

```tsx
import { CodeDiff } from '@/components/tool-ui/code-diff';

// DiffViewer fetches diff text from /api/agents/sessions/{id}/worktree-diff
// This is rendered as a side panel, not a tool call result.
// It may need to stay as a standalone component, just using CodeDiff internally.
```

**Note**: DiffViewer is rendered in `ChatHeader`, not as a tool call. It may not fit the toolkit pattern. Two options:
- Replace the rendering logic inside DiffViewer to use `CodeDiff` component but keep the wrapper
- Or just replace the internals

Go with replacing the internals: keep a thin wrapper that fetches the diff and passes it to `CodeDiff`.

### 9. Implement custom-tools.tsx — Wire AgentToolBubble and ViewBubble

These are kept as-is but registered in the toolkit so assistant-ui knows how to render them:

```tsx
import { InvokeAgentBubble, CreateAgentBubble } from '../AgentToolBubble';
import ViewBubble from '../ViewBubble';

export const customToolkit = {
  InvokeAgent: {
    type: "backend",
    render: ({ result, args, toolCallId }) => (
      <InvokeAgentBubble
        call={{ id: toolCallId, content: { tool: 'InvokeAgent', input: args }, ... }}
        result={result ? { content: result } : null}
        isPending={!result}
        isStreaming={false}
      />
    ),
  },
  CreateAgent: {
    type: "backend",
    render: ({ result, args, toolCallId }) => (
      <CreateAgentBubble
        call={{ id: toolCallId, content: { tool: 'CreateAgent', input: args }, ... }}
        result={result ? { content: result } : null}
        isPending={!result}
        isStreaming={false}
      />
    ),
  },
  RenderOutput: {
    type: "backend",
    render: ({ result, args, toolCallId }) => (
      <ViewBubble
        call={{ id: toolCallId, content: { tool: 'RenderOutput', input: args }, ... }}
        result={result ? { content: result } : null}
        isPending={!result}
        isStreaming={false}
      />
    ),
  },
};
```

Adapt the props to match what `AgentToolBubble` and `ViewBubble` expect. Read those files to understand their prop interfaces.

### 10. Port `parseMcpToolName` and `extractEmailFields`

These utility functions are needed by the MCP toolkit. Port them into `mcp-tools.tsx` or a local helper file. Keep them minimal — only port what you need.

## Files Created / Modified

| File | Action | Description |
|------|--------|-------------|
| `toolkit/mcp-tools.tsx` | **Fill in** (was stub) | Gmail, Calendar, Drive, Generic MCP, Browser feed, DiffViewer renderers |
| `toolkit/custom-tools.tsx` | **Fill in** (was stub) | AgentToolBubble, ViewBubble wrappers |

## Files Deleted (by this agent)

| File | Lines | Replaced By |
|------|-------|------------|
| `GmailCard.tsx` | 136 | MessageDraft + DataTable in `mcp-tools.tsx` |
| `McpServiceCards.tsx` | 158 | Routing logic in `mcp-tools.tsx` |
| `BrowserAgentInlineFeed.tsx` | 164 | ProgressTracker in `mcp-tools.tsx` |
| `BrowserFeedEntryRow.tsx` | 120 | ProgressTracker step rendering |
| `browserFeedUtils.ts` | 129 | Simplified in `mcp-tools.tsx` |
| `DiffViewer.tsx` | 140 | CodeDiff (keep thin wrapper if needed for API fetch) |

**Important**: `DiffViewer` is rendered in `ChatHeader.tsx`, not as a tool call. Before deleting, check how it's used. If it's a side panel that fetches from an API, you may want to keep a thin wrapper that uses `CodeDiff` internally rather than fully deleting it.

**Total deleted: ~847 lines**

## Files Kept (wired as custom toolkit entries)

| File | Lines | Action |
|------|-------|--------|
| `AgentToolBubble.tsx` | 193 | Kept, registered in `custom-tools.tsx` |
| `ViewBubble.tsx` | 194 | Kept, registered in `custom-tools.tsx` |
| `ViewBubbleParts.tsx` | 136 | Kept (dependency of ViewBubble) |

## Files NOT Modified

- `AgentChat.tsx` — Agent 7 handles integration
- `thread/`, `composer/` — owned by Agents 2 and 3
- Other toolkit files — owned by Agents 4 and 5

## Verification Checklist

- [ ] `toolkit/mcp-tools.tsx` exports `mcpToolkit` with MCP tool renderers
- [ ] Gmail email results render as `MessageDraft` (single) or `DataTable` (list)
- [ ] Calendar events render as `DataTable`
- [ ] Drive files render as `DataTable`
- [ ] Unknown MCP tools render a generic key-value fallback
- [ ] Browser agent activity renders as `ProgressTracker` steps
- [ ] `toolkit/custom-tools.tsx` exports `customToolkit` with `InvokeAgent`, `CreateAgent`, `RenderOutput`
- [ ] `AgentToolBubble` and `ViewBubble` render correctly through the toolkit
- [ ] DiffViewer rendering uses `CodeDiff` internally
- [ ] No TypeScript errors
- [ ] Deleted files don't break other imports
