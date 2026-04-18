import React, { useState, useRef, useEffect, useId, forwardRef, useImperativeHandle } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CommandPicker from '@/app/components/CommandPicker';
import { useElementSelection } from '@/app/components/ElementSelectionContext';
import type { ContextPath } from '@/shared/state/agentsTypes';
import { type AttachedSkill, type TriggerState, EMPTY_TRIGGER, serializeEditorContent } from '@/app/components/richEditorUtils';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { AttachedImage } from './components/ImageAttachments';
import ImageAttachments from './components/ImageAttachments';
import type { ForcedToolGroup } from './components/AttachmentChips';
import AttachmentChips from './components/AttachmentChips';
import ModelModeSelector from '@/app/pages/AgentChat/ModelModeSelector/ModelModeSelector';
import { useChatSubmit } from './components/useChatSubmit';

interface Props {
  onSend: (message: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: ContextPath[], forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => void;
  disabled?: boolean;
  mode: string; onModeChange: (mode: string) => void;
  model: string; onModelChange: (model: string) => void;
  provider?: string; onProviderChange?: (provider: string) => void;
  isRunning?: boolean; onStop?: () => void;
  autoRunMode?: boolean;
  contextEstimate?: { used: number; limit: number };
  embedded?: boolean; autoFocus?: boolean;
  sessionId?: string; queueLength?: number;
}

export interface ChatInputHandle {
  getConfig: () => { prompt: string; contextPaths: ContextPath[]; forcedTools: ForcedToolGroup[] };
  setContent: (prompt: string, contextPaths?: ContextPath[], forcedTools?: ForcedToolGroup[]) => void;
}

const ChatInput = forwardRef<ChatInputHandle, Props>(({
  onSend, disabled, mode, onModeChange, model, onModelChange, provider, onProviderChange,
  isRunning, onStop, autoRunMode, contextEstimate, embedded, autoFocus, sessionId, queueLength = 0,
}, ref) => {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const elementSelection = useElementSelection();

  const fallbackOwnerId = useId();
  const ownerId = sessionId || fallbackOwnerId;

  useEffect(() => { if (autoFocus) editorRef.current?.focus(); }, [autoFocus]);

  const [hasContent, setHasContent] = useState(false);
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const attachedSkillsRef = useRef(attachedSkills);
  useEffect(() => { attachedSkillsRef.current = attachedSkills; });
  const [picker, setPicker] = useState<TriggerState>(EMPTY_TRIGGER);
  const skills = useAppSelector((state) => state.skills.items);
  const modesMap = useAppSelector((state) => state.modes.items);

  const [images, setImages] = useState<AttachedImage[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextPaths, setContextPaths] = useState<ContextPath[]>([]);
  const [forcedTools, setForcedTools] = useState<ForcedToolGroup[]>([]);
  const [copiedPathIdx, setCopiedPathIdx] = useState<number | null>(null);

  useImperativeHandle(ref, () => ({
    getConfig: () => {
      const editor = editorRef.current;
      const prompt = editor ? serializeEditorContent(editor, attachedSkillsRef.current).trim() : '';
      return { prompt, contextPaths, forcedTools };
    },
    setContent: (prompt: string, newContextPaths?: ContextPath[], newForcedTools?: ForcedToolGroup[]) => {
      const editor = editorRef.current;
      if (editor) { editor.textContent = prompt; setHasContent(!!prompt); }
      if (newContextPaths) setContextPaths(newContextPaths);
      if (newForcedTools) setForcedTools(newForcedTools);
    },
  }), [contextPaths, forcedTools]);

  const {
    handleSend, handlePickerSelect, handlePaste, handleKeyDown,
    handleInput, handleEditorClick, handleDragOver, handleDragLeave, handleDrop,
    addImageFiles, browseAndAttachFiles, removeImage,
  } = useChatSubmit({
    editorRef, attachedSkillsRef, disabled, autoRunMode,
    images, contextPaths, forcedTools, picker, skills, ownerId,
    elementSelection, onSend, onModeChange, setImages, setContextPaths,
    setForcedTools, setPicker, setHasContent, setAttachedSkills,
    setIsDragOver, c,
  });

  const handleCopyPath = (idx: number) => {
    navigator.clipboard.writeText(contextPaths[idx].path);
    setCopiedPathIdx(idx);
    setTimeout(() => setCopiedPathIdx((cur) => cur === idx ? null : cur), 1200);
  };

  const selectedElements = elementSelection?.elementsByOwner?.[ownerId] ?? [];
  const hasAttachments = images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0 || selectedElements.length > 0;
  const modeLabel = modesMap[mode]?.name || 'Agent';

  return (
    <Box ref={containerRef} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
      sx={{
        position: 'relative',
        ...(embedded ? {} : {
          mx: 1.5, mb: 1.5, borderRadius: '16px',
          border: isDragOver ? `1px solid ${c.accent.primary}` : `1px solid ${c.border.subtle}`,
          bgcolor: c.bg.surface, boxShadow: c.shadow.md, transition: 'border-color 0.15s',
        }),
      }}>

      {isDragOver && (
        <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(174,86,48,0.04)', zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '16px', pointerEvents: 'none' }}>
          <AttachFileIcon sx={{ fontSize: 16, color: c.accent.primary, mr: 0.5 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>Drop files here</Typography>
        </Box>
      )}

      <CommandPicker trigger={picker.trigger} filter={picker.filter}
        onSelect={handlePickerSelect}
        onClose={() => setPicker((prev) => ({ ...prev, visible: false }))}
        visible={picker.visible} />

      <ImageAttachments images={images} onRemoveImage={removeImage}
        lightboxSrc={lightboxSrc} onOpenLightbox={setLightboxSrc} onCloseLightbox={() => setLightboxSrc(null)} c={c} />

      <AttachmentChips contextPaths={contextPaths}
        onRemoveContextPath={(idx) => setContextPaths((prev) => prev.filter((_, i) => i !== idx))}
        copiedPathIdx={copiedPathIdx} onCopyPath={handleCopyPath}
        forcedTools={forcedTools}
        onRemoveForcedTool={(idx) => setForcedTools((prev) => prev.filter((_, i) => i !== idx))}
        selectedElements={selectedElements}
        onRemoveElement={(id) => elementSelection?.removeOwnerElement(ownerId, id)}
        hasImages={images.length > 0} c={c} />

      <Box sx={{ px: 1.5, pt: hasAttachments ? 0.5 : 1.25, pb: 0.25, position: 'relative' }}>
        <div ref={editorRef} contentEditable={!disabled} suppressContentEditableWarning
          onInput={handleInput} onClick={handleEditorClick} onKeyDown={handleKeyDown} onPaste={handlePaste}
          style={{
            width: '100%', minHeight: '1.5em', maxHeight: 200, overflowY: 'auto',
            background: 'transparent', border: 'none', outline: 'none', color: c.text.primary,
            fontSize: '0.875rem', lineHeight: '1.5', fontFamily: 'inherit',
            wordBreak: 'break-word', whiteSpace: 'pre-wrap',
          }} />
        {!hasContent && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            padding: `${hasAttachments ? 4 : 10}px 12px`,
            color: c.text.tertiary, fontSize: '0.875rem', lineHeight: '1.5',
            fontFamily: 'inherit', pointerEvents: 'none', userSelect: 'none',
          }}>
            {disabled ? 'Agent is working...' : autoRunMode ? 'Describe what data to generate…' : isRunning ? (queueLength > 0 ? `${queueLength} queued — type another or wait…` : 'Agent is working — messages will queue…') : `${modeLabel}, @ for context, / for commands`}
          </div>
        )}
      </Box>

      <ModelModeSelector mode={mode} onModeChange={onModeChange} model={model} onModelChange={onModelChange}
        provider={provider} onProviderChange={onProviderChange} contextEstimate={contextEstimate}
        ownerId={ownerId} sessionId={sessionId} autoRunMode={autoRunMode} hasContent={hasContent}
        isRunning={isRunning} disabled={disabled} onSend={handleSend} onStop={onStop}
        browseAndAttachFiles={browseAndAttachFiles}
        queueLength={queueLength} />
    </Box>
  );
});

ChatInput.displayName = 'ChatInput';

export default ChatInput;
