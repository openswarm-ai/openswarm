// Self-contained Code view for the dashboard app card: polls the workspace file
// tree, edits save via the same per-file PUT the full ViewEditor uses. Owns all
// its state so DashboardViewCard mounts it on demand with just a workspaceId.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { API_BASE } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import CodeEditor from './CodeEditor';
import { FileTreeItem, buildFileTree, getEditorLanguage, isHiddenWorkspacePath } from './AppFileTree';

const POLL_MS = 3000;
const SAVE_DEBOUNCE_MS = 300;

interface Props {
  workspaceId: string;
  onFileSaved?: () => void;
}

const AppCodePanel: React.FC<Props> = ({ workspaceId, onFileSaved }) => {
  const c = useClaudeTokens();
  const [files, setFiles] = useState<Record<string, string>>({});
  const [oversizeFiles, setOversizeFiles] = useState<Record<string, number>>({});
  const [activeFile, setActiveFile] = useState('');
  const lastPollRef = useRef('');
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Files the user is mid-editing; the poll must not clobber them with a stale disk read racing the debounced PUT.
  const dirtyFilesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/outputs/workspace/${workspaceId}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const fingerprint = JSON.stringify(data.files ?? {});
        if (fingerprint === lastPollRef.current) return;
        lastPollRef.current = fingerprint;
        setFiles((prev) => {
          const next: Record<string, string> = { ...(data.files ?? {}) };
          for (const dirty of dirtyFilesRef.current) {
            if (prev[dirty] != null) next[dirty] = prev[dirty];
          }
          return next;
        });
        setOversizeFiles(data.truncated ?? {});
      } catch { /* transient poll failure; next tick retries */ }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId]);

  const filePaths = useMemo(
    () =>
      Array.from(new Set([...Object.keys(files), ...Object.keys(oversizeFiles)]))
        .filter((p) => p !== 'meta.json' && p !== 'SKILL.md')
        .filter((p) => !isHiddenWorkspacePath(p))
        .sort(),
    [files, oversizeFiles],
  );
  const fileTree = useMemo(() => buildFileTree(filePaths), [filePaths]);

  useEffect(() => {
    if (!activeFile || !filePaths.includes(activeFile)) {
      setActiveFile(filePaths.find((p) => p.endsWith('.tsx') || p.endsWith('.html')) ?? filePaths[0] ?? '');
    }
  }, [filePaths, activeFile]);

  const updateFile = useCallback((path: string, content: string) => {
    if (oversizeFiles[path] != null) return;
    dirtyFilesRef.current.add(path);
    setFiles((prev) => ({ ...prev, [path]: content }));
    const existing = saveTimersRef.current.get(path);
    if (existing) clearTimeout(existing);
    saveTimersRef.current.set(path, setTimeout(() => {
      saveTimersRef.current.delete(path);
      dirtyFilesRef.current.delete(path);
      fetch(`${API_BASE}/outputs/workspace/${workspaceId}/file/${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
        .then(() => onFileSaved?.())
        .catch(() => {});
    }, SAVE_DEBOUNCE_MS));
  }, [workspaceId, oversizeFiles, onFileSaved]);

  useEffect(() => () => {
    for (const t of saveTimersRef.current.values()) clearTimeout(t);
  }, []);

  return (
    <Box sx={{ display: 'flex', height: '100%', bgcolor: c.bg.surface }}>
      <Box sx={{ width: 168, flexShrink: 0, bgcolor: c.bg.secondary, overflow: 'auto', py: 0.5, borderRight: `1px solid ${c.border.subtle}` }}>
        {fileTree.map((node) => (
          <FileTreeItem key={node.path} node={node} depth={0} activeFile={activeFile} onSelect={setActiveFile} c={c} />
        ))}
        {filePaths.length === 0 && (
          <Typography sx={{ fontSize: '0.72rem', color: c.text.ghost, px: 1.5, py: 1 }}>
            Loading files…
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1, overflow: 'hidden' }}>
        {activeFile && oversizeFiles[activeFile] != null ? (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', px: 3 }}>
            <Typography sx={{ color: c.text.muted, fontSize: '0.8rem', textAlign: 'center', maxWidth: 320, lineHeight: 1.5 }}>
              This file is {(oversizeFiles[activeFile] / (1024 * 1024)).toFixed(1)} MB, too large to edit here.
            </Typography>
          </Box>
        ) : activeFile && files[activeFile] != null ? (
          <CodeEditor
            key={activeFile}
            value={files[activeFile]}
            onChange={(val) => updateFile(activeFile, val)}
            language={getEditorLanguage(activeFile)}
            placeholder={`// ${activeFile}`}
          />
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem' }}>
              Select a file to edit
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default AppCodePanel;
