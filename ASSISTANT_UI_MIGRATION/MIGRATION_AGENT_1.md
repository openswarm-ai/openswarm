# Migration Agent 1: Foundation & Packages

## Objective

Install all required packages, configure Tailwind CSS alongside MUI, set up shadcn/ui, create the ExternalStoreRuntime adapter, create the toolkit skeleton, and scaffold the new directory structure. This agent's output is the foundation that all Phase 2 agents build on.

**This agent must complete before any other agent starts.**

## Constraints

- **No custom styling**: Do not theme assistant-ui or Tool UI components to match MUI. Use their default appearance.
- **Tailwind + MUI coexist**: Tailwind should not break existing MUI styles. Use Tailwind's `prefix` option (e.g., `tw-`) or scope it carefully.
- **Webpack 5**: This project uses Webpack 5 (not Next.js). Tailwind must be configured for Webpack with PostCSS.
- **React 18**: The project uses React 18.2. assistant-ui supports React 18 — check their compatibility docs at `/docs/react-compatibility`.
- **The assistant-ui MCP docs server is available** in `.cursor/mcp.json`. Use `assistantUIDocs` and `assistantUIExamples` tools to look up current API docs.

## Step-by-Step

### 1. Install Tailwind CSS for Webpack 5

```bash
cd frontend
npm install -D tailwindcss @tailwindcss/postcss postcss postcss-loader
```

Create `frontend/postcss.config.js`:
```js
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

Create `frontend/src/styles/tailwind.css`:
```css
@import "tailwindcss";
```

Update `webpack.config.js` to add a CSS rule with PostCSS for `.css` files (not `.module.scss` — those stay as-is):
```js
{
  test: /\.css$/,
  use: ['style-loader', 'css-loader', 'postcss-loader']
}
```

Import the tailwind CSS in `frontend/src/index.tsx`:
```typescript
import './styles/tailwind.css';
```

Verify: `npm run dev` should start without errors, existing MUI pages should look unchanged.

### 2. Install shadcn/ui

shadcn/ui typically assumes Next.js, but works with Webpack. Run:

```bash
npx shadcn@latest init
```

When prompted:
- Style: Default
- Base color: Neutral (or Slate — doesn't matter since we're not custom styling)
- CSS variables: Yes
- Path alias: `@/` (matches existing tsconfig paths)
- Components directory: `src/components/ui`

This creates `components.json` and a `lib/utils.ts` file. Ensure `cn()` utility works.

### 3. Install assistant-ui

```bash
npm install @assistant-ui/react @assistant-ui/react-markdown
```

Optionally, for the Lexical rich editor (used by Composer Mention):
```bash
npm install @assistant-ui/react-lexical lexical @lexical/react
```

Use `assistantUIDocs` MCP tool to check the installation page (`/docs/installation`) for the latest install instructions and any peer dependencies.

Add assistant-ui's default styles. Check their docs for the exact import — it may be:
```typescript
import "@assistant-ui/react/styles/index.css";
```

Or they may use Tailwind-based styling via shadcn components. Follow whatever the current docs say.

### 4. Install ALL Tool UI components upfront

Install every Tool UI component the migration needs. This prevents parallel agents from running conflicting `npx shadcn` installs.

```bash
npx shadcn@latest add @tool-ui/terminal
npx shadcn@latest add @tool-ui/code-block
npx shadcn@latest add @tool-ui/code-diff
npx shadcn@latest add @tool-ui/approval-card
npx shadcn@latest add @tool-ui/question-flow
npx shadcn@latest add @tool-ui/option-list
npx shadcn@latest add @tool-ui/message-draft
npx shadcn@latest add @tool-ui/data-table
npx shadcn@latest add @tool-ui/item-carousel
npx shadcn@latest add @tool-ui/progress-tracker
```

Each installs to `src/components/tool-ui/<component>/` with a component file, schema, and types.

### 5. Create the ExternalStoreRuntime adapter

Create `frontend/src/app/pages/AgentChat/runtime/useOpenSwarmRuntime.ts`.

This hook bridges the Redux store + WebSocket to assistant-ui's runtime. Use `assistantUIDocs` to look up the ExternalStoreRuntime API at path `runtimes/custom/external-store`.

Key responsibilities:
- Read `session.messages` from Redux and convert to assistant-ui's message format
- Read `session.streamingMessage` and surface it as the in-progress message
- Map `session.status` to `isRunning`
- `onNew` → dispatch `sendMessage` thunk (existing in `agentsThunks.ts`)
- `onEdit` → dispatch `editMessage` thunk
- `onCancel` → dispatch `stopAgent` thunk
- Handle `session.branches` for branching support

**Message format conversion** — the critical mapping:

Redux `AgentMessage` types:
```typescript
interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  content: any;
  timestamp: string;
  branch_id: string;
  parent_id: string | null;
  // ... other fields
}
```

assistant-ui expects messages like:
```typescript
// User message
{ role: 'user', content: [{ type: 'text', text: '...' }] }

// Assistant message
{ role: 'assistant', content: [{ type: 'text', text: '...' }] }

// Tool call (part of assistant message)
{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: '...', toolName: '...', args: {} }] }

// Tool result
{ role: 'tool', content: [{ type: 'tool-result', toolCallId: '...', result: {} }] }
```

Write a `convertMessages(messages: AgentMessage[]): ThreadMessage[]` function that handles this. Note that consecutive tool_call + tool_result messages may need to be merged or paired.

Look up the ExternalStoreRuntime docs carefully — the exact shape of `ThreadMessage` and how streaming is handled (via `status` field on messages) matters.

### 6. Create the toolkit skeleton

Create the directory `frontend/src/app/pages/AgentChat/toolkit/`.

Create `frontend/src/app/pages/AgentChat/toolkit/index.ts`:
```typescript
import { type Toolkit } from '@assistant-ui/react';
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

Create placeholder files for each toolkit module:
- `toolkit/native-tools.tsx` — exports `nativeToolkit: Partial<Toolkit> = {}`
- `toolkit/approval-tools.tsx` — exports `approvalToolkit: Partial<Toolkit> = {}`
- `toolkit/mcp-tools.tsx` — exports `mcpToolkit: Partial<Toolkit> = {}`
- `toolkit/custom-tools.tsx` — exports `customToolkit: Partial<Toolkit> = {}`

These are empty stubs. Phase 2 agents fill them in.

### 7. Create Thread and Composer placeholder directories

Create:
- `frontend/src/app/pages/AgentChat/thread/` — Agent 2 fills this
- `frontend/src/app/pages/AgentChat/composer/` — Agent 3 fills this

Create placeholder files:
- `thread/OpenSwarmThread.tsx` — exports a simple `<div>Thread placeholder</div>`
- `composer/OpenSwarmComposer.tsx` — exports a simple `<div>Composer placeholder</div>`

### 8. Scaffold AgentChat.tsx with provider wrapper

Modify `AgentChat.tsx` to wrap the chat area with `AssistantRuntimeProvider`. Keep the existing structure but prepare for Phase 2 agents to swap in their components.

The modified AgentChat should:
1. Import and use `useOpenSwarmRuntime(sessionId)` to get the runtime
2. Wrap the chat area with `<AssistantRuntimeProvider runtime={runtime}>`
3. Register the toolkit via `useAui` or `Tools` (check assistant-ui docs for the current API)
4. Keep existing imports for `ChatHeader`, `MessageQueue`, `ModelModeSelector` (these stay)
5. Keep the `useAgentChat` hook (it manages WS lifecycle, send handlers, etc.)
6. For now, keep the existing message rendering loop AND the placeholders — the app should still work with the old rendering. Agent 7 does the final swap.

**Important**: The app must still work after this agent completes. Do not remove any existing components yet — just add the runtime wrapper and placeholders alongside them.

### 9. Verify everything works

- `npm run dev` starts without errors
- The existing chat page renders and works as before
- Tailwind utility classes work (test by adding a `tw-text-red-500` class somewhere temporarily)
- Tool UI component files exist in `src/components/tool-ui/`
- No TypeScript errors from the new imports

## Files Created

| File | Description |
|------|-------------|
| `frontend/postcss.config.js` | PostCSS config for Tailwind |
| `frontend/src/styles/tailwind.css` | Tailwind entry CSS |
| `frontend/components.json` | shadcn/ui config |
| `frontend/src/lib/utils.ts` | shadcn `cn()` utility |
| `frontend/src/app/pages/AgentChat/runtime/useOpenSwarmRuntime.ts` | ExternalStoreRuntime adapter |
| `frontend/src/app/pages/AgentChat/toolkit/index.ts` | Merged toolkit registry |
| `frontend/src/app/pages/AgentChat/toolkit/native-tools.tsx` | Stub for Agent 4 |
| `frontend/src/app/pages/AgentChat/toolkit/approval-tools.tsx` | Stub for Agent 5 |
| `frontend/src/app/pages/AgentChat/toolkit/mcp-tools.tsx` | Stub for Agent 6 |
| `frontend/src/app/pages/AgentChat/toolkit/custom-tools.tsx` | Stub for Agent 6 |
| `frontend/src/app/pages/AgentChat/thread/OpenSwarmThread.tsx` | Placeholder for Agent 2 |
| `frontend/src/app/pages/AgentChat/composer/OpenSwarmComposer.tsx` | Placeholder for Agent 3 |
| `frontend/src/components/tool-ui/*` | All Tool UI components (installed via shadcn) |

## Files Modified

| File | Change |
|------|--------|
| `frontend/package.json` | New dependencies added |
| `frontend/webpack.config.js` | CSS rule with postcss-loader added |
| `frontend/tsconfig.json` | May need path adjustments for shadcn |
| `frontend/src/index.tsx` | Import tailwind CSS |
| `frontend/src/app/pages/AgentChat/AgentChat.tsx` | Wrapped with `AssistantRuntimeProvider` |

## Files Deleted

None. This agent only adds — it never removes existing functionality.

## Verification Checklist

- [ ] `npm run dev` starts without errors
- [ ] Existing chat page works exactly as before
- [ ] Tailwind classes render correctly
- [ ] `src/components/tool-ui/terminal/` exists with component + schema
- [ ] `src/components/tool-ui/code-block/` exists with component + schema
- [ ] `src/components/tool-ui/code-diff/` exists with component + schema
- [ ] `src/components/tool-ui/approval-card/` exists with component + schema
- [ ] `src/components/tool-ui/question-flow/` exists with component + schema
- [ ] `src/components/tool-ui/option-list/` exists with component + schema
- [ ] `src/components/tool-ui/message-draft/` exists with component + schema
- [ ] `src/components/tool-ui/data-table/` exists with component + schema
- [ ] `src/components/tool-ui/progress-tracker/` exists with component + schema
- [ ] `useOpenSwarmRuntime` hook compiles without errors
- [ ] Toolkit index imports all stubs without errors
- [ ] `AgentChat.tsx` has `AssistantRuntimeProvider` wrapper
