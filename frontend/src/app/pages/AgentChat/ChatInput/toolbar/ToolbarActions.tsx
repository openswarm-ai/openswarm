import React, { RefObject } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import StopIcon from '@mui/icons-material/Stop';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import LanguageIcon from '@mui/icons-material/Language';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchSkills } from '@/shared/state/skillsSlice';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import { useVoice } from '@/shared/voice/VoiceDictationContext';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { ComposerPlusMenu, ActiveTogglePills, PlusMenuItem } from './ComposerPlusMenu';

interface Props {
  c: ClaudeTokens;
  elementSelection: ReturnType<typeof useElementSelection>;
  autoRunMode?: boolean;
  ownerId: string;
  sessionId?: string;
  generalFileInputRef: RefObject<HTMLInputElement>;
  addImageFiles: (files: FileList | File[]) => void;
  uploadAndAttachFiles: (files: File[]) => void;
  hasContent: boolean;
  disabled?: boolean;
  isRunning?: boolean;
  onStop?: () => void;
  handleSend: () => void;
  webSearchOn?: boolean;
  onToggleWebSearch?: () => void;
  onAttachSkill?: (skillId: string) => void;
}

export const ToolbarActions: React.FC<Props> = ({
  c, elementSelection, autoRunMode, ownerId, sessionId, generalFileInputRef,
  addImageFiles, uploadAndAttachFiles, hasContent, disabled, isRunning, onStop, handleSend,
  webSearchOn, onToggleWebSearch, onAttachSkill,
}) => {
  const dispatch = useAppDispatch();
  // Lazy-load the skills list the first time the menu could need it; cheap and cached in the slice.
  const skills = useAppSelector((s) => s.skills.items);
  const skillsLoaded = useAppSelector((s) => s.skills.loaded);
  const activeMcps = useAppSelector((s) => (sessionId ? s.agents.sessions[sessionId]?.active_mcps : undefined) ?? []);
  React.useEffect(() => { if (!skillsLoaded) dispatch(fetchSkills()); }, [skillsLoaded, dispatch]);
  // Every composer action collapses into one "+" so the bar reads empty at rest; active toggles
  // (web search, selecting) still surface as a pill so their state stays visible. New capabilities
  // (skills, MCP tools, voice, image) just push another entry onto this list, no new bar icon.
  const isSelecting = !!elementSelection && elementSelection.selectMode && elementSelection.activeOwnerId === ownerId;
  const toggleSelect = (): void => {
    if (!elementSelection) return;
    if (isSelecting) {
      elementSelection.setSelectMode(false);
    } else {
      if (elementSelection.activeOwnerId !== ownerId) elementSelection.clearOwnerElements(ownerId);
      elementSelection.setActiveOwnerId(ownerId);
      elementSelection.setExcludeSelectId(sessionId ?? null);
      elementSelection.setSelectMode(true);
    }
  };
  const { state: voiceState, toggle: voiceToggle } = useVoice();
  const plusItems: PlusMenuItem[] = [];
  plusItems.push({
    key: 'attach',
    label: 'Attach file',
    icon: <AttachFileIcon sx={{ fontSize: 17 }} />,
    onSelect: () => generalFileInputRef.current?.click(),
  });
  // A menu click can't be held, so this entry always toggles regardless of the hold-to-talk setting.
  plusItems.push({
    key: 'dictate',
    label: voiceState === 'recording' ? 'Stop dictation' : 'Dictate',
    icon: <MicNoneOutlinedIcon sx={{ fontSize: 17 }} />,
    toggle: true,
    active: voiceState === 'recording',
    onSelect: voiceToggle,
  });
  if (onToggleWebSearch) {
    plusItems.push({
      key: 'web',
      label: 'Web search',
      icon: <LanguageIcon sx={{ fontSize: 17 }} />,
      toggle: true,
      active: !!webSearchOn,
      onSelect: onToggleWebSearch,
    });
  }
  if (elementSelection) {
    plusItems.push({
      key: 'select',
      label: 'Select an element',
      icon: <AdsClickIcon sx={{ fontSize: 17 }} />,
      toggle: true,
      active: isSelecting,
      onSelect: toggleSelect,
    });
  }
  // Claude-style flyouts: Skills attaches a real pill (same path as typing /skill); Tools shows the
  // session's active connectors and jumps to Settings > Tools for management. Platform built-ins
  // (swarm-debug Logger etc.) stay out: they're dev plumbing the agent discovers on its own, and
  // their jargon reads hostile to a non-dev picking a skill.
  const skillList = Object.values(skills).filter((sk) => !sk.built_in);
  if (onAttachSkill && skillList.length > 0) {
    plusItems.push({
      key: 'skills',
      label: 'Skills',
      icon: <AutoAwesomeOutlinedIcon sx={{ fontSize: 17 }} />,
      onSelect: () => {},
      children: skillList.slice(0, 12).map((sk) => ({
        key: `skill-${sk.id}`,
        label: sk.name,
        icon: <DescriptionOutlinedIcon sx={{ fontSize: 15 }} />,
        onSelect: () => onAttachSkill(sk.id),
      })),
    });
  }
  plusItems.push({
    key: 'tools',
    label: 'Tools & connectors',
    icon: <ExtensionOutlinedIcon sx={{ fontSize: 17 }} />,
    hint: activeMcps.length > 0 ? `${activeMcps.length} active` : undefined,
    onSelect: () => {},
    children: [
      ...activeMcps.map((name) => ({
        key: `mcp-${name}`,
        label: name,
        icon: <ExtensionOutlinedIcon sx={{ fontSize: 15 }} />,
        hint: 'active',
        onSelect: () => dispatch(openSettingsModal('tools')),
      })),
      {
        key: 'manage-tools',
        label: 'Manage tools',
        icon: <TuneRoundedIcon sx={{ fontSize: 15 }} />,
        onSelect: () => dispatch(openSettingsModal('tools')),
      },
    ],
  });

  return (
    <>
      <input
        ref={generalFileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (!e.target.files) return;
          const all = Array.from(e.target.files);
          const imgs = all.filter((f) => f.type.startsWith('image/'));
          const rest = all.filter((f) => !f.type.startsWith('image/'));
          if (imgs.length > 0) addImageFiles(imgs);
          if (rest.length > 0) uploadAndAttachFiles(rest);
          e.target.value = '';
        }}
      />
      {!autoRunMode && <ActiveTogglePills c={c} items={plusItems} />}
      {!autoRunMode && <ComposerPlusMenu c={c} items={plusItems} />}
      {!autoRunMode && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {hasContent && (
            <Tooltip title={isRunning ? 'Queue message' : 'Send message'}>
              <IconButton
                size="small"
                onClick={handleSend}
                disabled={disabled}
                data-onboarding="chat-send-button"
                sx={{
                  bgcolor: c.accent.primary,
                  color: c.text.inverse,
                  p: 0.5,
                  width: 26,
                  height: 26,
                  '&:hover': { bgcolor: c.accent.hover },
                  '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
                  transition: c.transition,
                }}
              >
                <ArrowUpwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          {isRunning ? (
            <Tooltip title="Stop agent">
              <IconButton
                size="small"
                onClick={onStop}
                sx={{
                  bgcolor: c.status.error,
                  color: c.text.inverse,
                  p: 0.5,
                  width: 26,
                  height: 26,
                  '&:hover': { bgcolor: c.status.error, opacity: 0.85 },
                  transition: c.transition,
                }}
              >
                <StopIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          ) : null}
        </Box>
      )}
    </>
  );
};
