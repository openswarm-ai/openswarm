import React, { useState, useRef, useCallback, useEffect, PointerEvent as ReactPointerEvent } from 'react';
import { Box, Typography, Button, IconButton, TextField, Tabs, Tab, Tooltip, CircularProgress } from '@mui/material';
import { Save as SaveIcon, PlayArrow as PlayArrowIcon, Add as AddIcon, Refresh as RefreshIcon, CheckCircleOutline as CheckCircleOutlineIcon, AutoFixHigh as AutoFixHighIcon } from '@mui/icons-material';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { App } from '@/shared/backend-bridge/apps/app_builder';
import AgentChat from '../AgentChat/AgentChat';
import ViewPreview, { ViewPreviewHandle } from './ViewPreview';
import InputSchemaForm, { getDefault, getStubbed } from './InputSchemaForm';
import CodeEditor from './CodeEditor';
// TODO: Fix this import, also the the element selection in this component doesnt seem to work so for now its chillin
import { ElementSelectionProvider } from '@/app/pages/Dashboard/_shared/element_selection/ElementSelectionProvider';
import { FileTreeItem, getEditorLanguage } from './FileTree';
import { ConsolePanel } from './ConsolePanel';
import { useViewWorkspace } from './hooks/useViewWorkspace';
import { useAutoRun } from './hooks/useAutoRun';
import { useViewSave } from './hooks/useViewSave';

interface Props { output: App | null; onClose: () => void; }

const TAB_PREVIEW = 0, TAB_CODE = 1, TAB_TEST_INPUT = 2, TAB_CONSOLE = 3;
const SIDEBAR_MIN = 280, SIDEBAR_MAX = 800;

const ViewEditor: React.FC<Props> = ({ output, onClose }) => {
  const c = useClaudeTokens();
  const previewRef = useRef<ViewPreviewHandle>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const createdIdRef = useRef<string | null>(null);
  const effectiveId = output?.id ?? createdId;
  const isNew = !effectiveId;
  const [activeTab, setActiveTab] = useState(TAB_PREVIEW);
  const [showConsole, setShowConsole] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const [newFileName, setNewFileName] = useState('');
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const newFileInputRef = useRef<HTMLInputElement>(null);

  const ws = useViewWorkspace(output, previewRef);
  const ar = useAutoRun(output, createdIdRef, ws.files, ws.name, setActiveTab);
  const save = useViewSave({
    output, name: ws.name, description: ws.description, files: ws.files,
    testInput: ar.testInput, onClose, previewRef,
    createdIdRef, setCreatedId,
  });

  const activeFileContent = ws.files[ws.activeFile] ?? '';

  const onDragStart = useCallback((e: ReactPointerEvent) => {
    dragging.current = true; dragStartX.current = e.clientX; dragStartWidth.current = sidebarWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  }, [sidebarWidth]);
  const onDragMove = useCallback((e: ReactPointerEvent) => {
    if (!dragging.current) return;
    setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStartWidth.current + (e.clientX - dragStartX.current))));
  }, []);
  const onDragEnd = useCallback(() => {
    dragging.current = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
  }, []);

  useEffect(() => { if (showNewFileInput) setTimeout(() => newFileInputRef.current?.focus(), 50); }, [showNewFileInput]);
  const handleAddFile = (fn: string) => { ws.addFile(fn); setShowNewFileInput(false); setNewFileName(''); };

  return (
    <ElementSelectionProvider>
    <Box sx={{ height: '100%', display: 'flex', overflow: 'hidden' }}>
      <Box sx={{ width: sidebarWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', bgcolor: c.bg.page }}>
        {ws.effectiveSessionId ? (
          <AgentChat key={ws.effectiveSessionId} sessionId={ws.effectiveSessionId} initialContextPaths={ws.initialContextPaths} />
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.85rem' }}>Initializing agent...</Typography>
          </Box>
        )}
      </Box>
      <Box onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}
        sx={{ width: 6, flexShrink: 0, cursor: 'col-resize', position: 'relative', bgcolor: 'transparent', transition: 'background-color 0.15s', '&::after': { content: '""', position: 'absolute', top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 1, bgcolor: c.border.subtle, transition: 'width 0.15s, background-color 0.15s' }, '&:hover::after, &:active::after': { width: 3, bgcolor: c.accent.primary } }} />
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header bar */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 0.75, borderBottom: `1px solid ${c.border.subtle}`, bgcolor: c.bg.secondary, flexShrink: 0, minHeight: 44 }}>
          <TextField value={ws.name} onChange={(e) => ws.setName(e.target.value)} placeholder="App name" variant="standard"
            sx={{ flex: 1, maxWidth: 220, '& .MuiInput-input': { fontSize: '0.9rem', fontWeight: 600, color: c.text.primary }, '& .MuiInput-underline:before': { borderColor: 'transparent' }, '& .MuiInput-underline:hover:before': { borderColor: c.border.medium } }} />
          <TextField value={ws.description} onChange={(e) => ws.setDescription(e.target.value)} placeholder="Description" variant="standard" size="small"
            sx={{ flex: 2, '& .MuiInput-input': { fontSize: '0.78rem', color: c.text.muted }, '& .MuiInput-underline:before': { borderColor: 'transparent' } }} />
          {save.saveStatus === 'unsaved' && <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, fontStyle: 'italic', whiteSpace: 'nowrap' }}>Unsaved changes</Typography>}
          {save.saveStatus === 'saving' && <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><CircularProgress size={12} sx={{ color: c.text.ghost }} /><Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, whiteSpace: 'nowrap' }}>Saving…</Typography></Box>}
          {save.saveStatus === 'saved' && <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}><CheckCircleOutlineIcon sx={{ fontSize: 14, color: c.accent.primary }} /><Typography sx={{ fontSize: '0.72rem', color: c.accent.primary, whiteSpace: 'nowrap' }}>Saved</Typography></Box>}
          <Button variant="contained" startIcon={<SaveIcon sx={{ fontSize: 16 }} />} onClick={() => save.handleSave(false)} disabled={save.saving || !ws.name.trim()} size="small"
            sx={{ bgcolor: c.accent.primary, textTransform: 'none', fontWeight: 500, fontSize: '0.8rem', px: 2, '&:hover': { bgcolor: c.accent.hover } }}>
            {save.saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </Button>
        </Box>
        {/* Tab bar */}
        <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${c.border.subtle}`, bgcolor: c.bg.secondary, flexShrink: 0 }}>
          <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}
            sx={{ flex: 1, minHeight: 36, '& .MuiTab-root': { minHeight: 36, fontSize: '0.78rem', textTransform: 'none', fontWeight: 500, py: 0 }, '& .MuiTabs-indicator': { bgcolor: c.accent.primary } }}>
            <Tab label="Preview" value={TAB_PREVIEW} />
            <Tab label="Code" value={TAB_CODE} />
            <Tab label="Test Input" value={TAB_TEST_INPUT} />
            {showConsole && <Tab label="Console" value={TAB_CONSOLE} />}
          </Tabs>
          {activeTab === TAB_PREVIEW && (<>
            <Tooltip title="Reload preview"><IconButton size="small" onClick={() => previewRef.current?.reload()} sx={{ color: c.text.muted }}><RefreshIcon sx={{ fontSize: 18 }} /></IconButton></Tooltip>
            {effectiveId && <Tooltip title="Execute with backend code"><IconButton size="small" onClick={ar.handleRunPreview} sx={{ mr: 1, color: c.accent.primary }}><PlayArrowIcon sx={{ fontSize: 18 }} /></IconButton></Tooltip>}
          </>)}
          <Tooltip title={showConsole ? 'Hide console' : 'Show console'}>
            <Box onClick={() => {
              if (showConsole && activeTab === TAB_CONSOLE) { setShowConsole(false); setActiveTab(TAB_PREVIEW); }
              else if (showConsole) { setShowConsole(false); if (activeTab === TAB_CONSOLE) setActiveTab(TAB_PREVIEW); }
              else { setShowConsole(true); ar.setHasNewConsoleOutput(false); setActiveTab(TAB_CONSOLE); }
            }} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', px: 0.75, py: 0.5, mr: 1, borderRadius: 1, position: 'relative', bgcolor: showConsole ? c.accent.primary + '15' : 'transparent', '&:hover': { bgcolor: showConsole ? c.accent.primary + '25' : c.bg.elevated }, transition: 'background-color 0.15s' }}>
              <Typography sx={{ fontFamily: c.font.mono, fontSize: '0.72rem', fontWeight: 700, color: showConsole ? c.accent.primary : c.text.ghost, lineHeight: 1 }}>{'>_'}</Typography>
              {ar.hasNewConsoleOutput && !showConsole && <Box sx={{ position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: '50%', bgcolor: '#4ade80' }} />}
            </Box>
          </Tooltip>
        </Box>
        {/* Tab content */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {activeTab === TAB_PREVIEW && (
            <ViewPreview ref={previewRef} serveUrl={ws.workspaceServeUrl}
              frontendCode={!ws.workspaceServeUrl ? (ws.files['index.html'] ?? '') : undefined}
              inputData={ar.testInput} backendResult={ar.executeResult?.backend_result} />
          )}
          {activeTab === TAB_CODE && (
            <Box sx={{ display: 'flex', height: '100%' }}>
              <Box sx={{ width: 200, flexShrink: 0, borderRight: `1px solid ${c.border.subtle}`, bgcolor: c.bg.secondary, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.5 }}>
                  <Typography sx={{ fontSize: '0.65rem', fontWeight: 600, color: c.text.muted, textTransform: 'uppercase', letterSpacing: '0.05em', flex: 1 }}>Files</Typography>
                  <Tooltip title="New file" placement="top"><IconButton size="small" onClick={() => setShowNewFileInput(true)} sx={{ p: 0.25, color: c.text.ghost, '&:hover': { color: c.accent.primary } }}><AddIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                </Box>
                <Box sx={{ flex: 1, overflow: 'auto', py: 0.25 }}>
                  {ws.fileTree.map((node) => <FileTreeItem key={node.path} node={node} depth={0} activeFile={ws.activeFile} onSelect={ws.setActiveFile} onDelete={ws.deleteFile} c={c} />)}
                  {ws.filePaths.length === 0 && <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, px: 1.5, py: 1 }}>No files yet</Typography>}
                </Box>
                {showNewFileInput && (
                  <Box sx={{ px: 1, py: 0.75, borderTop: `1px solid ${c.border.subtle}`, bgcolor: c.bg.elevated }}>
                    <TextField inputRef={newFileInputRef} value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddFile(newFileName); if (e.key === 'Escape') { setShowNewFileInput(false); setNewFileName(''); } }}
                      onBlur={() => { if (newFileName.trim()) handleAddFile(newFileName); else { setShowNewFileInput(false); setNewFileName(''); } }}
                      placeholder="path/to/file.js" variant="standard" fullWidth autoFocus
                      sx={{ '& .MuiInput-input': { fontSize: '0.74rem', fontFamily: c.font.mono, color: c.text.primary, py: 0.25 }, '& .MuiInput-underline:before': { borderColor: c.border.subtle }, '& .MuiInput-underline:after': { borderColor: c.accent.primary } }} />
                  </Box>
                )}
              </Box>
              <Box sx={{ flex: 1, overflow: 'hidden' }}>
                {ws.activeFile && ws.files[ws.activeFile] != null ? (
                  <CodeEditor key={ws.activeFile} value={activeFileContent} onChange={(val) => ws.updateFile(ws.activeFile, val)} language={getEditorLanguage(ws.activeFile)} placeholder={`// ${ws.activeFile}`} />
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><Typography sx={{ color: c.text.ghost, fontSize: '0.85rem' }}>Select a file to edit</Typography></Box>
                )}
              </Box>
            </Box>
          )}
          {activeTab === TAB_TEST_INPUT && (
            <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1, borderBottom: `1px solid ${c.border.subtle}`, bgcolor: c.bg.secondary, flexShrink: 0 }}>
                <Button size="small" startIcon={<AutoFixHighIcon sx={{ fontSize: 15 }} />} onClick={() => ar.setTestInput(getStubbed(ar.parsedSchema))}
                  sx={{ textTransform: 'none', fontSize: '0.78rem', color: c.accent.primary, fontWeight: 500, '&:hover': { bgcolor: c.bg.elevated } }}>Fill sample data</Button>
                <Button size="small" onClick={() => ar.setTestInput(getDefault(ar.parsedSchema))}
                  sx={{ textTransform: 'none', fontSize: '0.78rem', color: c.text.muted, fontWeight: 400, '&:hover': { bgcolor: c.bg.elevated } }}>Reset</Button>
              </Box>
              <Box sx={{ p: 2, overflow: 'auto', flex: 1 }}>
                <InputSchemaForm schema={ar.parsedSchema} value={ar.testInput} onChange={ar.setTestInput} />
              </Box>
            </Box>
          )}
          {activeTab === TAB_CONSOLE && <ConsolePanel entry={ar.consoleEntry} c={c} />}
        </Box>
      </Box>
    </Box>
    </ElementSelectionProvider>
  );
};

export default ViewEditor;
