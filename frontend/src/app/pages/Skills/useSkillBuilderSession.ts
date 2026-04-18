import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, removeDraftSession } from '@/shared/state/agentsSlice';
import { CREATE_SKILL } from '@/shared/backend-bridge/apps/skills';
import { SEED_SKILL_WORKSPACE, READ_SKILL_WORKSPACE } from '@/shared/backend-bridge/apps/skills';
import {
  POLL_INTERVAL_MS,
  MIN_W, MAX_W, MIN_H, MAX_H,
  SkillPreviewData,
} from './skillBuilderChatTypes';

export function useSkillBuilderSession(
  onSkillPreview: (data: SkillPreviewData | null) => void,
  onSkillSaved: (message: string) => void,
  expanded: boolean,
) {
  const dispatch = useAppDispatch();

  const [panelWidth, setPanelWidth] = useState(420);
  const [panelHeight, setPanelHeight] = useState(560);
  const dragging = useRef<'left' | 'top' | 'corner' | null>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const dragStartSize = useRef({ w: 0, h: 0 });

  const onResizeStart = useCallback((edge: 'left' | 'top' | 'corner', e: React.PointerEvent) => {
    dragging.current = edge;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    dragStartSize.current = { w: panelWidth, h: panelHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = edge === 'left' ? 'col-resize' : edge === 'top' ? 'row-resize' : 'nwse-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth, panelHeight]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = dragStartPos.current.x - e.clientX;
    const dy = dragStartPos.current.y - e.clientY;
    if (dragging.current === 'left' || dragging.current === 'corner') {
      setPanelWidth(Math.min(MAX_W, Math.max(MIN_W, dragStartSize.current.w + dx)));
    }
    if (dragging.current === 'top' || dragging.current === 'corner') {
      setPanelHeight(Math.min(MAX_H, Math.max(MIN_H, dragStartSize.current.h + dy)));
    }
  }, []);

  const onResizeEnd = useCallback(() => {
    dragging.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const [initialDraftId, setInitialDraftId] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [stableWorkspaceId, setStableWorkspaceId] = useState(() => `skill-ws-${Date.now().toString(36)}`);
  const draftCreated = useRef(false);
  const [saving, setSaving] = useState(false);
  const [currentPreview, setCurrentPreview] = useState<SkillPreviewData | null>(null);

  const effectiveSessionId = useAppSelector((state) => {
    if (!initialDraftId) return null;
    if (state.agents.sessions[initialDraftId]) return initialDraftId;
    return state.agents.activeSessionId;
  });

  const agentStatus = useAppSelector((state) => {
    if (!effectiveSessionId) return null;
    return state.agents.sessions[effectiveSessionId]?.status ?? null;
  });

  const isAgentActive = agentStatus === 'running' || agentStatus === 'waiting_approval';

  const initialContextPaths = useMemo(
    () => workspacePath ? [{ path: workspacePath, type: 'directory' as const }] : undefined,
    [workspacePath],
  );

  const initSession = useCallback(async () => {
    const wsId = `skill-ws-${Date.now().toString(36)}`;
    setStableWorkspaceId(wsId);

    try {
      const data = await dispatch(SEED_SKILL_WORKSPACE({ workspace_id: wsId })).unwrap();
      setWorkspacePath(data.path);
      const action = dispatch(createDraftSession({
        mode: 'skill-builder',
        setActive: false,
        targetDirectory: data.path,
      }));
      setInitialDraftId(action.payload.draftId);
    } catch {
      const action = dispatch(createDraftSession({ mode: 'skill-builder', setActive: false }));
      setInitialDraftId(action.payload.draftId);
    }
  }, [dispatch]);

  useEffect(() => {
    if (draftCreated.current) return;
    draftCreated.current = true;
    initSession();
  }, [initSession]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPollRef = useRef<string>('');

  const pollWorkspace = useCallback(async () => {
    if (!stableWorkspaceId) return;
    try {
      const data = await dispatch(READ_SKILL_WORKSPACE(stableWorkspaceId)).unwrap();
      const fingerprint = JSON.stringify(data);
      if (fingerprint === lastPollRef.current) return;
      lastPollRef.current = fingerprint;

      if (data.skill_content || data.meta) {
        const meta = data.meta || {};
        const fm = data.frontmatter || {};
        const preview: SkillPreviewData = {
          name: meta.name || fm.name || '',
          description: meta.description || fm.description || '',
          command: meta.command || (meta.name || fm.name || '').toLowerCase().replace(/\s+/g, '-'),
          content: data.skill_content || '',
        };
        setCurrentPreview(preview);
        onSkillPreview(preview);
      }
    } catch { /* ignore polling errors */ }
  }, [stableWorkspaceId, onSkillPreview]);

  useEffect(() => {
    if (!expanded) return;
    pollWorkspace();
    pollRef.current = setInterval(pollWorkspace, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [expanded, pollWorkspace]);

  const prevAgentActive = useRef(false);
  useEffect(() => {
    if (prevAgentActive.current && !isAgentActive) {
      setTimeout(pollWorkspace, 500);
    }
    prevAgentActive.current = isAgentActive;
  }, [isAgentActive, pollWorkspace]);

  useEffect(() => {
    return () => {
      if (initialDraftId) {
        dispatch(removeDraftSession(initialDraftId));
      }
    };
  }, [initialDraftId, dispatch]);

  const handleSave = async () => {
    if (!currentPreview || !currentPreview.name || !currentPreview.content) return;
    setSaving(true);
    try {
      await dispatch(CREATE_SKILL({
        name: currentPreview.name,
        description: currentPreview.description,
        content: currentPreview.content,
        command: currentPreview.command,
      })).unwrap();
      onSkillSaved(`Skill "${currentPreview.name}" saved successfully`);
    } catch (err) {
      console.error('Failed to save skill:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (initialDraftId) {
      dispatch(removeDraftSession(initialDraftId));
    }
    setCurrentPreview(null);
    onSkillPreview(null);
    lastPollRef.current = '';
    draftCreated.current = false;

    await initSession();
    draftCreated.current = true;
  };

  return {
    panelWidth,
    panelHeight,
    onResizeStart,
    onResizeMove,
    onResizeEnd,
    effectiveSessionId,
    initialContextPaths,
    currentPreview,
    saving,
    handleSave,
    handleReset,
  };
}
