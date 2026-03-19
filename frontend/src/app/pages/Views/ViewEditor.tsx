import React, { useState, useMemo, useEffect, useRef, useCallback, PointerEvent as ReactPointerEvent } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Tooltip from '@mui/material/Tooltip';
import Switch from '@mui/material/Switch';
import CircularProgress from '@mui/material/CircularProgress';
import SaveIcon from '@mui/icons-material/Save';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import HtmlIcon from '@mui/icons-material/Code';
import PythonIcon from '@mui/icons-material/Terminal';
import SchemaIcon from '@mui/icons-material/DataObject';
import JsIcon from '@mui/icons-material/Javascript';
import CssIcon from '@mui/icons-material/Style';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import FolderIcon from '@mui/icons-material/Folder';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import BoltIcon from '@mui/icons-material/Bolt';
import Collapse from '@mui/material/Collapse';
import Chip from '@mui/material/Chip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, removeDraftSession, AgentMessage } from '@/shared/state/agentsSlice';
import { createOutput, updateOutput, Output, executeOutput, OutputExecuteResult, autoRunOutput, autoRunAgentOutput, cleanupAutoRunAgent, AutoRunConfig, SERVE_BASE } from '@/shared/state/outputsSlice';
import { createSessionWs } from '@/shared/ws/WebSocketManager';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import AgentChat from '../AgentChat/AgentChat';
import ChatInput, { ChatInputHandle } from '../AgentChat/ChatInput';
import RefreshIcon from '@mui/icons-material/Refresh';
import ViewPreview, { ViewPreviewHandle } from './ViewPreview';
import InputSchemaForm, { getDefault, getStubbed } from './InputSchemaForm';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CodeEditor from './CodeEditor';
import { ElementSelectionProvider } from '@/app/components/ElementSelectionContext';
import { captureViewThumbnail } from './captureViewThumbnail';
import { API_BASE } from '@/shared/config';

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

function getEditorLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'html': case 'htm': return 'html';
    case 'py': return 'python';
    case 'json': return 'json';
    case 'js': case 'jsx': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'css': case 'scss': return 'css';
    case 'md': return 'markdown';
    default: return 'plaintext';
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

interface LogEntryProps {
  msg: AgentMessage;
  c: ReturnType<typeof useClaudeTokens>;
}

const LogEntry: React.FC<LogEntryProps> = ({ msg, c }) => {
  const [open, setOpen] = useState(false);

  if (msg.role === 'user') return null;

  if (msg.role === 'assistant') {
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
        : JSON.stringify(msg.content);
    if (!text.trim()) return null;
    return (
      <Box sx={{ mb: 0.5 }}>
        <Box
          onClick={() => setOpen(!open)}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer', '&:hover': { opacity: 0.8 } }}
        >
          <ExpandMoreIcon sx={{ fontSize: 14, color: c.text.ghost, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '0.15s' }} />
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {text.slice(0, 120)}{text.length > 120 ? '…' : ''}
          </Typography>
        </Box>
        <Collapse in={open}>
          <Typography sx={{ fontSize: '0.72rem', color: c.text.secondary, whiteSpace: 'pre-wrap', pl: 2.5, pt: 0.5, fontFamily: c.font.mono, lineHeight: 1.5 }}>
            {text}
          </Typography>
        </Collapse>
      </Box>
    );
  }

  if (msg.role === 'tool_call') {
    const tc = typeof msg.content === 'object' ? msg.content as Record<string, any> : {};
    return (
      <Box sx={{ mb: 0.5 }}>
        <Box
          onClick={() => setOpen(!open)}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer', '&:hover': { opacity: 0.8 } }}
        >
          <ExpandMoreIcon sx={{ fontSize: 14, color: c.text.ghost, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '0.15s' }} />
          <Chip
            label={tc.tool || 'tool'}
            size="small"
            sx={{ height: 18, fontSize: '0.68rem', fontWeight: 600, fontFamily: c.font.mono, bgcolor: c.accent.primary + '20', color: c.accent.primary }}
          />
          {tc.input && (
            <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, ml: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {JSON.stringify(tc.input).slice(0, 80)}…
            </Typography>
          )}
        </Box>
        <Collapse in={open}>
          <Box sx={{ pl: 2.5, pt: 0.5 }}>
            <Typography component="pre" sx={{ fontSize: '0.68rem', color: c.text.secondary, fontFamily: c.font.mono, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(tc.input, null, 2)}
            </Typography>
          </Box>
        </Collapse>
      </Box>
    );
  }

  if (msg.role === 'tool_result') {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return (
      <Box sx={{ mb: 0.5 }}>
        <Box
          onClick={() => setOpen(!open)}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, cursor: 'pointer', '&:hover': { opacity: 0.8 } }}
        >
          <ExpandMoreIcon sx={{ fontSize: 14, color: c.text.ghost, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '0.15s' }} />
          <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost }}>
            result ({content.length > 60 ? `${content.length} chars` : content.slice(0, 60)})
          </Typography>
        </Box>
        <Collapse in={open}>
          <Typography component="pre" sx={{ fontSize: '0.68rem', color: c.text.secondary, fontFamily: c.font.mono, whiteSpace: 'pre-wrap', pl: 2.5, pt: 0.5, maxHeight: 200, overflow: 'auto' }}>
            {content}
          </Typography>
        </Collapse>
      </Box>
    );
  }

  if (msg.role === 'system') {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return (
      <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, fontStyle: 'italic', mb: 0.5 }}>
        {text}
      </Typography>
    );
  }

  return null;
};

interface AutoRunLogProps {
  messages: AgentMessage[];
  status: string | null;
  logEndRef: React.RefObject<HTMLDivElement | null>;
  c: ReturnType<typeof useClaudeTokens>;
}

const AutoRunLog: React.FC<AutoRunLogProps> = ({ messages, status, logEndRef, c }) => {
  const isRunning = status === 'running' || status === 'waiting_approval';
  const isDone = status === 'completed' || status === 'stopped';
  const isError = status === 'error';

  return (
    <Box sx={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      border: `1px solid ${c.border.subtle}`,
      borderRadius: 1,
      overflow: 'hidden',
    }}>
      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 0.75,
        bgcolor: c.bg.secondary,
        borderBottom: `1px solid ${c.border.subtle}`,
        flexShrink: 0,
      }}>
        {isRunning && <CircularProgress size={12} sx={{ color: '#f59e0b' }} />}
        {isDone && <CheckCircleOutlineIcon sx={{ fontSize: 14, color: c.accent.primary }} />}
        {isError && <ErrorOutlineIcon sx={{ fontSize: 14, color: '#ef4444' }} />}
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.muted }}>
          {isRunning ? 'Agent running…' : isDone ? 'Agent completed' : isError ? 'Agent error' : 'Execution log'}
        </Typography>
        <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, ml: 'auto' }}>
          {messages.length} messages
        </Typography>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 1 }}>
        {messages.map((msg) => (
          <LogEntry key={msg.id} msg={msg} c={c} />
        ))}
        <div ref={logEndRef} />
      </Box>
    </Box>
  );
};

interface ConsoleEntry {
  timestamp: number;
  inputData: Record<string, any>;
  stdout: string | null;
  stderr: string | null;
  backendResult: Record<string, any> | null;
  error: string | null;
  source: string;
  running?: boolean;
}

interface ConsolePanelProps {
  entry: ConsoleEntry | null;
  c: ReturnType<typeof useClaudeTokens>;
}

const ConsolePanel: React.FC<ConsolePanelProps> = ({ entry, c }) => {
  const sectionSx = { mb: 2 };
  const labelBase = { fontSize: '0.7rem' as const, fontWeight: 600, fontFamily: c.font.mono, mb: 0.5 };
  const codeBoxSx = { bgcolor: '#161b22', borderRadius: 1, p: 1.5, border: '1px solid #21262d' };
  const preStyle = { fontSize: '0.72rem', fontFamily: c.font.mono, color: '#c9d1d9', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, m: 0 };

  if (!entry) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1, bgcolor: '#0d1117' }}>
        <Typography sx={{ fontFamily: c.font.mono, fontSize: '2rem', color: '#21262d', fontWeight: 700 }}>{'>_'}</Typography>
        <Typography sx={{ color: '#8b949e', fontSize: '0.82rem' }}>No execution output yet</Typography>
        <Typography sx={{ color: '#484f58', fontSize: '0.75rem' }}>Run the backend to see results here</Typography>
      </Box>
    );
  }

  if (entry.running) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1.5, bgcolor: '#0d1117' }}>
        <CircularProgress size={24} sx={{ color: '#58a6ff' }} />
        <Typography sx={{ color: '#8b949e', fontSize: '0.82rem', fontFamily: c.font.mono }}>Executing backend…</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100%', bgcolor: '#0d1117', overflow: 'auto' }}>
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, pb: 1.5, borderBottom: '1px solid #21262d' }}>
          <Typography sx={{ fontSize: '0.72rem', fontFamily: c.font.mono, color: '#8b949e' }}>
            {new Date(entry.timestamp).toLocaleTimeString()}
          </Typography>
          <Chip label={entry.source} size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 600, bgcolor: '#1f6feb20', color: '#58a6ff', fontFamily: c.font.mono }} />
          {entry.error && (
            <Chip label="ERROR" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700, bgcolor: '#f8717120', color: '#f87171', fontFamily: c.font.mono }} />
          )}
        </Box>

        <Box sx={sectionSx}>
          <Typography sx={{ ...labelBase, color: '#60a5fa' }}>▸ Input Data</Typography>
          <Box sx={codeBoxSx}>
            <Typography component="pre" sx={preStyle}>{JSON.stringify(entry.inputData, null, 2)}</Typography>
          </Box>
        </Box>

        {entry.stdout && (
          <Box sx={sectionSx}>
            <Typography sx={{ ...labelBase, color: '#4ade80' }}>▸ stdout</Typography>
            <Box sx={codeBoxSx}>
              <Typography component="pre" sx={preStyle}>{entry.stdout}</Typography>
            </Box>
          </Box>
        )}

        {entry.stderr && (
          <Box sx={sectionSx}>
            <Typography sx={{ ...labelBase, color: '#fbbf24' }}>▸ stderr</Typography>
            <Box sx={codeBoxSx}>
              <Typography component="pre" sx={preStyle}>{entry.stderr}</Typography>
            </Box>
          </Box>
        )}

        {entry.backendResult && (
          <Box sx={sectionSx}>
            <Typography sx={{ ...labelBase, color: '#a78bfa' }}>▸ Result</Typography>
            <Box sx={codeBoxSx}>
              <Typography component="pre" sx={preStyle}>{JSON.stringify(entry.backendResult, null, 2)}</Typography>
            </Box>
          </Box>
        )}

        {entry.error && (
          <Box sx={sectionSx}>
            <Typography sx={{ ...labelBase, color: '#f87171' }}>✗ Error</Typography>
            <Box sx={{ bgcolor: '#f8717110', borderRadius: 1, p: 1.5, border: '1px solid #f8717130' }}>
              <Typography component="pre" sx={{ ...preStyle, color: '#fca5a5' }}>{entry.error}</Typography>
            </Box>
          </Box>
        )}

        {!entry.stdout && !entry.stderr && !entry.backendResult && !entry.error && (
          <Typography sx={{ fontSize: '0.75rem', color: '#8b949e', fontFamily: c.font.mono }}>
            No backend code to execute. Only input data was sent to the app.
          </Typography>
        )}
      </Box>
    </Box>
  );
};

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

const ViewEditor: React.FC<Props> = ({ output, onClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();

  const [createdId, setCreatedId] = useState<string | null>(null);
  const createdIdRef = useRef<string | null>(null);
  const effectiveId = output?.id ?? createdId;
  const isNew = !effectiveId;

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
  const TAB_TEST_INPUT = 2;
  const TAB_AUTO_RUN = 3;
  const TAB_CONSOLE = 4;

  const [activeTab, setActiveTab] = useState(TAB_PREVIEW);
  const [activeFile, setActiveFile] = useState('index.html');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'unsaved' | 'saving' | 'saved'>('idle');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const [executeResult, setExecuteResult] = useState<OutputExecuteResult | null>(null);
  const [showConsole, setShowConsole] = useState(false);
  const [consoleEntry, setConsoleEntry] = useState<ConsoleEntry | null>(null);
  const [hasNewConsoleOutput, setHasNewConsoleOutput] = useState(false);

  const savedAutoRun = output?.auto_run_config;
  const [autoRunEnabled, setAutoRunEnabled] = useState(savedAutoRun?.enabled ?? false);
  const [autoRunMode, setAutoRunMode] = useState(savedAutoRun?.mode ?? 'agent');
  const [autoRunModel, setAutoRunModel] = useState(savedAutoRun?.model ?? 'sonnet');
  const [autoRunning, setAutoRunning] = useState(false);
  const autoRunInputRef = useRef<ChatInputHandle>(null);
  const autoRunInitialized = useRef(false);
  const previewRef = useRef<ViewPreviewHandle>(null);

  const [autoRunSessionId, setAutoRunSessionId] = useState<string | null>(null);
  const autoRunWsRef = useRef<ReturnType<typeof createSessionWs> | null>(null);
  const autoRunLogEndRef = useRef<HTMLDivElement>(null);

  const autoRunSession = useAppSelector((state) =>
    autoRunSessionId ? state.agents.sessions[autoRunSessionId] : null
  );
  const autoRunMessages = autoRunSession?.messages ?? [];
  const autoRunSessionStatus = autoRunSession?.status ?? null;

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
  const [stableWorkspaceId] = useState(() => `ws-${Date.now().toString(36)}`);
  const draftCreated = useRef(false);

  useEffect(() => {
    if (draftCreated.current) return;
    draftCreated.current = true;

    (async () => {
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
        }));
        setInitialDraftId(action.payload.draftId);
      } catch {
        const action = dispatch(createDraftSession({ mode: 'view-builder', setActive: false }));
        setInitialDraftId(action.payload.draftId);
      }
    })();
  }, [dispatch, output, stableWorkspaceId]);

  const effectiveSessionId = useAppSelector((state) => {
    if (!initialDraftId) return null;
    if (state.agents.sessions[initialDraftId]) return initialDraftId;
    return state.agents.activeSessionId;
  });

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

  useEffect(() => {
    return () => {
      if (initialDraftId) {
        dispatch(removeDraftSession(initialDraftId));
      }
    };
  }, [initialDraftId, dispatch]);

  const schemaText = files['schema.json'] ?? '{"type":"object","properties":{},"required":[]}';

  const parsedSchema = useMemo(() => {
    try { return JSON.parse(schemaText); } catch { return { type: 'object', properties: {} }; }
  }, [schemaText]);

  const testInputDefault = useMemo(() => getDefault(parsedSchema), [parsedSchema]);
  const [testInput, setTestInput] = useState<Record<string, any>>(testInputDefault);

  useEffect(() => {
    setTestInput(getDefault(parsedSchema));
  }, [schemaText]);

  useEffect(() => {
    if (autoRunInitialized.current || !savedAutoRun) return;
    if (!autoRunEnabled) return;
    autoRunInitialized.current = true;
    const timer = setTimeout(() => {
      autoRunInputRef.current?.setContent(
        savedAutoRun.prompt || '',
        savedAutoRun.context_paths?.map((cp) => ({ path: cp.path, type: (cp.type as 'file' | 'directory') || 'file' })),
        savedAutoRun.forced_tools,
      );
    }, 100);
    return () => clearTimeout(timer);
  }, [savedAutoRun, autoRunEnabled]);

  const savedRef = useRef(!!output);

  const getAutoRunConfig = (): AutoRunConfig => {
    const config = autoRunInputRef.current?.getConfig();
    return {
      enabled: autoRunEnabled,
      prompt: config?.prompt ?? '',
      context_paths: config?.contextPaths?.map((cp) => ({ path: cp.path, type: cp.type })) ?? [],
      forced_tools: (config?.forcedTools ?? []).map(({ label, tools, iconKey }) => ({ label, tools, iconKey })),
      mode: autoRunMode,
      model: autoRunModel,
    };
  };

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
      auto_run_config: getAutoRunConfig(),
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

  const performSaveRef = useRef<((close: boolean) => Promise<void>) | null>(null);

  performSaveRef.current = async (close: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveStatus('saving');
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
      }
      savedRef.current = true;
      setSaveStatus('saved');
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
      savedStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      if (close) onClose();
      else previewRef.current?.reload();
      captureThumbnailAsync(savedId);
    } catch (err: any) {
      console.error('Failed to save output:', err);
      setSaveStatus('unsaved');
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const handleSave = async (close = true) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    await performSaveRef.current?.(close);
  };

  const handleRunPreview = async () => {
    const eid = output?.id ?? createdIdRef.current;
    if (!eid) {
      setExecuteResult(null);
      return;
    }
    setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: null, stderr: null, backendResult: null, error: null, source: 'execute', running: true });
    setHasNewConsoleOutput(true);
    try {
      const res = await dispatch(
        executeOutput({ output_id: eid, input_data: testInput })
      ).unwrap();
      setExecuteResult(res);
      setConsoleEntry({ timestamp: Date.now(), inputData: res.input_data, stdout: res.stdout ?? null, stderr: res.stderr ?? null, backendResult: res.backend_result, error: res.error, source: 'execute' });
    } catch (e: any) {
      setConsoleEntry({ timestamp: Date.now(), inputData: testInput, stdout: null, stderr: null, backendResult: null, error: e?.message || 'Execution failed', source: 'execute' });
    }
  };

  const handleAutoRun = async () => {
    const config = autoRunInputRef.current?.getConfig();
    if (!config?.prompt?.trim()) return;
    setAutoRunning(true);

    let schema: Record<string, any>;
    try { schema = JSON.parse(schemaText); } catch { schema = { type: 'object', properties: {} }; }
    const forcedToolNames = config.forcedTools.flatMap((ft) => ft.tools);

    const eid = output?.id ?? createdIdRef.current;
    if (forcedToolNames.length > 0 && eid) {
      try {
        const res = await dispatch(autoRunAgentOutput({
          prompt: config.prompt,
          input_schema: schema,
          output_id: eid,
          model: autoRunModel,
          forced_tools: forcedToolNames,
          context_paths: config.contextPaths.map((cp) => ({ path: cp.path, type: cp.type })),
        })).unwrap();
        setAutoRunSessionId(res.session_id);
        const ws = createSessionWs(res.session_id);
        ws.connect();
        autoRunWsRef.current = ws;
      } catch {
        setAutoRunning(false);
      }
    } else {
      try {
        const backendCode = files['backend.py'] ?? null;
        const res = await dispatch(autoRunOutput({
          prompt: config.prompt,
          input_schema: schema,
          backend_code: backendCode || undefined,
          context_paths: config.contextPaths.map((cp) => ({ path: cp.path, type: cp.type })),
          forced_tools: forcedToolNames.length > 0 ? forcedToolNames : undefined,
          model: autoRunModel,
        })).unwrap();
        if (res.input_data) {
          setTestInput(res.input_data);
          setExecuteResult({
            output_id: output?.id ?? createdIdRef.current ?? '',
            output_name: name,
            frontend_code: files['index.html'] ?? '',
            input_data: res.input_data,
            backend_result: res.backend_result,
            stdout: res.stdout ?? null,
            stderr: res.stderr ?? null,
            error: res.error,
          });
          setConsoleEntry({ timestamp: Date.now(), inputData: res.input_data, stdout: res.stdout ?? null, stderr: res.stderr ?? null, backendResult: res.backend_result, error: res.error, source: 'auto-run' });
          setHasNewConsoleOutput(true);
          setActiveTab(TAB_PREVIEW);
        }
      } catch {}
      setAutoRunning(false);
    }
  };

  useEffect(() => {
    if (!autoRunSessionId || !autoRunSessionStatus) return;
    if (autoRunSessionStatus !== 'completed' && autoRunSessionStatus !== 'error' && autoRunSessionStatus !== 'stopped') return;

    let extracted = false;
    for (const msg of autoRunMessages) {
      if (msg.role !== 'tool_call' || typeof msg.content !== 'object') continue;
      const tc = msg.content as { tool?: string; input?: Record<string, any> };
      if (tc.tool !== 'RenderOutput' || !tc.input?.input_data) continue;
      setTestInput(tc.input.input_data);
      setExecuteResult({
        output_id: output?.id ?? createdIdRef.current ?? '',
        output_name: name,
        frontend_code: files['index.html'] ?? '',
        input_data: tc.input.input_data,
        backend_result: null,
        stdout: null,
        stderr: null,
        error: null,
      });
      setConsoleEntry({ timestamp: Date.now(), inputData: tc.input.input_data, stdout: null, stderr: null, backendResult: null, error: null, source: 'agent' });
      setHasNewConsoleOutput(true);
      setActiveTab(TAB_PREVIEW);
      extracted = true;
      break;
    }

    if (!extracted && autoRunSessionStatus === 'error') {
      const lastSys = [...autoRunMessages].reverse().find((m) => m.role === 'system');
      if (lastSys) {
        const errMsg = typeof lastSys.content === 'string' ? lastSys.content : JSON.stringify(lastSys.content);
        setExecuteResult({
          output_id: output?.id ?? createdIdRef.current ?? '',
          output_name: name,
          frontend_code: files['index.html'] ?? '',
          input_data: {},
          backend_result: null,
          stdout: null,
          stderr: null,
          error: errMsg,
        });
        setConsoleEntry({ timestamp: Date.now(), inputData: {}, stdout: null, stderr: null, backendResult: null, error: errMsg, source: 'agent' });
        setHasNewConsoleOutput(true);
      }
    }

    setAutoRunning(false);

    if (autoRunWsRef.current) {
      autoRunWsRef.current.disconnect();
      autoRunWsRef.current = null;
    }
    cleanupAutoRunAgent(autoRunSessionId).catch(() => {});
    setTimeout(() => setAutoRunSessionId(null), 300);
  }, [autoRunSessionId, autoRunSessionStatus]);

  useEffect(() => {
    autoRunLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [autoRunMessages.length]);

  useEffect(() => {
    return () => {
      if (autoRunWsRef.current) {
        autoRunWsRef.current.disconnect();
        autoRunWsRef.current = null;
      }
      if (autoRunSessionId) {
        cleanupAutoRunAgent(autoRunSessionId).catch(() => {});
      }
    };
  }, [autoRunSessionId]);

  const workspaceServeUrl = workspaceId
    ? `${SERVE_BASE}/workspace/${workspaceId}/serve/index.html`
    : undefined;

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
    if (!savingRef.current) {
      setSaveStatus('unsaved');
    }
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      performSaveRef.current?.(false);
    }, 1500);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [files, name, description, autoRunEnabled, autoRunMode, autoRunModel]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
      wsPushTimers.current.forEach(t => clearTimeout(t));
    };
  }, []);

  return (
    <ElementSelectionProvider>
    <Box sx={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      {/* Left panel — AgentChat */}
      <Box
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

          {autoRunEnabled && (
            <Button
              variant="outlined"
              startIcon={autoRunning ? <CircularProgress size={14} /> : <BoltIcon sx={{ fontSize: 16 }} />}
              onClick={handleAutoRun}
              disabled={autoRunning}
              size="small"
              sx={{
                borderColor: '#f59e0b40',
                color: '#f59e0b',
                textTransform: 'none',
                fontWeight: 500,
                fontSize: '0.8rem',
                px: 1.5,
                '&:hover': { borderColor: '#f59e0b', bgcolor: '#f59e0b10' },
              }}
            >
              {autoRunning ? 'Running…' : 'Auto Run'}
            </Button>
          )}
          {saveStatus === 'unsaved' && (
            <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, fontStyle: 'italic', whiteSpace: 'nowrap' }}>
              Unsaved changes
            </Typography>
          )}
          {saveStatus === 'saving' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <CircularProgress size={12} sx={{ color: c.text.ghost }} />
              <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, whiteSpace: 'nowrap' }}>
                Saving…
              </Typography>
            </Box>
          )}
          {saveStatus === 'saved' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <CheckCircleOutlineIcon sx={{ fontSize: 14, color: c.accent.primary }} />
              <Typography sx={{ fontSize: '0.72rem', color: c.accent.primary, whiteSpace: 'nowrap' }}>
                Saved
              </Typography>
            </Box>
          )}
          <Button
            variant="contained"
            startIcon={<SaveIcon sx={{ fontSize: 16 }} />}
            onClick={() => handleSave(false)}
            disabled={saving || !name.trim()}
            size="small"
            sx={{
              bgcolor: c.accent.primary,
              textTransform: 'none',
              fontWeight: 500,
              fontSize: '0.8rem',
              px: 2,
              '&:hover': { bgcolor: c.accent.hover },
            }}
          >
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </Button>
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
            <Tab label="Test Input" value={TAB_TEST_INPUT} />
            <Tab label="Auto Run" value={TAB_AUTO_RUN} />
            {showConsole && <Tab label="Console" value={TAB_CONSOLE} />}
          </Tabs>
          {activeTab === TAB_PREVIEW && (
            <>
              <Tooltip title="Reload preview">
                <IconButton
                  size="small"
                  onClick={() => previewRef.current?.reload()}
                  sx={{ color: c.text.muted }}
                >
                  <RefreshIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
              {effectiveId && (
                <Tooltip title="Execute with backend code">
                  <IconButton
                    size="small"
                    onClick={handleRunPreview}
                    sx={{ mr: 1, color: c.accent.primary }}
                  >
                    <PlayArrowIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip title={showConsole ? 'Hide console' : 'Show console'}>
            <Box
              onClick={() => {
                if (showConsole && activeTab === TAB_CONSOLE) {
                  setShowConsole(false);
                  setActiveTab(TAB_PREVIEW);
                } else if (showConsole) {
                  setShowConsole(false);
                  if (activeTab === TAB_CONSOLE) setActiveTab(TAB_PREVIEW);
                } else {
                  setShowConsole(true);
                  setHasNewConsoleOutput(false);
                  setActiveTab(TAB_CONSOLE);
                }
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                px: 0.75,
                py: 0.5,
                mr: 1,
                borderRadius: 1,
                position: 'relative',
                bgcolor: showConsole ? c.accent.primary + '15' : 'transparent',
                '&:hover': { bgcolor: showConsole ? c.accent.primary + '25' : c.bg.elevated },
                transition: 'background-color 0.15s',
              }}
            >
              <Typography sx={{ fontFamily: c.font.mono, fontSize: '0.72rem', fontWeight: 700, color: showConsole ? c.accent.primary : c.text.ghost, lineHeight: 1 }}>
                {'>_'}
              </Typography>
              {hasNewConsoleOutput && !showConsole && (
                <Box sx={{ position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: '50%', bgcolor: '#4ade80' }} />
              )}
            </Box>
          </Tooltip>
        </Box>

        {/* Tab content */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {activeTab === TAB_PREVIEW && (
            <ViewPreview
              ref={previewRef}
              serveUrl={workspaceServeUrl}
              frontendCode={!workspaceServeUrl ? (files['index.html'] ?? '') : undefined}
              inputData={testInput}
              backendResult={executeResult?.backend_result}
            />
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
          {activeTab === TAB_TEST_INPUT && (
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 2,
                  py: 1,
                  borderBottom: `1px solid ${c.border.subtle}`,
                  bgcolor: c.bg.secondary,
                  flexShrink: 0,
                }}
              >
                <Button
                  size="small"
                  startIcon={<AutoFixHighIcon sx={{ fontSize: 15 }} />}
                  onClick={() => setTestInput(getStubbed(parsedSchema))}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.78rem',
                    color: c.accent.primary,
                    fontWeight: 500,
                    '&:hover': { bgcolor: c.bg.elevated },
                  }}
                >
                  Fill sample data
                </Button>
                <Button
                  size="small"
                  onClick={() => setTestInput(getDefault(parsedSchema))}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.78rem',
                    color: c.text.muted,
                    fontWeight: 400,
                    '&:hover': { bgcolor: c.bg.elevated },
                  }}
                >
                  Reset
                </Button>
              </Box>
              <Box sx={{ p: 2, overflow: 'auto', flex: 1 }}>
                <InputSchemaForm
                  schema={parsedSchema}
                  value={testInput}
                  onChange={setTestInput}
                />
              </Box>
            </Box>
          )}
          {activeTab === TAB_CONSOLE && (
            <ConsolePanel entry={consoleEntry} c={c} />
          )}
          <Box sx={{ display: activeTab === TAB_AUTO_RUN ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  px: 2,
                  py: 1,
                  borderBottom: `1px solid ${c.border.subtle}`,
                  bgcolor: c.bg.secondary,
                  flexShrink: 0,
                }}
              >
                <Switch
                  checked={autoRunEnabled}
                  onChange={(_, v) => setAutoRunEnabled(v)}
                  size="small"
                  sx={{
                    '& .MuiSwitch-switchBase.Mui-checked': { color: '#f59e0b' },
                    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: '#f59e0b' },
                  }}
                />
                <Typography sx={{ fontSize: '0.82rem', fontWeight: 500, color: autoRunEnabled ? c.text.primary : c.text.muted }}>
                  {autoRunEnabled ? 'Auto Run enabled' : 'Auto Run disabled'}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {autoRunEnabled && (
                  <Button
                    size="small"
                    startIcon={autoRunning ? <CircularProgress size={12} /> : <BoltIcon sx={{ fontSize: 14 }} />}
                    onClick={handleAutoRun}
                    disabled={autoRunning}
                    sx={{
                      textTransform: 'none',
                      fontSize: '0.78rem',
                      color: '#f59e0b',
                      fontWeight: 500,
                      '&:hover': { bgcolor: '#f59e0b10' },
                    }}
                  >
                    {autoRunning ? 'Running…' : 'Run Now'}
                  </Button>
                )}
              </Box>
              <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {autoRunEnabled ? (
                  <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', p: 2, gap: 1.5, overflow: 'hidden' }}>
                    <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem', lineHeight: 1.6, flexShrink: 0 }}>
                      Describe what data to generate for this app. When triggered, an LLM will produce input data matching your schema and populate the preview.
                    </Typography>
                    <ChatInput
                      ref={autoRunInputRef}
                      autoRunMode
                      onSend={() => {}}
                      mode={autoRunMode}
                      onModeChange={setAutoRunMode}
                      model={autoRunModel}
                      onModelChange={setAutoRunModel}
                    />
                    <Button
                      variant="contained"
                      startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon sx={{ fontSize: 16 }} />}
                      onClick={() => handleSave(false)}
                      disabled={saving || !name.trim()}
                      size="small"
                      sx={{
                        alignSelf: 'flex-start',
                        flexShrink: 0,
                        bgcolor: c.accent.primary,
                        textTransform: 'none',
                        fontWeight: 500,
                        fontSize: '0.8rem',
                        px: 2,
                        '&:hover': { bgcolor: c.accent.hover },
                      }}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </Button>
                    {(autoRunSessionId || autoRunMessages.length > 0) && (
                      <AutoRunLog
                        messages={autoRunMessages}
                        status={autoRunSessionStatus}
                        logEndRef={autoRunLogEndRef}
                        c={c}
                      />
                    )}
                  </Box>
                ) : (
                  <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5 }}>
                    <BoltIcon sx={{ fontSize: 40, color: c.text.ghost, opacity: 0.3 }} />
                    <Typography sx={{ color: c.text.ghost, fontSize: '0.88rem' }}>
                      Enable Auto Run to generate live data for this app
                    </Typography>
                    <Typography sx={{ color: c.text.ghost, fontSize: '0.78rem', maxWidth: 360, textAlign: 'center', lineHeight: 1.5 }}>
                      Configure a prompt that describes what data to generate. An LLM will produce input matching your schema and populate the preview automatically.
                    </Typography>
                  </Box>
                )}
              </Box>
          </Box>
        </Box>
      </Box>
    </Box>
    </ElementSelectionProvider>
  );
};

export default ViewEditor;
