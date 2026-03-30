# Migration Agent 4: Tool Toolkit — Terminal, Code, Diffs

## Objective

Register Tool UI components (`Terminal`, `CodeBlock`, `CodeDiff`) in the toolkit for rendering native tool calls (bash, file read/write, edit, grep, glob, search). Replace `ToolCallBubble`, `toolCallColors`, `toolCallUtils`, `ElapsedTimer`, and `ToolGroupBubble`.

## Prerequisites

- **Agent 1 must be complete.** Tool UI components must be installed in `src/components/tool-ui/`, and the toolkit skeleton must exist at `toolkit/native-tools.tsx`.

## Constraints

- **No custom styling**: Use default Tool UI Terminal/CodeBlock/CodeDiff appearance.
- **Only modify `toolkit/native-tools.tsx`**. Do NOT modify `AgentChat.tsx`, `thread/`, `composer/`, or other toolkit files.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`. Use it for assistant-ui API lookups. For Tool UI docs, refer to the website or read the installed component schemas.

## Key Files to Read First

Understand what you're replacing:
- `frontend/src/app/pages/AgentChat/ToolCallBubble.tsx` — main tool call rendering (173 lines)
- `frontend/src/app/pages/AgentChat/toolCallUtils.ts` — `parseMcpToolName`, `getToolData`, `parseToolResult`, `formatInputDisplay`, etc.
- `frontend/src/app/pages/AgentChat/toolCallColors.tsx` — `colorizeInput`, `colorizeOutput`, terminal color constants
- `frontend/src/app/pages/AgentChat/ElapsedTimer.tsx` — duration timer component
- `frontend/src/app/pages/AgentChat/ToolGroupBubble.tsx` — grouped tool calls accordion

Also read the installed Tool UI component schemas:
- `src/components/tool-ui/terminal/schema.ts` — Terminal props schema
- `src/components/tool-ui/code-block/schema.ts` — CodeBlock props schema
- `src/components/tool-ui/code-diff/schema.ts` — CodeDiff props schema

## Background: How Tool Calls Work in This App

Messages with `role: 'tool_call'` have this content shape:
```typescript
{
  tool: string;        // tool name (e.g. "Bash", "Read", "Edit", "Grep", "mcp__google-gmail__search")
  input: any;          // tool input args (e.g. { command: "ls -la" })
}
```

Messages with `role: 'tool_result'` have:
```typescript
{
  text: string;        // raw result text
  elapsed_ms?: number; // optional duration
}
// OR just a string
```

The `toolCallUtils.ts` file has `parseToolResult()` which parses the result into structured types:
- `{ type: 'bash', stdout, stderr, exitCode }` for Bash tool
- `{ type: 'text', content, isError }` for Read/Grep/etc.
- `{ type: 'mcp', service, action, data }` for MCP tools (handled by Agent 6)

## Step-by-Step

### 1. Read Tool UI component APIs

Read the schema files for each installed component:
- `src/components/tool-ui/terminal/schema.ts`
- `src/components/tool-ui/code-block/schema.ts`
- `src/components/tool-ui/code-diff/schema.ts`

Understand the props each component accepts.

### 2. Understand the toolkit registration pattern

In assistant-ui, tool calls are rendered by registering renderers in a `Toolkit` object. Each key is a tool name, and the value describes how to render it.

Use `assistantUIDocs` to look up:
- `guides/tool-ui` — Generative UI / tool rendering
- `copilots/make-assistant-tool-ui` — `makeAssistantToolUI` API

The toolkit pattern from Tool UI's quick-start:
```tsx
const toolkit: Toolkit = {
  toolName: {
    type: "backend",
    render: ({ result, args }) => {
      // Parse result, return Tool UI component
      return <Terminal {...parsedProps} />;
    },
  },
};
```

### 3. Implement native-tools.tsx

Fill in `frontend/src/app/pages/AgentChat/toolkit/native-tools.tsx`.

Register renderers for each native tool type:

#### Bash → Terminal
```tsx
import { Terminal } from '@/components/tool-ui/terminal';

Bash: {
  type: "backend",
  render: ({ result, args }) => {
    const command = args?.command || '';
    // Parse result: { stdout, stderr, exitCode, elapsed_ms }
    return (
      <Terminal
        id={`bash-${toolCallId}`}
        command={command}
        stdout={parsed.stdout}
        stderr={parsed.stderr}
        exitCode={parsed.exitCode}
        durationMs={parsed.elapsed_ms}
        cwd={args?.working_directory}
      />
    );
  },
}
```

#### Read → CodeBlock
```tsx
import { CodeBlock } from '@/components/tool-ui/code-block';

Read: {
  type: "backend",
  render: ({ result, args }) => {
    const filePath = args?.file_path || args?.path || '';
    const language = guessLanguage(filePath); // from extension
    return (
      <CodeBlock
        id={`read-${toolCallId}`}
        code={resultText}
        language={language}
        filename={filePath}
        lineNumbers="visible"
      />
    );
  },
}
```

#### Edit / Write → CodeDiff
```tsx
import { CodeDiff } from '@/components/tool-ui/code-diff';

Edit: {
  type: "backend",
  render: ({ result, args }) => {
    const filePath = args?.file_path || args?.path || '';
    return (
      <CodeDiff
        id={`edit-${toolCallId}`}
        oldCode={args?.old_string || ''}
        newCode={args?.new_string || ''}
        language={guessLanguage(filePath)}
        filename={filePath}
      />
    );
  },
}
```

#### Grep / Glob / Search → Terminal
These are search commands; display results in Terminal:
```tsx
Grep: {
  type: "backend",
  render: ({ result, args }) => {
    return (
      <Terminal
        id={`grep-${toolCallId}`}
        command={`grep ${args?.pattern || ''}`}
        stdout={resultText}
        exitCode={0}
      />
    );
  },
}
```

### 4. Handle the "input" display

Currently `ToolCallBubble` shows the tool input (command, file path, etc.) in a terminal-style header. With Tool UI's `Terminal`, the `command` prop handles this. For `CodeBlock` and `CodeDiff`, the `filename` prop shows the context.

For tools that don't fit Terminal/CodeBlock/CodeDiff, create a simple fallback renderer that shows the tool name and JSON-formatted args.

### 5. Handle tool groups (ToolGroupBubble replacement)

`ToolGroupBubble` wraps multiple tool calls in a collapsible accordion with a generated SVG icon and completed/pending counters. 

Check if assistant-ui has a `ChainOfThought` or `ToolGroup` primitive:
- Look up `primitives/chain-of-thought` in assistant-ui docs
- Look up `ui/reasoning` for grouping

If assistant-ui provides grouping, use it. If not, create a simple wrapper component that groups consecutive tool calls into a collapsible section. Put this in `toolkit/native-tools.tsx` as a helper.

### 6. Write a `guessLanguage` utility

Create a small utility function that maps file extensions to language names for CodeBlock:
```typescript
function guessLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    html: 'html', css: 'css', scss: 'scss', sh: 'bash', bash: 'bash',
    sql: 'sql', xml: 'xml', toml: 'toml', // ... etc
  };
  return map[ext || ''] || 'text';
}
```

### 7. Handle pending/streaming states

Currently `ToolCallBubble` shows:
- A pulsing cursor when pending
- A blinking cursor when streaming
- An elapsed timer when pending

Tool UI's `Terminal` has built-in support for these states through its props. For pending state without result, you can render `Terminal` without stdout/stderr and it shows as in-progress. Check the exact behavior.

## Files Created / Modified

| File | Action | Description |
|------|--------|-------------|
| `toolkit/native-tools.tsx` | **Fill in** (was stub from Agent 1) | All native tool registrations |

## Files Deleted (by this agent)

| File | Lines | Replaced By |
|------|-------|------------|
| `ToolCallBubble.tsx` | 172 | Toolkit registrations in `native-tools.tsx` |
| `toolCallColors.tsx` | 211 | Tool UI Terminal handles ANSI colors natively |
| `toolCallUtils.ts` | 249 | Simplified parsing in toolkit renderers |
| `ElapsedTimer.tsx` | 41 | Terminal's `durationMs` prop |
| `ToolGroupBubble.tsx` | 200 | ChainOfThought or custom grouping |

**Important**: Before deleting `toolCallUtils.ts`, check if other files import from it:
- `McpServiceCards.tsx` imports `ParsedMcpResult`, `formatTimestamp` — these are owned by Agent 6
- `GmailCard.tsx` imports `getGmailHeader`, `formatTimestamp`, `stripHtml`
- `approvalUtils.tsx` imports `parseMcpToolName`

If other files import from `toolCallUtils.ts`, **do not delete it yet**. Instead, move the functions that only native-tools need into `native-tools.tsx`, and leave `toolCallUtils.ts` for other agents to consume. Agent 7 (Cleanup) will delete it once all consumers are gone.

Similarly for `ToolGroupBubble.tsx` — check if `AgentChat.tsx` imports `isToolGroup`/`isToolPair` from it. If so, coordinate with Agent 7.

**Total deleted: ~873 lines** (depending on shared imports)

## Files NOT Modified

- `AgentChat.tsx` — Agent 7 handles integration
- `thread/`, `composer/` — owned by Agents 2 and 3
- `toolkit/approval-tools.tsx`, `toolkit/mcp-tools.tsx` — owned by Agents 5 and 6

## Verification Checklist

- [ ] `toolkit/native-tools.tsx` exports a `nativeToolkit` object
- [ ] Bash tool calls render as `Terminal` with command, stdout, stderr, exitCode, duration
- [ ] Read tool calls render as `CodeBlock` with syntax highlighting and filename
- [ ] Edit tool calls render as `CodeDiff` with old/new code and filename
- [ ] Grep/Glob/Search tool calls render as `Terminal`
- [ ] Unknown native tools render a sensible fallback
- [ ] No TypeScript errors
- [ ] Deleted files don't break other imports (check before deleting)
