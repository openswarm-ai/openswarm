# Agent 4: Frontend Cleanup (Phase 3)

## Context

You are cleaning up the OpenSwarm frontend codebase. This is agent 4 of 4. You work **independently** from the backend agents — no backend changes are required for your work.

The frontend is a React + TypeScript app in `frontend/src/`. It uses Redux Toolkit for state management and WebSockets for real-time communication with the backend.

**Rules:**
- Every file you create or modify must be <250 lines of code
- Keep code DRY
- Do NOT touch `backend/`, `9router/`, `debugger/`, or `electron/`
- Do NOT touch tests
- Preserve all existing functionality — this is purely structural refactoring

---

## Overview

There are 40 TypeScript/TSX files over 250 lines. Here are the 13 worst offenders that need splitting:

| File | Lines | Priority |
|------|-------|----------|
| `pages/Tools/Tools.tsx` | 2480 | P0 |
| `pages/AgentChat/ToolCallBubble.tsx` | 2182 | P0 |
| `pages/Dashboard/Dashboard.tsx` | 1594 | P0 |
| `pages/Views/ViewEditor.tsx` | 1591 | P0 |
| `pages/Settings/Settings.tsx` | 1567 | P0 |
| `pages/AgentChat/ChatInput.tsx` | 1278 | P1 |
| `pages/Dashboard/BrowserCard.tsx` | 1259 | P1 |
| `pages/AgentChat/ApprovalBar.tsx` | 1160 | P1 |
| `pages/AgentChat/AgentChat.tsx` | 1137 | P1 |
| `pages/Dashboard/AgentCard.tsx` | 1063 | P1 |
| `shared/state/agentsSlice.ts` | 1030 | P1 |
| `components/Layout/AppShell.tsx` | 1005 | P2 |
| `components/DynamicIsland.tsx` | 993 | P2 |

All paths are relative to `frontend/src/app/` unless noted.

---

## General Strategy

For each oversized component:

1. **Read the file** to understand its structure — identify logical sections, sub-components rendered inline, state management, event handlers, and utility functions.

2. **Extract sub-components** into sibling files in the same directory. Each extracted component should:
   - Be in its own file
   - Accept props for data and callbacks
   - Be <250 lines

3. **Extract custom hooks** for complex stateful logic (e.g., `useDashboardDragDrop`, `useAgentChat`, `useChatSubmit`).

4. **Extract utility functions** and constants into separate files.

5. **The parent component** becomes a thin orchestrator that imports and composes the pieces.

---

## P0: Critical Splits (do these first)

### Tools.tsx (2480 lines)

Read the file first. It likely contains:
- Tool list/grid view
- Individual tool cards with config panels
- OAuth connection flows
- MCP tool discovery UI
- Permission editors per tool
- Builtin tool permission toggles

**Split into:**

```
pages/Tools/
├── Tools.tsx              # Main page: layout, tool list, state (~200)
├── ToolCard.tsx            # Individual tool card (~200)
├── ToolConfigPanel.tsx     # Config/edit panel for a tool (~200)
├── OAuthConnectFlow.tsx    # OAuth button + status display (~150)
├── ToolPermissions.tsx     # Per-tool permission toggles (~200)
├── McpDiscoveryPanel.tsx   # MCP tool discovery results (~150)
├── BuiltinToolsList.tsx    # Builtin tools section with permissions (~200)
└── hooks/
    └── useToolsState.ts   # Tool loading, CRUD operations, OAuth state (~150)
```

### ToolCallBubble.tsx (2182 lines)

This renders tool call + result bubbles in the chat. It likely has different renderers for different tool types.

**Split into:**

```
pages/AgentChat/
├── ToolCallBubble.tsx          # Router component: picks renderer by tool type (~100)
├── toolRenderers/
│   ├── DefaultToolRenderer.tsx  # Generic tool call display (~150)
│   ├── ReadToolRenderer.tsx     # File content display with line numbers (~150)
│   ├── EditToolRenderer.tsx     # Diff view for edits (~150)
│   ├── BashToolRenderer.tsx     # Terminal-style output (~150)
│   ├── SearchToolRenderer.tsx   # Grep/Glob results (~100)
│   └── McpToolRenderer.tsx      # MCP tool results (~100)
├── ToolInputDisplay.tsx         # Formatted tool input JSON (~100)
└── ToolResultDisplay.tsx        # Formatted tool result content (~100)
```

### Dashboard.tsx (1594 lines)

**Split into:**

```
pages/Dashboard/
├── Dashboard.tsx              # Main canvas + layout orchestration (~200)
├── DashboardCanvas.tsx        # The infinite canvas / drag-drop surface (~200)
├── CardRenderer.tsx           # Routes card type to correct component (~80)
├── hooks/
│   ├── useDashboardDragDrop.ts  # Drag, drop, resize logic (~200)
│   └── useDashboardState.ts     # Dashboard loading, saving (~150)
```

Keep existing `AgentCard.tsx`, `BrowserCard.tsx`, `DashboardViewCard.tsx` as-is (they'll be split separately).

### ViewEditor.tsx (1591 lines)

**Split into:**

```
pages/Views/
├── ViewEditor.tsx            # Main editor layout + state (~200)
├── EditorToolbar.tsx         # Top toolbar (save, run, vibe-code button) (~100)
├── CodeEditorPanel.tsx       # Code editor (Monaco or CodeMirror wrapper) (~150)
├── PreviewPane.tsx           # Iframe preview with hot reload (~150)
├── SchemaEditorPanel.tsx     # JSON schema editor for input_schema (~200)
├── FileTreePanel.tsx         # Multi-file tree sidebar (~150)
├── BackendCodePanel.tsx      # Backend Python code editor (~100)
└── hooks/
    └── useViewEditor.ts     # Editor state, save, auto-run logic (~200)
```

### Settings.tsx (1567 lines)

**Split into:**

```
pages/Settings/
├── Settings.tsx               # Main settings page with tabs/sections (~150)
├── ProviderSettings.tsx       # API key inputs for each provider (~200)
├── SubscriptionSection.tsx    # 9Router subscription management (~200)
├── SystemPromptEditor.tsx     # Default system prompt editor (~150)
├── GeneralSettings.tsx        # Default folder, theme, etc. (~150)
├── CustomProviderEditor.tsx   # Custom OpenAI-compat provider form (~200)
├── AnalyticsOptInSection.tsx  # Analytics toggle + info (~80)
└── hooks/
    └── useSettings.ts        # Settings load/save logic (~100)
```

---

## P1: Important Splits

### ChatInput.tsx (1278 lines)

**Split into:**

```
pages/AgentChat/
├── ChatInput.tsx             # Main input container (~200)
├── AttachmentBar.tsx          # File/image attachment display (~100)
├── ModeSelector.tsx          # Mode dropdown (Agent/Ask/Plan/etc) (~100)
├── ModelPicker.tsx           # Model selection dropdown (~100)
├── ContextAttachments.tsx    # Context path + skill attachment UI (~150)
└── hooks/
    └── useChatSubmit.ts     # Submit logic, validation, WS send (~150)
```

### BrowserCard.tsx (1259 lines)

**Split into:**

```
pages/Dashboard/
├── BrowserCard.tsx           # Main browser card (~200)
├── BrowserToolbar.tsx        # URL bar, navigation buttons (~150)
├── BrowserTabBar.tsx         # Tab management strip (~100)
├── BrowserViewport.tsx       # The webview/iframe wrapper (~200)
└── BrowserContextMenu.tsx    # Right-click context menu (~100)
```

### ApprovalBar.tsx (1160 lines)

**Split into:**

```
pages/AgentChat/
├── ApprovalBar.tsx           # Main approval container + queue (~150)
├── ApprovalCard.tsx          # Individual approval request card (~200)
├── ToolInputEditor.tsx       # Editable tool input JSON viewer (~200)
└── ApprovalActions.tsx       # Allow/Deny/Edit buttons + logic (~100)
```

### AgentChat.tsx (1137 lines)

**Split into:**

```
pages/AgentChat/
├── AgentChat.tsx             # Main chat page layout (~200)
├── MessageList.tsx           # Scrollable message list (~200)
├── ChatHeader.tsx            # Session name, model, status bar (~100)
└── hooks/
    └── useAgentChat.ts      # Chat state, message handling, branch nav (~200)
```

### AgentCard.tsx (1063 lines)

**Split into:**

```
pages/Dashboard/
├── AgentCard.tsx             # Main agent card (~200)
├── AgentCardHeader.tsx       # Name, status badge, model tag (~100)
├── AgentCardMessages.tsx     # Compact message list in card (~200)
├── AgentCardActions.tsx      # Stop, close, resume, duplicate buttons (~100)
└── AgentCardToolGroup.tsx    # Collapsed tool call groups (~150)
```

### agentsSlice.ts (1030 lines)

**Split into:**

```
shared/state/
├── agentsSlice.ts            # Core session state: CRUD, status (~200)
├── agentMessagesSlice.ts     # Message handling: add, edit, branch (~200)
├── agentStreamSlice.ts       # Streaming state: deltas, stream start/end (~150)
└── agentWebSocket.ts         # WebSocket message dispatch + handlers (~200)
```

Or if Redux Toolkit makes splitting slices difficult, at minimum extract the WebSocket handler logic and message processing into separate files, keeping a single slice that imports helper functions.

---

## P2: Lower Priority Splits

### AppShell.tsx (1005 lines)

**Split into:**

```
components/Layout/
├── AppShell.tsx              # Main shell: sidebar + content area (~150)
├── Sidebar.tsx               # Navigation sidebar (~200)
├── NavigationRail.tsx        # Icon rail for collapsed sidebar (~100)
├── PageRouter.tsx            # Route → page component mapping (~100)
└── hooks/
    └── useNavigation.ts     # Route state, sidebar collapse (~100)
```

### DynamicIsland.tsx (993 lines)

**Split into:**

```
components/
├── DynamicIsland.tsx         # Container + animation (~150)
├── IslandQuickActions.tsx    # Quick action buttons/chips (~150)
├── IslandAgentStatus.tsx     # Active agent status summary (~150)
├── IslandNotifications.tsx   # Notification toasts (~100)
└── hooks/
    └── useIslandState.ts    # Island expand/collapse, content logic (~150)
```

---

## P3: Remaining Files Over 250 Lines

After completing P0-P2, check what's still over 250 lines:

```bash
find frontend/src -type f \( -name '*.ts' -o -name '*.tsx' \) | xargs wc -l | sort -rn | awk '$1 > 250 {print}'
```

For each remaining file, apply the same decomposition strategy:
1. Extract sub-components
2. Extract hooks for complex logic
3. Extract constants/utils

Target: **zero files over 250 lines**.

---

## Shared Frontend Utilities (if time permits)

### Typed API Client

If you notice scattered `fetch()` calls with duplicated base URL construction and error handling, consider extracting into `shared/api.ts`:

```typescript
const api = {
  get: <T>(path: string) => Promise<T>,
  post: <T>(path: string, body?: any) => Promise<T>,
  put: <T>(path: string, body?: any) => Promise<T>,
  delete: (path: string) => Promise<void>,
}
```

### Common UI Patterns

If you see repeated patterns (confirmation dialogs, loading spinners, error states), extract them into `shared/components/`.

---

## Verification

After all splits are complete:

1. Verify no file exceeds 250 lines:
   ```bash
   find frontend/src -type f \( -name '*.ts' -o -name '*.tsx' \) | xargs wc -l | sort -rn | awk '$1 > 250'
   ```
   This should return only the `total` line.

2. Verify the frontend builds without errors:
   ```bash
   cd frontend && npm run build
   ```
   (Or `npx webpack --mode production` — check `package.json` for the build command)

3. Verify no TypeScript errors:
   ```bash
   cd frontend && npx tsc --noEmit
   ```

4. Spot-check that key pages render correctly by starting the dev server and navigating to:
   - Dashboard page
   - Agent chat page
   - Tools page
   - Settings page
   - Views/Editor page
