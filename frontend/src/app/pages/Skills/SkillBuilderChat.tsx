import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Fab from '@mui/material/Fab';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CloseIcon from '@mui/icons-material/Close';
import MinimizeIcon from '@mui/icons-material/Remove';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, removeDraftSession } from '@/shared/state/agentsSlice';
import { createSkill } from '@/shared/state/skillsSlice';
import AgentChat from '../AgentChat/AgentChat';
import { ContextPath } from '@/app/components/DirectoryBrowser';
import { API_BASE } from '@/shared/config';

const SKILLS_WORKSPACE_API = `${API_BASE}/skills`;
const POLL_INTERVAL_MS = 2000;

export interface SkillPreviewData {
  name: string;
  description: string;
  command: string;
  content: string;
}

interface SkillBuilderChatProps {
  onSkillPreview: (data: SkillPreviewData | null) => void;
  onSkillSaved: (message: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

const MIN_W = 320;
const MAX_W = 700;
const MIN_H = 300;
const MAX_H = 900;

const SkillBuilderChat: React.FC<SkillBuilderChatProps> = ({ onSkillPreview, onSkillSaved, expanded, onExpandedChange }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();

  const setExpanded = onExpandedChange;
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
      const res = await fetch(`${SKILLS_WORKSPACE_API}/workspace/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: wsId }),
      });
      const data = await res.json();
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

  // Poll workspace for updates
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPollRef = useRef<string>('');

  const pollWorkspace = useCallback(async () => {
    if (!stableWorkspaceId) return;
    try {
      const res = await fetch(`${SKILLS_WORKSPACE_API}/workspace/${stableWorkspaceId}`);
      if (!res.ok) return;
      const data = await res.json();
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

  // Final poll when agent finishes
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
      await dispatch(createSkill({
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

  if (!expanded) {
    return (
      <Tooltip title="Build skill with AI" placement="left">
        <Fab
          onClick={() => setExpanded(true)}
          sx={{
            position: 'absolute',
            bottom: 24,
            right: 24,
            bgcolor: c.accent.primary,
            color: '#fff',
            '&:hover': { bgcolor: c.accent.pressed },
            zIndex: 10,
            width: 52,
            height: 52,
            boxShadow: c.shadow.lg,
          }}
        >
          <AutoFixHighIcon />
        </Fab>
      </Tooltip>
    );
  }

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        width: panelWidth,
        height: panelHeight,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.medium}`,
        borderRadius: `${c.radius.lg}px`,
        boxShadow: c.shadow.lg,
        zIndex: 20,
        overflow: 'hidden',
      }}
    >
      {/* Left resize handle */}
      <Box
        onPointerDown={(e) => onResizeStart('left', e)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        sx={{
          position: 'absolute', left: 0, top: 12, bottom: 0, width: 6,
          cursor: 'col-resize', zIndex: 2,
          '&::after': {
            content: '""', position: 'absolute',
            top: 0, bottom: 0, left: 0, width: 2,
            borderRadius: `${c.radius.lg}px 0 0 ${c.radius.lg}px`,
            bgcolor: 'transparent', transition: 'background-color 0.15s',
          },
          '&:hover::after, &:active::after': { bgcolor: c.accent.primary },
        }}
      />
      {/* Top resize handle */}
      <Box
        onPointerDown={(e) => onResizeStart('top', e)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        sx={{
          position: 'absolute', top: 0, left: 12, right: 0, height: 6,
          cursor: 'row-resize', zIndex: 2,
          '&::after': {
            content: '""', position: 'absolute',
            left: 0, right: 0, top: 0, height: 2,
            borderRadius: `${c.radius.lg}px ${c.radius.lg}px 0 0`,
            bgcolor: 'transparent', transition: 'background-color 0.15s',
          },
          '&:hover::after, &:active::after': { bgcolor: c.accent.primary },
        }}
      />
      {/* Top-left corner resize handle */}
      <Box
        onPointerDown={(e) => onResizeStart('corner', e)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        sx={{
          position: 'absolute', top: 0, left: 0, width: 14, height: 14,
          cursor: 'nwse-resize', zIndex: 3,
        }}
      />

      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: `1px solid ${c.border.subtle}`,
          bgcolor: c.bg.secondary,
          flexShrink: 0,
          minHeight: 42,
        }}
      >
        <AutoFixHighIcon sx={{ fontSize: 18, color: c.accent.primary }} />
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: c.text.primary, flex: 1 }}>
          Skill Builder
        </Typography>

        {currentPreview && currentPreview.name && (
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveIcon sx={{ fontSize: 14 }} />}
            onClick={handleSave}
            disabled={saving || !currentPreview.content}
            sx={{
              bgcolor: c.accent.primary,
              '&:hover': { bgcolor: c.accent.pressed },
              textTransform: 'none',
              fontSize: '0.72rem',
              fontWeight: 600,
              px: 1.5,
              py: 0.25,
              minHeight: 28,
              borderRadius: `${c.radius.sm}px`,
              boxShadow: 'none',
            }}
          >
            {saving ? 'Saving...' : 'Save Skill'}
          </Button>
        )}

        <Tooltip title="Reset session">
          <IconButton size="small" onClick={handleReset} sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
            <RestartAltIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>

        <Tooltip title="Minimize">
          <IconButton size="small" onClick={() => setExpanded(false)} sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
            <MinimizeIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>

        <Tooltip title="Close">
          <IconButton
            size="small"
            onClick={() => {
              setExpanded(false);
              onSkillPreview(null);
            }}
            sx={{ color: c.text.tertiary, '&:hover': { color: c.status.error } }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Chat area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {effectiveSessionId ? (
          <AgentChat
            key={effectiveSessionId}
            sessionId={effectiveSessionId}
            embedded
            initialContextPaths={initialContextPaths}
          />
        ) : (
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.85rem' }}>
              Initializing skill builder...
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default SkillBuilderChat;
