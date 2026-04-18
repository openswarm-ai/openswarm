import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, removeDraftSession } from '@/shared/state/agentsSlice';
import { SEED_APP, READ_APP, WRITE_APP_FILE, DELETE_APP_FILE, App, getAppServeUrl } from '@/shared/backend-bridge/apps/app_builder';
import { ViewPreviewHandle } from '../ViewPreview';
import { buildFileTree } from '../FileTree';

const POLL_INTERVAL_MS = 2000;

export function useViewWorkspace(
  app: App | null,
  previewRef: React.RefObject<ViewPreviewHandle | null>,
) {
  const dispatch = useAppDispatch();

  const [files, setFiles] = useState<Record<string, string>>(() => {
    if (!app) return {};
    const f = { ...app.files };
    if (!f['schema.json'] && app.input_schema) {
      f['schema.json'] = JSON.stringify(app.input_schema, null, 2);
    }
    return f;
  });
  const [fileVersion, setFileVersion] = useState(0);
  const [name, setName] = useState(app?.name ?? '');
  const [description, setDescription] = useState(app?.description ?? '');
  const [activeFile, setActiveFile] = useState('index.html');

  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [stableWorkspaceId] = useState(() => `ws-${Date.now().toString(36)}`);
  const [initialDraftId, setInitialDraftId] = useState<string | null>(null);
  const draftCreated = useRef(false);
  const workspaceIdRef = useRef<string | null>(null);
  const wsPushTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPollRef = useRef<string>('');
  const nameSetByMeta = useRef(false);

  const workspaceId = workspacePath ? stableWorkspaceId : null;
  workspaceIdRef.current = workspaceId;

  useEffect(() => {
    if (draftCreated.current) return;
    draftCreated.current = true;
    (async () => {
      const seedBody: { app_id: string; files?: Record<string, string>; meta?: Record<string, unknown> } = {
        app_id: stableWorkspaceId,
      };
      if (app) {
        const seedFiles: Record<string, string> = { ...app.files };
        if (app.input_schema && !seedFiles['schema.json']) {
          seedFiles['schema.json'] = JSON.stringify(app.input_schema, null, 2);
        }
        seedBody.files = seedFiles;
        seedBody.meta = { name: app.name, description: app.description };
      }
      try {
        const result = await dispatch(SEED_APP(seedBody)).unwrap();
        setWorkspacePath(result.path);
        const action = dispatch(createDraftSession({
          mode: 'view-builder', setActive: false, targetDirectory: result.path,
        }));
        setInitialDraftId(action.payload.draftId);
      } catch {
        const action = dispatch(createDraftSession({ mode: 'view-builder', setActive: false }));
        setInitialDraftId(action.payload.draftId);
      }
    })();
  }, [dispatch, app, stableWorkspaceId]);

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

  const initialContextPaths = useMemo(
    () => workspacePath ? [{ path: workspacePath, type: 'directory' as const }] : undefined,
    [workspacePath],
  );

  const pollWorkspace = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await dispatch(READ_APP(workspaceId)).unwrap();
      const fingerprint = JSON.stringify(data);
      if (fingerprint === lastPollRef.current) return;
      lastPollRef.current = fingerprint;
      if (data.files) { setFiles(data.files); setFileVersion(v => v + 1); }
      if (data.meta) {
        const meta = data.meta as Record<string, any>;
        if (meta.name && !nameSetByMeta.current) {
          nameSetByMeta.current = true;
          setName((prev) => prev || meta.name);
        }
        if (meta.description) setDescription((prev) => prev || meta.description);
      }
    } catch {}
  }, [workspaceId, dispatch]);

  useEffect(() => {
    if (!workspaceId) return;
    pollWorkspace();
    pollRef.current = setInterval(pollWorkspace, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [workspaceId, pollWorkspace]);

  const prevAgentActive = useRef(false);
  useEffect(() => {
    if (prevAgentActive.current && !isAgentActive && workspaceId) setTimeout(pollWorkspace, 500);
    prevAgentActive.current = isAgentActive;
  }, [isAgentActive, workspaceId, pollWorkspace]);

  useEffect(() => {
    return () => { if (initialDraftId) dispatch(removeDraftSession(initialDraftId)); };
  }, [initialDraftId, dispatch]);

  const workspaceServeUrl = workspaceId
    ? getAppServeUrl(workspaceId)
    : undefined;

  const filePaths = useMemo(
    () => Object.keys(files).filter(p => p !== 'meta.json' && p !== 'SKILL.md').sort(),
    [files],
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
        dispatch(WRITE_APP_FILE({ appId: wsId, filepath: path, content }))
          .then(() => previewRef.current?.reload())
          .catch(() => {});
      }, 300));
    }
  }, [previewRef, dispatch]);

  const addFile = useCallback((fileName: string) => {
    const trimmed = fileName.trim();
    if (!trimmed || files[trimmed] != null) return;
    setFiles(prev => ({ ...prev, [trimmed]: '' }));
    setActiveFile(trimmed);
    if (workspaceId) {
      dispatch(WRITE_APP_FILE({ appId: workspaceId, filepath: trimmed, content: '' }));
    }
  }, [files, workspaceId, dispatch]);

  const deleteFile = useCallback((filePath: string) => {
    setFiles(prev => { const next = { ...prev }; delete next[filePath]; return next; });
    if (activeFile === filePath) {
      const remaining = filePaths.filter(p => p !== filePath);
      setActiveFile(remaining[0] ?? 'index.html');
    }
    if (workspaceId) {
      dispatch(DELETE_APP_FILE({ appId: workspaceId, filepath: filePath }));
    }
  }, [activeFile, filePaths, workspaceId, dispatch]);

  useEffect(() => {
    return () => { wsPushTimers.current.forEach(t => clearTimeout(t)); };
  }, []);

  return {
    files, setFiles, fileVersion,
    name, setName, description, setDescription,
    activeFile, setActiveFile,
    workspacePath, workspaceId, workspaceIdRef, stableWorkspaceId,
    initialDraftId, effectiveSessionId,
    agentStatus, isLaunched, isAgentActive,
    initialContextPaths, workspaceServeUrl,
    filePaths, fileTree,
    updateFile, addFile, deleteFile,
  };
}
