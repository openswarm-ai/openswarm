import React, { useState, useMemo, useEffect, useRef, useCallback, PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import PixelBlast from '@/app/components/PixelBlast';
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
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import Collapse from '@mui/material/Collapse';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, removeDraftSession, fetchSession } from '@/shared/state/agentsSlice';
import { createOutput, updateOutput, fetchOutputs, Output, SERVE_BASE } from '@/shared/state/outputsSlice';
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

// Cold-start splash: same Bayer-dither shader as the template's index.html for visual continuity across boot phases.
const InstallPlaceholder: React.FC = () => {
  const c = useClaudeTokens();
  return (
    <Box sx={{ position: 'absolute', inset: 0, bgcolor: '#1a1a1a', overflow: 'hidden' }}>
      <PixelBlast color={c.accent.primary} pixelSize={4} speed={0.5} edgeFade={0.3} />
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          pointerEvents: 'none',
          textAlign: 'center',
          px: 3,
        }}
      >
        <Typography
          sx={{
            fontFamily: 'Charter, Georgia, serif',
            fontSize: '2rem',
            fontWeight: 500,
            color: '#f5f5f5',
            letterSpacing: '-0.02em',
            textShadow: '0 2px 24px rgba(26, 26, 26, 0.8)',
          }}
        >
          What're we brewing?
        </Typography>
        <Typography
          sx={{
            fontSize: '0.9rem',
            color: '#b8b8b8',
            maxWidth: 420,
            lineHeight: 1.55,
            textShadow: '0 2px 24px rgba(26, 26, 26, 0.8)',
          }}
        >
          Drop the recipe below. I'll handle the rest.
        </Typography>
      </Box>
    </Box>
  );
};

// File-tree noise: filtered by basename anywhere in the path; `showHidden` bypasses.
const HIDDEN_PATH_SEGMENTS = new Set<string>([
  'node_modules',
  '.vite-cache',
  '.vite',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.venv',
]);
// Poll fast while agent is writing; slow while idle. A one-shot poll fires on active->idle transition to catch the last write.
const POLL_INTERVAL_ACTIVE_MS = 2000;
const POLL_INTERVAL_IDLE_MS = 15000;

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
  const navigate = useNavigate();

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
  const [showHidden, setShowHidden] = useState(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only reload the iframe when index.html actually changed AND the agent has paused writing for 600ms; saves to SKILL.md etc don't flash the preview.
  const previewReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReloadedIndexHtmlRef = useRef<string>(initialFiles['index.html'] ?? '');
  const PREVIEW_RELOAD_DEBOUNCE_MS = 600;
  const savingRef = useRef(false);
  // Runtime WS feeds backend stdout/stderr; webview-preload ipc-message feeds frontend console.* into the same chronological buffer.
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const terminalLineIdRef = useRef(0);
  const TERMINAL_BUFFER_CAP = 5000; // trim FIFO past this so we don't grow unbounded

  const previewRef = useRef<ViewPreviewHandle>(null);
  // True ~300ms after iframe `load`; keeps placeholder up until SPA actually paints, resets on URL change.
  const [iframePainted, setIframePainted] = useState(false);

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
  // Reuse the Output's workspace_id across remounts so we don't orphan agent edits or chat history.
  const [stableWorkspaceId] = useState(() => output?.workspace_id || `ws-${Date.now().toString(36)}`);
  const draftCreated = useRef(false);

  // Honor Settings default_model + default_thinking_level (else createDraftSession's hardcoded 'sonnet' wins).
  const defaultModel = useAppSelector((s) => s.settings.data.default_model);
  const defaultThinkingLevel = useAppSelector((s) => s.settings.data.default_thinking_level);
  const settingsLoaded = useAppSelector((s) => s.settings.loaded);
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);

  useEffect(() => {
    if (draftCreated.current) return;
    // Wait for settings + models else we'd snapshot Redux's initial 'sonnet' over the user's choice.
    if (!settingsLoaded || !modelsLoaded) return;
    draftCreated.current = true;

    // Provider map mirrors ChatInput.tsx grouping.
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
      // Reattach: Output has an existing session + workspace; skip seeding/draft so we don't clobber agent state.
      if (output?.session_id && output?.workspace_id) {
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

        // Verify session still exists; ids go stale across reinstalls/data wipes and AgentChat would hang on "Initializing agent..."
        let sessionStillExists = false;
        try {
          const sr = await fetch(`${API_BASE}/agents/sessions/${output.session_id}`);
          sessionStillExists = sr.ok;
        } catch { /* network blip, treat as missing */ }

        if (sessionStillExists) {
          // Catch up on anything the agent did while we were on another tab.
          dispatch(fetchSession(output.session_id));
          setInitialDraftId(output.session_id);
          return;
        }

        // Stale link: clear it so future opens skip the 404 round-trip, then fall through.
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
        // Adopt the backend-minted output_id so the Apps sidebar shows the app and later autosaves hit updateOutput.
        if (typeof data?.output_id === 'string' && data.output_id) {
          createdIdRef.current = data.output_id;
          setCreatedId(data.output_id);
          dispatch(fetchOutputs());
          // CRITICAL: use window.history.replaceState, NOT navigate(). Views.tsx keys ViewEditor on output id; React Router would unmount/remount, the onboarding wizard would type into a detached input and burn 15s on waitForSelector.
          if (window.location.hash.includes('/apps/new')) {
            const newHash = window.location.hash.replace(
              '/apps/new',
              `/apps/${data.output_id}`,
            );
            try {
              window.history.replaceState(null, '', newHash);
            } catch {
              // Defensive: history API rejection accepts the remount cost rather than dropping the URL update.
              navigate(`/apps/${data.output_id}`, { replace: true });
            }
          }
        }
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

  // Resolve via our own pointers only; falling back to activeSessionId bled unrelated agents' chats into the wrong builder.
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

  // Promote draftId to the real session id so we survive draftLaunchMap cleanup.
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
    const interval = isAgentActive ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;

    // Visibility-gate the poll so a hidden tab doesn't keep hammering /api/outputs/workspace and starving the foreground.
    const startPoll = () => {
      if (pollRef.current) return;
      pollWorkspace();
      pollRef.current = setInterval(pollWorkspace, interval);
    };
    const stopPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') startPoll();
      else stopPoll();
    };

    if (document.visibilityState === 'visible') startPoll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopPoll();
    };
  }, [workspaceId, pollWorkspace, isAgentActive]);

  const prevAgentActive = useRef(false);
  useEffect(() => {
    if (prevAgentActive.current && !isAgentActive && workspaceId) {
      setTimeout(pollWorkspace, 500);
    }
    prevAgentActive.current = isAgentActive;
  }, [isAgentActive, workspaceId, pollWorkspace]);

  // Ref so the unmount cleanup reads the live status, not a stale closure value.
  const sessionStatusRef = useRef<string | null>(null);
  sessionStatusRef.current = agentStatus;
  const isLaunchedRef = useRef(false);
  isLaunchedRef.current = isLaunched;

  useEffect(() => {
    return () => {
      // GC only abandoned drafts; launched sessions live on the backend independently.
      if (initialDraftId && sessionStatusRef.current === 'draft' && !isLaunchedRef.current) {
        dispatch(removeDraftSession(initialDraftId));
      }
    };
  }, [initialDraftId, dispatch]);

  // Persist session_id + workspace_id on draft->launched so reopens find the in-progress session; deduped via ref since `output` prop is a stale snapshot.
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
        // Step 8 onboarding waits on this; only fires on first create.
        onboardingBus.emit('app:generation_done');
      }
      savedRef.current = true;
      // Reload iframe only when agent has paused AND index.html actually changed; skips "Ready" flash on non-rendered writes.
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
      // FIFO trim: drop the ancient head past TERMINAL_BUFFER_CAP.
      if (next.length > TERMINAL_BUFFER_CAP) {
        return next.slice(next.length - TERMINAL_BUFFER_CAP);
      }
      return next;
    });
  }, []);

  const handleWebviewConsole = useCallback((level: string, text: string) => {
    appendTerminalLine('frontend', level, text);
  }, [appendTerminalLine]);

  // Right-click adds Hard Reload (also restarts the backend subprocess for Python-error recovery).
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

  // Runtime lifecycle: /runtime/start, stream stdout/stderr + frontend_url via WS, /runtime/stop on unmount (ref-counted server-side).
  const runtimeWsRef = useRef<WebSocket | null>(null);
  // New-mode workspaces report frontend_url via runtime:status; fall back to the legacy /serve/ endpoint until it arrives.
  const [frontendUrl, setFrontendUrl] = useState<string | null>(null);
  // Track new-mode separately so we can show "Installing..." instead of loading the 404ing legacy /serve/index.html.
  const [isNewModeRuntime, setIsNewModeRuntime] = useState(false);
  // Latched: only flips true (resets on workspace change). Must be state, not a ref, so the lifecycle effect's deps react to it without depending on activeTab (caused tear-down on tab switch).
  const [runtimeShouldRun, setRuntimeShouldRun] = useState(false);
  useEffect(() => {
    setRuntimeShouldRun(false);
  }, [workspaceId]);

  // Two effects so tab switches don't tear down the runtime; depending on activeTab here caused cleanup-on-switch which 404'd the iframe.
  useEffect(() => {
    if (!workspaceId || !runtimeShouldRun) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    setFrontendUrl(null);
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
  }, [workspaceId, runtimeShouldRun, appendTerminalLine]);

  // One-shot trigger: first visit to Preview/Terminal flips runtimeShouldRun true; never flips back.
  useEffect(() => {
    if (!workspaceId) return;
    if (runtimeShouldRun) return;
    const wantsRuntime = activeTab === TAB_PREVIEW || activeTab === TAB_TERMINAL;
    if (!wantsRuntime) return;
    setRuntimeShouldRun(true);
  }, [workspaceId, activeTab, runtimeShouldRun, TAB_PREVIEW, TAB_TERMINAL]);

  // Prefer the Vite dev server URL; fall back to legacy /serve/. New-mode pre-Vite renders the install placeholder (legacy URL 404s).
  const showInstallPlaceholder = isNewModeRuntime && !frontendUrl;
  const workspaceServeUrl = showInstallPlaceholder
    ? undefined
    : (frontendUrl ?? (workspaceId ? `${SERVE_BASE}/workspace/${workspaceId}/serve/index.html` : undefined));

  // Reset paint tracking on URL change so the placeholder stays up for the new load.
  useEffect(() => {
    setIframePainted(false);
  }, [workspaceServeUrl]);

  // 300ms after iframe `load` because SPA bundles need a beat to mount, otherwise the grey flash returns.
  const onIframeContentLoad = useCallback(() => {
    const t = window.setTimeout(() => setIframePainted(true), 300);
    return () => window.clearTimeout(t);
  }, []);

  // Keep PixelBlast mounted across transient gate flips; unmounting rebuilds the GL context and the user reads it as the animation restarting.
  const placeholderVisible = showInstallPlaceholder || !iframePainted;
  const [placeholderMounted, setPlaceholderMounted] = useState(placeholderVisible);
  useEffect(() => {
    if (placeholderVisible) {
      setPlaceholderMounted(true);
      return undefined;
    }
    const t = window.setTimeout(() => setPlaceholderMounted(false), 400);
    return () => window.clearTimeout(t);
  }, [placeholderVisible]);

  // VSCode-style files.exclude predicate; single source of truth for list/tree/open-file routing.
  const isHiddenPath = useCallback((p: string): boolean => {
    if (showHidden) return false;
    const segments = p.split('/');
    for (const seg of segments) {
      if (HIDDEN_PATH_SEGMENTS.has(seg)) return true;
    }
    return false;
  }, [showHidden]);

  const filePaths = useMemo(
    () =>
      Object.keys(files)
        .filter((p) => p !== 'meta.json' && p !== 'SKILL.md')
        .filter((p) => !isHiddenPath(p))
        .sort(),
    [files, isHiddenPath],
  );
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
      {/* Left panel: AgentChat */}
      <Box
        // Scope name pins onboarding step 8's selectors to this AgentChat instance, not whatever was last in DOM order.
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
          // 6px hit-target overlapped via negative margins so it doesn't take a visible column (same as AppShell sidebar handle).
          width: 6,
          marginLeft: '-3px',
          marginRight: '-3px',
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
            // Invisible at rest; otherwise the border line forms a T-junction with the chat header.
            bgcolor: 'transparent',
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
            alignItems: 'baseline',
            gap: 2,
            px: 1.5,
            py: 1,
            bgcolor: c.bg.secondary,
            // Hairline separates the meta strip from the tabs row.
            borderBottom: `0.5px solid ${c.border.subtle}`,
            flexShrink: 0,
            minHeight: 48,
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
              '& .MuiInput-input': {
                fontSize: '0.9rem',
                fontWeight: 600,
                color: c.text.primary,
                py: 0.25,
              },
              '& .MuiInput-underline:before': { borderColor: 'transparent' },
              '& .MuiInput-underline:hover:before': { borderColor: c.border.medium },
            }}
          />

          <TextField
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            variant="standard"
            sx={{
              flex: 2,
              '& .MuiInput-input': {
                fontSize: '0.82rem',
                color: c.text.muted,
                // Match the App-name input's padding so baselines align.
                py: 0.25,
              },
              '& .MuiInput-underline:before': { borderColor: 'transparent' },
              '& .MuiInput-underline:hover:before': { borderColor: c.border.medium },
            }}
          />

        </Box>

        {/* Tab bar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            // No borderBottom; bg-color step carries the separation.
            bgcolor: c.bg.secondary,
            flexShrink: 0,
            px: 1.25,
            py: 1,
          }}
        >
          <Tabs
            value={activeTab}
            onChange={(_, v) => setActiveTab(v)}
            // No underline indicator; active state is bg-fill pills.
            TabIndicatorProps={{ sx: { display: 'none' } }}
            sx={{
              flex: 1,
              minHeight: 32,
              '& .MuiTabs-flexContainer': {
                gap: 0.5,
              },
              '& .MuiTab-root': {
                minHeight: 32,
                minWidth: 'auto',
                fontSize: '0.8rem',
                textTransform: 'none',
                // One weight across states; bumping on select widens glyphs and shifts the whole row.
                fontWeight: 600,
                color: c.text.tertiary,
                px: 1.75,
                py: 0,
                borderRadius: 999,
                transition: c.transition,
                '&:hover': {
                  color: c.text.secondary,
                  bgcolor: `${c.text.primary}06`,
                },
                '&.Mui-selected': {
                  color: c.text.primary,
                  bgcolor: c.bg.elevated,
                },
              },
            }}
          >
            <Tab disableRipple label="Preview" value={TAB_PREVIEW} />
            <Tab disableRipple label="Code" value={TAB_CODE} />
            <Tab disableRipple label="Terminal" value={TAB_TERMINAL} />
          </Tabs>
          {activeTab === TAB_PREVIEW && (
            <Tooltip title="Reload preview; right-click for Hard Reload">
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
            <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
              {/* Render iframe under the placeholder so its first paint completes before we fade the placeholder out. */}
              {(workspaceServeUrl || !showInstallPlaceholder) && (
                <ViewPreview
                  ref={previewRef}
                  serveUrl={workspaceServeUrl}
                  frontendCode={!workspaceServeUrl ? (files['index.html'] ?? '') : undefined}
                  inputData={testInput}
                  backendResult={null}
                  onConsoleMessage={handleWebviewConsole}
                  onContentLoad={onIframeContentLoad}
                />
              )}
              {/* Placeholder fades via opacity (never unmounts) so the PixelBlast canvas runs continuously. */}
              {placeholderMounted && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 5,
                    opacity: placeholderVisible ? 1 : 0,
                    transition: 'opacity 400ms ease',
                    pointerEvents: placeholderVisible ? 'auto' : 'none',
                  }}
                >
                  <InstallPlaceholder />
                </Box>
              )}
            </Box>
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
                  <Tooltip
                    title={showHidden ? 'Hide build/install dirs' : 'Show hidden (node_modules, .vite-cache, etc.)'}
                    placement="top"
                  >
                    <IconButton
                      size="small"
                      onClick={() => setShowHidden((v) => !v)}
                      sx={{ p: 0.25, color: c.text.ghost, '&:hover': { color: c.accent.primary } }}
                    >
                      {showHidden ? (
                        <VisibilityOffIcon sx={{ fontSize: 14 }} />
                      ) : (
                        <VisibilityIcon sx={{ fontSize: 14 }} />
                      )}
                    </IconButton>
                  </Tooltip>
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
