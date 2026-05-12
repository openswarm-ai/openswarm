import React, { useState, useMemo, useEffect, useRef, useCallback, PointerEvent as ReactPointerEvent } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import HtmlIcon from '@mui/icons-material/Code';
import PythonIcon from '@mui/icons-material/Terminal';
import SchemaIcon from '@mui/icons-material/DataObject';
import JsIcon from '@mui/icons-material/Javascript';
import CssIcon from '@mui/icons-material/Style';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import FolderIcon from '@mui/icons-material/Folder';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import Collapse from '@mui/material/Collapse';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, removeDraftSession, fetchSession } from '@/shared/state/agentsSlice';
import { createOutput, updateOutput, Output, SERVE_BASE } from '@/shared/state/outputsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import AgentChat from '../AgentChat/AgentChat';
import RefreshIcon from '@mui/icons-material/Refresh';
import ViewPreview, { ViewPreviewHandle } from './ViewPreview';
import TerminalPanel, { TerminalLine } from './TerminalPanel';
import { getDefault } from './InputSchemaForm';
import CodeEditor from './CodeEditor';
import { ElementSelectionProvider } from '@/app/components/ElementSelectionContext';
import { captureViewThumbnail } from './captureViewThumbnail';
import { API_BASE, getAuthToken } from '@/shared/config';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';

const WORKSPACE_API = `${API_BASE}/outputs/workspace`;
const POLL_INTERVAL_MS = 2000;

function getFileIcon(filename: string): React.ReactNode {
  const ext = filename.split('.').pop()?.toLowerCase();
  const size = 15;
  switch (ext) {
    case 'html': case 'htm': return <HtmlIcon sx={{ fontSize: size }} />;
    case 'py': return <PythonIcon sx={{ fontSize: size }} />;
    case 'json': return <SchemaIcon sx={{ fontSize: size }} />;
    case 'js': case 'jsx': case 'ts': case 'tsx': return <JsIcon sx={{ fontSize: size }} />;
    case 'css': case 'scss': case 'less': return <CssIcon sx={{ fontSize: size }} />;
    default: return <InsertDriveFileIcon sx={{ fontSize: size }} />;
  }
}

function getEditorLanguage(filename: string): 'html' | 'python' | 'json' {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'json': return 'json';
    default: return 'html';
  }
}

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
}

function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const sorted = [...filePaths].sort();

  for (const fp of sorted) {
    const parts = fp.split('/');
    let current = root;
    let pathSoFar = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const isLast = i === parts.length - 1;

      let existing = current.find(n => n.name === part && n.isDir === !isLast);
      if (!existing) {
        if (isLast) {
          existing = { name: part, path: fp, isDir: false };
        } else {
          existing = { name: part, path: pathSoFar, isDir: true, children: [] };
        }
        current.push(existing);
      }
      if (!isLast) {
        current = existing.children!;
      }
    }
  }

  return root;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  activeFile: string;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  c: ReturnType<typeof useClaudeTokens>;
}

const PROTECTED_FILES = new Set(['index.html', 'schema.json', 'meta.json', 'SKILL.md']);

const FileTreeItem: React.FC<FileTreeItemProps> = ({ node, depth, activeFile, onSelect, onDelete, c }) => {
  const [open, setOpen] = useState(true);

  if (node.isDir) {
    return (
      <>
        <Box
          onClick={() => setOpen(!open)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            pl: 1.5 + depth * 1,
            pr: 1,
            py: 0.5,
            cursor: 'pointer',
            '&:hover': { bgcolor: c.bg.surface },
          }}
        >
          <ExpandMoreIcon sx={{ fontSize: 12, color: c.text.ghost, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '0.15s' }} />
          <FolderIcon sx={{ fontSize: 14, color: c.text.muted }} />
          <Typography sx={{ fontSize: '0.74rem', color: c.text.secondary, fontFamily: c.font.mono }}>
            {node.name}
          </Typography>
        </Box>
        <Collapse in={open}>
          {node.children?.map((child) => (
            <FileTreeItem key={child.path} node={child} depth={depth + 1} activeFile={activeFile} onSelect={onSelect} onDelete={onDelete} c={c} />
          ))}
        </Collapse>
      </>
    );
  }

  const isActive = activeFile === node.path;
  const canDelete = onDelete && !PROTECTED_FILES.has(node.path);

  return (
    <Box
      onClick={() => onSelect(node.path)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        pl: 1.5 + depth * 1 + 1.25,
        pr: 0.5,
        py: 0.5,
        cursor: 'pointer',
        bgcolor: isActive ? c.bg.elevated : 'transparent',
        borderLeft: isActive ? `2px solid ${c.accent.primary}` : '2px solid transparent',
        '&:hover': { bgcolor: isActive ? c.bg.elevated : c.bg.surface },
        '&:hover .delete-btn': { opacity: 1 },
        transition: 'background-color 0.1s',
      }}
    >
      <Box sx={{ color: isActive ? c.accent.primary : c.text.muted, display: 'flex', flexShrink: 0 }}>
        {getFileIcon(node.name)}
      </Box>
      <Typography
        sx={{
          fontSize: '0.74rem',
          fontFamily: c.font.mono,
          color: isActive ? c.text.primary : c.text.secondary,
          fontWeight: isActive ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {node.name}
      </Typography>
      {canDelete && (
        <IconButton
          className="delete-btn"
          size="small"
          onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
          sx={{ opacity: 0, p: 0.25, color: c.text.ghost, '&:hover': { color: '#ef4444' }, transition: 'opacity 0.15s, color 0.15s' }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
    </Box>
  );
};

interface Props {
  output: Output | null;
  onClose: () => void;
}

const ViewEditor: React.FC<Props> = ({ output }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();

  const [createdId, setCreatedId] = useState<string | null>(null);
  const createdIdRef = useRef<string | null>(null);
  const effectiveId = output?.id ?? createdId;

  const [name, setName] = useState(output?.name ?? '');
  const [description, setDescription] = useState(output?.description ?? '');

  const initialFiles = useMemo<Record<string, string>>(() => {
    if (!output) return {};
    const f = { ...output.files };
    if (!f['schema.json'] && output.input_schema) {
      f['schema.json'] = JSON.stringify(output.input_schema, null, 2);
    }
    return f;
  }, [output]);

  const [files, setFiles] = useState<Record<string, string>>(initialFiles);

  const TAB_PREVIEW = 0;
  const TAB_CODE = 1;
  const TAB_TERMINAL = 2;

  const [activeTab, setActiveTab] = useState(TAB_PREVIEW);
  const [activeFile, setActiveFile] = useState('index.html');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip preview reloads when nothing the user can SEE changed.
  // The iframe renders index.html; if a save only touched SKILL.md or
  // other non-rendered files, there's no point reloading the iframe —
  // the visible content is identical and we'd just flash the empty
  // "Ready" placeholder during the reload-blank-moment. Tracking the
  // last reloaded snapshot of index.html lets us short-circuit those.
  // Combined with the trailing-edge debounce below, the iframe only
  // reloads when (a) index.html actually changed AND (b) the agent
  // has stopped writing for >600ms — usually 0-1 reloads per generation.
  const previewReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReloadedIndexHtmlRef = useRef<string>(initialFiles['index.html'] ?? '');
  const PREVIEW_RELOAD_DEBOUNCE_MS = 600;
  const savingRef = useRef(false);
  // Terminal pane state. Persistent app-backend stdout/stderr arrives via
  // the runtime WS; the running app's console.log/warn/error arrives via
  // ipc-message from the webview-preload bridge. Both feed into a single
  // chronological buffer here so the user sees interleaved [FRONTEND] /
  // [BACKEND] / [RUNTIME] lines.
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const terminalLineIdRef = useRef(0);
  const TERMINAL_BUFFER_CAP = 5000; // trim FIFO past this so we don't grow unbounded

  const previewRef = useRef<ViewPreviewHandle>(null);

  const SIDEBAR_MIN = 280;
  const SIDEBAR_MAX = 800;
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const onDragStart = useCallback((e: ReactPointerEvent) => {
    dragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const onDragMove = useCallback((e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - dragStartX.current;
    setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStartWidth.current + delta)));
  }, []);

  const onDragEnd = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const [initialDraftId, setInitialDraftId] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  // Reuse the workspace_id stored on the Output if present so we don't seed a
  // fresh folder every time the editor remounts (which would orphan the agent's
  // in-progress edits and lose chat continuity). Only mint a new id for first-
  // time outputs that don't yet have one persisted.
  const [stableWorkspaceId] = useState(() => output?.workspace_id || `ws-${Date.now().toString(36)}`);
  const draftCreated = useRef(false);

  // Honor the user's Settings → default_model + default_thinking_level.
  // Without this, createDraftSession's hardcoded 'sonnet' / undefined-thinking
  // fallbacks win and App Builder always opens on Sonnet + Auto thinking
  // regardless of what the user picked in Settings.
  const defaultModel = useAppSelector((s) => s.settings.data.default_model);
  const defaultThinkingLevel = useAppSelector((s) => s.settings.data.default_thinking_level);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);

  useEffect(() => {
    if (draftCreated.current) return;
    // Wait for settings + model registry before seeding the draft, otherwise
    // we'd snapshot the Redux initial 'sonnet' default and ignore the user's pick.
    if (!settingsLoaded || !modelsLoaded) return;
    draftCreated.current = true;

    // Resolve provider from the model registry. Group names mirror the
    // provider map in ChatInput.tsx (Anthropic / OpenSwarm Pro → 'anthropic',
    // Google → 'gemini', xAI/Meta/etc → 'openrouter').
    const PROVIDER_MAP: Record<string, string> = {
      anthropic: 'anthropic',
      'openswarm pro': 'anthropic',
      openai: 'openai',
      google: 'gemini',
      xai: 'openrouter',
      meta: 'openrouter',
      deepseek: 'openrouter',
      mistral: 'openrouter',
      qwen: 'openrouter',
      cohere: 'openrouter',
    };
    let resolvedProvider: string | undefined;
    for (const [prov, models] of Object.entries(modelsByProvider)) {
      if (models.some((m: any) => m.value === defaultModel)) {
        resolvedProvider = PROVIDER_MAP[prov.toLowerCase()] || prov.toLowerCase();
        break;
      }
    }

    (async () => {
      // Reattach branch: this Output already has a session + workspace from a
      // prior visit. Skip seeding (would clobber any in-progress edits the
      // agent made) and skip createDraftSession (would orphan the live session).
      // Just resolve the workspace path and tell AgentChat which session to bind to.
      if (output?.session_id && output?.workspace_id) {
        // Resolve the workspace path first (best-effort; chat works without it).
        let resolvedWorkspacePath: string | null = null;
        try {
          const res = await fetch(`${WORKSPACE_API}/${output.workspace_id}`);
          if (res.ok) {
            const data = await res.json();
            if (data.path) {
              resolvedWorkspacePath = data.path;
              setWorkspacePath(data.path);
            }
          }
        } catch { /* path is best-effort */ }

        // Verify the persisted session still exists on the backend before
        // binding to it. The id can become stale (backend data wiped,
        // sessions cleared, different OpenSwarm install) — without this
        // check we'd hand AgentChat a non-existent id and the chat pane
        // would be stuck on "Initializing agent…" forever. On 200 we
        // bind; on 404 we fall through to seed a fresh draft session
        // attached to the same workspace (preserves app code on disk;
        // only the chat history is lost — acceptable trade).
        let sessionStillExists = false;
        try {
          const sr = await fetch(`${API_BASE}/agents/sessions/${output.session_id}`);
          sessionStillExists = sr.ok;
        } catch { /* network blip — treat as missing */ }

        if (sessionStillExists) {
          // Pull the latest session state from the backend so the chat
          // catches up on anything the agent did while the user was on
          // another tab.
          dispatch(fetchSession(output.session_id));
          setInitialDraftId(output.session_id);
          return;
        }

        // Stale linkage. Clear it from the Output so future opens skip
        // the 404 round-trip, then fall through to createDraftSession
        // with the same workspace.
        if (output.id) {
          try {
            await dispatch(updateOutput({ id: output.id, session_id: null })).unwrap();
          } catch { /* best-effort cleanup */ }
        }
        const action = dispatch(createDraftSession({
          mode: 'view-builder',
          setActive: false,
          targetDirectory: resolvedWorkspacePath || undefined,
          model: defaultModel || undefined,
          provider: resolvedProvider,
          thinkingLevel: defaultThinkingLevel || undefined,
        }));
        setInitialDraftId(action.payload.draftId);
        return;
      }

      const seedBody: Record<string, any> = { workspace_id: stableWorkspaceId };
      if (output) {
        const seedFiles: Record<string, string> = { ...output.files };
        if (output.input_schema && !seedFiles['schema.json']) {
          seedFiles['schema.json'] = JSON.stringify(output.input_schema, null, 2);
        }
        seedBody.files = seedFiles;
        seedBody.meta = { name: output.name, description: output.description };
      }
      try {
        const res = await fetch(`${WORKSPACE_API}/seed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(seedBody),
        });
        const data = await res.json();
        setWorkspacePath(data.path);
        const action = dispatch(createDraftSession({
          mode: 'view-builder',
          setActive: false,
          targetDirectory: data.path,
          model: defaultModel || undefined,
          provider: resolvedProvider,
          thinkingLevel: defaultThinkingLevel || undefined,
        }));
        setInitialDraftId(action.payload.draftId);
      } catch {
        const action = dispatch(createDraftSession({
          mode: 'view-builder',
          setActive: false,
          model: defaultModel || undefined,
          provider: resolvedProvider,
          thinkingLevel: defaultThinkingLevel || undefined,
        }));
        setInitialDraftId(action.payload.draftId);
      }
    })();
  }, [dispatch, output, stableWorkspaceId, settingsLoaded, modelsLoaded, defaultModel, defaultThinkingLevel, modelsByProvider]);

  // Resolve our bound session id strictly through our own pointers:
  //   1. initialDraftId is the draft we created OR the real id reattached
  //      from output.session_id.
  //   2. If the draft was launched in the meantime, the real id lives in
  //      draftLaunchMap — promote to that.
  // We deliberately do NOT fall back to state.agents.activeSessionId here.
  // activeSessionId is a global pointer that any dashboard click, child
  // chat, or sibling App Builder can clobber, so falling back to it bled
  // unrelated agents' chats into the App Builder while a session was
  // still loading (e.g. JobFinder's transcript showing inside the
  // Chatbot app builder).
  const launchedFromDraft = useAppSelector((state) =>
    initialDraftId ? state.agents.draftLaunchMap[initialDraftId] : undefined,
  );
  const effectiveSessionId = useAppSelector((state) => {
    if (!initialDraftId) return null;
    if (state.agents.sessions[initialDraftId]) return initialDraftId;
    const mapped = state.agents.draftLaunchMap[initialDraftId];
    if (mapped && state.agents.sessions[mapped]) return mapped;
    return null;
  });

  // Once a draft has been replaced by a real launched session, promote
  // initialDraftId so subsequent renders bypass the map lookup and we
  // stay on the real id even if draftLaunchMap is later cleaned up.
  useEffect(() => {
    if (launchedFromDraft && initialDraftId && launchedFromDraft !== initialDraftId) {
      setInitialDraftId(launchedFromDraft);
    }
  }, [launchedFromDraft, initialDraftId]);

  const agentStatus = useAppSelector((state) => {
    if (!effectiveSessionId) return null;
    return state.agents.sessions[effectiveSessionId]?.status ?? null;
  });

  const isLaunched = !!effectiveSessionId && effectiveSessionId !== initialDraftId;
  const isAgentActive = agentStatus === 'running' || agentStatus === 'waiting_approval';

  const workspaceId = workspacePath ? stableWorkspaceId : null;
  const workspaceIdRef = useRef<string | null>(null);
  workspaceIdRef.current = workspaceId;
  const wsPushTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const initialContextPaths = useMemo(
    () => workspacePath ? [{ path: workspacePath, type: 'directory' as const }] : undefined,
    [workspacePath],
  );

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPollRef = useRef<string>('');

  const nameSetByMeta = useRef(false);
  const [fileVersion, setFileVersion] = useState(0);

  const pollWorkspace = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`${WORKSPACE_API}/${workspaceId}`);
      if (!res.ok) return;
      const data = await res.json();
      const fingerprint = JSON.stringify(data);
      if (fingerprint === lastPollRef.current) return;
      lastPollRef.current = fingerprint;

      if (data.files) {
        setFiles(data.files);
        setFileVersion(v => v + 1);
      }

      if (data.meta) {
        if (data.meta.name && !nameSetByMeta.current) {
          nameSetByMeta.current = true;
          setName((prev) => prev || data.meta.name);
        }
        if (data.meta.description) {
          setDescription((prev) => prev || data.meta.description);
        }
      }
    } catch {}
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    pollWorkspace();
    pollRef.current = setInterval(pollWorkspace, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [workspaceId, pollWorkspace]);

  const prevAgentActive = useRef(false);
  useEffect(() => {
    if (prevAgentActive.current && !isAgentActive && workspaceId) {
      setTimeout(pollWorkspace, 500);
    }
    prevAgentActive.current = isAgentActive;
  }, [isAgentActive, workspaceId, pollWorkspace]);

  // Hold the latest session status in a ref so the unmount cleanup can read it
  // at teardown time (the cleanup closure would otherwise capture a stale value
  // from when the effect first ran).
  const sessionStatusRef = useRef<string | null>(null);
  sessionStatusRef.current = agentStatus;
  const isLaunchedRef = useRef(false);
  isLaunchedRef.current = isLaunched;

  useEffect(() => {
    return () => {
      // Only garbage-collect drafts the user abandoned without launching. Once
      // a session is launched, the agent runs on the backend independent of
      // the frontend — leave the Redux entry alive so navigating away doesn't
      // wipe in-progress work or chat history.
      if (initialDraftId && sessionStatusRef.current === 'draft' && !isLaunchedRef.current) {
        dispatch(removeDraftSession(initialDraftId));
      }
    };
  }, [initialDraftId, dispatch]);

  // Persist session_id + workspace_id onto the saved Output the moment the
  // session goes from draft to launched. Without this, reopening the App later
  // would have no way to find its in-progress session and would seed a fresh one.
  // Use `createdId` (state) not `createdIdRef.current` so the effect re-fires
  // after autosave creates the Output for a brand-new app. `output` prop is a
  // parent snapshot that doesn't refresh, so we dedup via a ref.
  const persistedLinkageRef = useRef<string | null>(null);
  useEffect(() => {
    const eid = output?.id ?? createdId;
    if (!eid || !effectiveSessionId || !isLaunched) return;
    const fingerprint = `${eid}:${effectiveSessionId}:${stableWorkspaceId}`;
    if (persistedLinkageRef.current === fingerprint) return;
    persistedLinkageRef.current = fingerprint;
    dispatch(updateOutput({
      id: eid,
      session_id: effectiveSessionId,
      workspace_id: stableWorkspaceId,
    }));
  }, [effectiveSessionId, isLaunched, output?.id, createdId, stableWorkspaceId, dispatch]);

  const schemaText = files['schema.json'] ?? '{"type":"object","properties":{},"required":[]}';

  const parsedSchema = useMemo(() => {
    try { return JSON.parse(schemaText); } catch { return { type: 'object', properties: {} }; }
  }, [schemaText]);

  const testInput = useMemo<Record<string, any>>(() => getDefault(parsedSchema), [parsedSchema]);

  const savedRef = useRef(!!output);

  const buildBody = () => {
    let schema: Record<string, any>;
    try { schema = JSON.parse(schemaText); } catch { schema = { type: 'object', properties: {} }; }

    const outputFiles = { ...files };
    delete outputFiles['meta.json'];
    delete outputFiles['schema.json'];
    delete outputFiles['SKILL.md'];

    return {
      name: name || 'Untitled App',
      description,
      icon: 'view_quilt',
      input_schema: schema,
      files: outputFiles,
    };
  };

  const captureThumbnailAsync = (outputId: string) => {
    captureViewThumbnail(files['index.html'] ?? '', testInput, files)
      .then((thumbnail) => {
        if (thumbnail) {
          dispatch(updateOutput({ id: outputId, thumbnail }));
        }
      })
      .catch(() => {});
  };

  const performSaveRef = useRef<(() => Promise<void>) | null>(null);

  performSaveRef.current = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const body = buildBody();
      const eid = output?.id ?? createdIdRef.current;
      let savedId: string;
      if (eid) {
        await dispatch(updateOutput({ id: eid, ...body })).unwrap();
        savedId = eid;
      } else {
        const created = await dispatch(createOutput(body)).unwrap();
        savedId = created.id;
        createdIdRef.current = savedId;
        setCreatedId(savedId);
        // First successful create = the App Builder agent finished
        // generating an app. Step 8's "wait for app to land" listens for
        // this. Subsequent saves don't fire — only the initial creation
        // matters for onboarding.
        onboardingBus.emit('app:generation_done');
      }
      savedRef.current = true;
      // Trailing-edge debounce + content-changed gate. Only triggers
      // a real iframe reload when the agent has gone quiet AND the
      // file the iframe actually renders (index.html) changed since
      // the last reload. Eliminates the "Ready" empty-state flash
      // entirely for non-rendered file writes (SKILL.md, etc).
      if (previewReloadTimerRef.current) {
        clearTimeout(previewReloadTimerRef.current);
      }
      previewReloadTimerRef.current = setTimeout(() => {
        previewReloadTimerRef.current = null;
        const currentHtml = files['index.html'] ?? '';
        if (currentHtml === lastReloadedIndexHtmlRef.current) return;
        lastReloadedIndexHtmlRef.current = currentHtml;
        previewRef.current?.reload();
      }, PREVIEW_RELOAD_DEBOUNCE_MS);
      captureThumbnailAsync(savedId);
    } catch (err: any) {
      console.error('Failed to save output:', err);
    } finally {
      savingRef.current = false;
    }
  };

  const appendTerminalLine = useCallback((source: TerminalLine['source'], level: string, text: string) => {
    setTerminalLines((prev) => {
      const next = prev.concat({
        id: ++terminalLineIdRef.current,
        source,
        level,
        text,
      });
      // FIFO trim — keep the tail. Past TERMINAL_BUFFER_CAP, the head is
      // ancient and not what the user is reading.
      if (next.length > TERMINAL_BUFFER_CAP) {
        return next.slice(next.length - TERMINAL_BUFFER_CAP);
      }
      return next;
    });
  }, []);

  const handleWebviewConsole = useCallback((level: string, text: string) => {
    appendTerminalLine('frontend', level, text);
  }, [appendTerminalLine]);

  // Reload button context menu — left-click is a soft reload (reloads
  // the webview only); right-click opens this menu, which adds a Hard
  // Reload that also restarts the persistent backend subprocess.
  // Useful when backend.py has a Python-level error you can only clear
  // by stopping and re-spawning the process.
  const [reloadMenuAnchor, setReloadMenuAnchor] = useState<HTMLElement | null>(null);
  const handleHardReload = useCallback(async () => {
    setReloadMenuAnchor(null);
    if (workspaceId) {
      try {
        const tok = getAuthToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tok) headers.Authorization = `Bearer ${tok}`;
        await fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/restart`, {
          method: 'POST',
          headers,
        });
      } catch { /* failures surface via the runtime log WS */ }
    }
    previewRef.current?.reload();
  }, [workspaceId]);

  // Persistent backend lifecycle. Once we know the workspaceId:
  //   1. POST /runtime/start so the workspace's runtime (bash run.sh
  //      for new-mode webapp-template workspaces; python backend.py for
  //      legacy flat workspaces) gets spawned.
  //   2. Open the runtime WS to stream [BACKEND]/[RUNTIME] stdout/stderr
  //      into the Terminal pane AND surface the frontend_url for new-
  //      mode workspaces (so the preview pane can point at Vite's dev
  //      server instead of our legacy /serve/ endpoint).
  //   3. On unmount, POST /runtime/stop. Multiple editors on the same
  //      workspace share the runtime (ref-counted server-side); detach
  //      is a no-op until the last subscriber leaves.
  const runtimeWsRef = useRef<WebSocket | null>(null);
  // Where the preview pane should point. New-mode workspaces report a
  // frontend_url via runtime:status; until it arrives (or for old-mode
  // workspaces that never set it), we fall back to the legacy
  // /api/outputs/workspace/{ws}/serve/ endpoint below.
  const [frontendUrl, setFrontendUrl] = useState<string | null>(null);
  // Track new-mode separately so the preview pane can show a
  // "Installing dependencies…" placeholder while Vite is still booting
  // instead of trying to load the legacy /serve/index.html path (which
  // 404s — new-mode workspaces have no `index.html` at root, only
  // `frontend/index.html` reachable via Vite).
  const [isNewModeRuntime, setIsNewModeRuntime] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    setFrontendUrl(null); // reset when workspace changes
    setIsNewModeRuntime(false);

    const auth = getAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;

    (async () => {
      try {
        await fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/start`, {
          method: 'POST',
          headers,
        });
      } catch (_) { /* the runtime endpoints surface errors via the log WS */ }
      if (cancelled) return;
      try {
        const wsBase = API_BASE.replace(/^http/, 'ws').replace(/\/api$/, '');
        const url = `${wsBase}/ws/outputs/runtime/${workspaceId}/logs?token=${encodeURIComponent(auth || '')}`;
        ws = new WebSocket(url);
        runtimeWsRef.current = ws;
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.event === 'runtime:status') {
              // New-mode runtimes report a frontend_url here as soon as
              // Vite has actually bound (the runtime poll-gates it);
              // old-mode workspaces report null and the preview pane
              // stays on the legacy /serve/ path. We also track
              // is_new_mode separately so the placeholder pane shows
              // "Installing dependencies…" instead of the 404'd /serve
              // path while Vite is mid-npm-install.
              const fu = msg.data?.frontend_url ?? null;
              setFrontendUrl(fu || null);
              setIsNewModeRuntime(!!msg.data?.is_new_mode);
            } else if (msg.event === 'runtime:log') {
              const stream = msg.data?.stream || 'stdout';
              const text = msg.data?.text || '';
              if (stream === 'runtime') {
                appendTerminalLine('runtime', 'info', text);
              } else {
                appendTerminalLine('backend', stream, text);
              }
            }
          } catch (_) {}
        };
      } catch (_) {}
    })();

    return () => {
      cancelled = true;
      try { ws?.close(); } catch (_) {}
      runtimeWsRef.current = null;
      setFrontendUrl(null);
      setIsNewModeRuntime(false);
      fetch(`${API_BASE}/outputs/workspace/${workspaceId}/runtime/stop`, {
        method: 'POST',
        headers,
      }).catch(() => {});
    };
  }, [workspaceId, appendTerminalLine]);

  // Preview URL: prefer the new-mode Vite dev server when the runtime
  // reports one; otherwise fall back to the legacy serve endpoint.
  // For new-mode workspaces where Vite hasn't bound yet (npm install
  // still running), `workspaceServeUrl` is undefined and the preview
  // pane renders the "Installing dependencies…" placeholder below
  // instead of falling back to the legacy /serve/ path (which 404s —
  // new-mode workspaces have no `index.html` at root).
  const showInstallPlaceholder = isNewModeRuntime && !frontendUrl;
  const workspaceServeUrl = showInstallPlaceholder
    ? undefined
    : (frontendUrl ?? (workspaceId ? `${SERVE_BASE}/workspace/${workspaceId}/serve/index.html` : undefined));

  const filePaths = useMemo(() => Object.keys(files).filter(p => p !== 'meta.json' && p !== 'SKILL.md').sort(), [files]);
  const fileTree = useMemo(() => buildFileTree(filePaths), [filePaths]);

  const updateFile = useCallback((path: string, content: string) => {
    setFiles(prev => ({ ...prev, [path]: content }));
    const wsId = workspaceIdRef.current;
    if (wsId) {
      const existing = wsPushTimers.current.get(path);
      if (existing) clearTimeout(existing);
      wsPushTimers.current.set(path, setTimeout(() => {
        wsPushTimers.current.delete(path);
        fetch(`${WORKSPACE_API}/${wsId}/file/${encodeURIComponent(path)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
          .then(() => previewRef.current?.reload())
          .catch(() => {});
      }, 300));
    }
  }, []);

  const [newFileName, setNewFileName] = useState('');
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const newFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNewFileInput) {
      setTimeout(() => newFileInputRef.current?.focus(), 50);
    }
  }, [showNewFileInput]);

  const addFile = useCallback((fileName: string) => {
    const trimmed = fileName.trim();
    if (!trimmed || files[trimmed] != null) return;
    setFiles(prev => ({ ...prev, [trimmed]: '' }));
    setActiveFile(trimmed);
    setShowNewFileInput(false);
    setNewFileName('');
    if (workspaceId) {
      fetch(`${WORKSPACE_API}/${workspaceId}/file/${encodeURIComponent(trimmed)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      }).catch(() => {});
    }
  }, [files, workspaceId]);

  const deleteFile = useCallback((filePath: string) => {
    setFiles(prev => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
    if (activeFile === filePath) {
      const remaining = filePaths.filter(p => p !== filePath);
      setActiveFile(remaining[0] ?? 'index.html');
    }
    if (workspaceId) {
      fetch(`${WORKSPACE_API}/${workspaceId}/file/${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
  }, [activeFile, filePaths, workspaceId]);

  const activeFileContent = files[activeFile] ?? '';

  const autoSaveInitRef = useRef(true);
  useEffect(() => {
    if (autoSaveInitRef.current) {
      autoSaveInitRef.current = false;
      return;
    }
    const hasContent = name.trim() || (files['index.html'] ?? '').trim();
    if (!hasContent) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      performSaveRef.current?.();
    }, 1500);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [files, name, description]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (previewReloadTimerRef.current) clearTimeout(previewReloadTimerRef.current);
      wsPushTimers.current.forEach(t => clearTimeout(t));
    };
  }, []);

  return (
    <ElementSelectionProvider>
    <Box sx={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      {/* Left panel — AgentChat */}
      <Box
        // data-onboarding-scope="app-builder" — the AC's per-agent
        // selector resolver prefers this scope when it's mounted, so
        // step 8's chat-input / chat-send-button / type_into all
        // resolve inside the App Builder's AgentChat instance instead
        // of falling through to whatever chat-input was last in DOM
        // order (which led to AC typing into nothing visible).
        data-onboarding-scope="app-builder"
        sx={{
          width: sidebarWidth,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: c.bg.page,
        }}
      >
        {effectiveSessionId ? (
          <AgentChat key={effectiveSessionId} sessionId={effectiveSessionId} initialContextPaths={initialContextPaths} />
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.85rem' }}>
              Initializing agent...
            </Typography>
          </Box>
        )}
      </Box>

      {/* Resize handle */}
      <Box
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        sx={{
          width: 6,
          flexShrink: 0,
          cursor: 'col-resize',
          position: 'relative',
          bgcolor: 'transparent',
          transition: 'background-color 0.15s',
          '&::after': {
            content: '""',
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 1,
            bgcolor: c.border.subtle,
            transition: 'width 0.15s, background-color 0.15s',
          },
          '&:hover::after, &:active::after': {
            width: 3,
            bgcolor: c.accent.primary,
          },
        }}
      />

      {/* Right panel */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            px: 1.5,
            py: 0.75,
            borderBottom: `1px solid ${c.border.subtle}`,
            bgcolor: c.bg.secondary,
            flexShrink: 0,
            minHeight: 44,
          }}
        >
          <TextField
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="App name"
            variant="standard"
            sx={{
              flex: 1,
              maxWidth: 220,
              '& .MuiInput-input': { fontSize: '0.9rem', fontWeight: 600, color: c.text.primary },
              '& .MuiInput-underline:before': { borderColor: 'transparent' },
              '& .MuiInput-underline:hover:before': { borderColor: c.border.medium },
            }}
          />

          <TextField
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            variant="standard"
            size="small"
            sx={{
              flex: 2,
              '& .MuiInput-input': { fontSize: '0.78rem', color: c.text.muted },
              '& .MuiInput-underline:before': { borderColor: 'transparent' },
            }}
          />

        </Box>

        {/* Tab bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            borderBottom: `1px solid ${c.border.subtle}`,
            bgcolor: c.bg.secondary,
            flexShrink: 0,
          }}
        >
          <Tabs
            value={activeTab}
            onChange={(_, v) => setActiveTab(v)}
            sx={{
              flex: 1,
              minHeight: 36,
              '& .MuiTab-root': {
                minHeight: 36,
                fontSize: '0.78rem',
                textTransform: 'none',
                fontWeight: 500,
                py: 0,
              },
              '& .MuiTabs-indicator': {
                bgcolor: c.accent.primary,
              },
            }}
          >
            <Tab label="Preview" value={TAB_PREVIEW} />
            <Tab label="Code" value={TAB_CODE} />
            <Tab label="Terminal" value={TAB_TERMINAL} />
          </Tabs>
          {activeTab === TAB_PREVIEW && (
            <Tooltip title="Reload preview · right-click for Hard Reload">
              <IconButton
                size="small"
                onClick={() => previewRef.current?.reload()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setReloadMenuAnchor(e.currentTarget as HTMLElement);
                }}
                sx={{ mr: 1, color: c.text.muted }}
              >
                <RefreshIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
          <Menu
            anchorEl={reloadMenuAnchor}
            open={!!reloadMenuAnchor}
            onClose={() => setReloadMenuAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <MenuItem onClick={handleHardReload} dense>
              <ListItemIcon>
                <RestartAltIcon sx={{ fontSize: 18 }} />
              </ListItemIcon>
              <ListItemText
                primary="Reset & Hard Reload"
                secondary="Restart backend.py + reload preview"
                primaryTypographyProps={{ fontSize: '0.82rem', fontWeight: 500 }}
                secondaryTypographyProps={{ fontSize: '0.7rem', color: c.text.ghost }}
              />
            </MenuItem>
          </Menu>
        </Box>

        {/* Tab content */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {activeTab === TAB_PREVIEW && (
            showInstallPlaceholder ? (
              <Box
                sx={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1.5,
                  bgcolor: c.bg.surface,
                  p: 3,
                  textAlign: 'center',
                }}
              >
                <CircularProgress size={28} sx={{ color: c.accent.primary }} />
                <Typography sx={{ color: c.text.primary, fontSize: '0.95rem', fontWeight: 600 }}>
                  Installing dependencies…
                </Typography>
                <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem', maxWidth: 420, lineHeight: 1.5 }}>
                  Cold start can take 60–90 seconds. Check the <b>Terminal</b> tab to follow{' '}
                  npm install + Vite startup output. The preview will appear here automatically{' '}
                  once Vite is ready.
                </Typography>
              </Box>
            ) : (
              <ViewPreview
                ref={previewRef}
                serveUrl={workspaceServeUrl}
                frontendCode={!workspaceServeUrl ? (files['index.html'] ?? '') : undefined}
                inputData={testInput}
                backendResult={null}
                onConsoleMessage={handleWebviewConsole}
              />
            )
          )}
          {activeTab === TAB_CODE && (
            <Box sx={{ display: 'flex', height: '100%' }}>
              {/* File tree sidebar */}
              <Box
                sx={{
                  width: 200,
                  flexShrink: 0,
                  borderRight: `1px solid ${c.border.subtle}`,
                  bgcolor: c.bg.secondary,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.5 }}>
                  <Typography
                    sx={{
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      color: c.text.muted,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      flex: 1,
                    }}
                  >
                    Files
                  </Typography>
                  <Tooltip title="New file" placement="top">
                    <IconButton
                      size="small"
                      onClick={() => setShowNewFileInput(true)}
                      sx={{ p: 0.25, color: c.text.ghost, '&:hover': { color: c.accent.primary } }}
                    >
                      <AddIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>

                <Box sx={{ flex: 1, overflow: 'auto', py: 0.25 }}>
                  {fileTree.map((node) => (
                    <FileTreeItem
                      key={node.path}
                      node={node}
                      depth={0}
                      activeFile={activeFile}
                      onSelect={setActiveFile}
                      onDelete={deleteFile}
                      c={c}
                    />
                  ))}
                  {filePaths.length === 0 && (
                    <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, px: 1.5, py: 1 }}>
                      No files yet
                    </Typography>
                  )}
                </Box>

                {showNewFileInput && (
                  <Box
                    sx={{
                      px: 1,
                      py: 0.75,
                      borderTop: `1px solid ${c.border.subtle}`,
                      bgcolor: c.bg.elevated,
                    }}
                  >
                    <TextField
                      inputRef={newFileInputRef}
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { addFile(newFileName); }
                        if (e.key === 'Escape') { setShowNewFileInput(false); setNewFileName(''); }
                      }}
                      onBlur={() => {
                        if (newFileName.trim()) { addFile(newFileName); }
                        else { setShowNewFileInput(false); setNewFileName(''); }
                      }}
                      placeholder="path/to/file.js"
                      variant="standard"
                      fullWidth
                      autoFocus
                      sx={{
                        '& .MuiInput-input': {
                          fontSize: '0.74rem',
                          fontFamily: c.font.mono,
                          color: c.text.primary,
                          py: 0.25,
                        },
                        '& .MuiInput-underline:before': { borderColor: c.border.subtle },
                        '& .MuiInput-underline:after': { borderColor: c.accent.primary },
                      }}
                    />
                  </Box>
                )}
              </Box>
              {/* Editor area */}
              <Box sx={{ flex: 1, overflow: 'hidden' }}>
                {activeFile && files[activeFile] != null ? (
                  <CodeEditor
                    key={activeFile}
                    value={activeFileContent}
                    onChange={(val) => updateFile(activeFile, val)}
                    language={getEditorLanguage(activeFile)}
                    placeholder={`// ${activeFile}`}
                  />
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <Typography sx={{ color: c.text.ghost, fontSize: '0.85rem' }}>
                      Select a file to edit
                    </Typography>
                  </Box>
                )}
              </Box>
            </Box>
          )}
          {activeTab === TAB_TERMINAL && (
            <TerminalPanel lines={terminalLines} />
          )}
        </Box>
      </Box>
    </Box>
    </ElementSelectionProvider>
  );
};

export default ViewEditor;
