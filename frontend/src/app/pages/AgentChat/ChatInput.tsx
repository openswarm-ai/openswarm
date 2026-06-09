import React, { useState, useRef, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { serializeEditorContent, AttachedSkill } from '@/app/components/editor/richEditorUtils';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchModes } from '@/shared/state/modesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useChatInputModel } from './ChatInput/hooks/useChatInputModel';
import { useDraftLoad, deleteDraft, loadDraft } from './ChatInput/hooks/draftStore';
import { handleSlashCommand } from './ChatInput/hooks/slashCommands';
import { API_BASE, getAuthToken } from '@/shared/config';
import { materializeImages, appendSelectedElements, computeSendBlock } from './ChatInput/sendHelpers';
import { useImageAttachments } from './ChatInput/hooks/useImageAttachments';
import { useContextFiles } from './ChatInput/hooks/useContextFiles';
import { useModelPicker } from './ChatInput/hooks/useModelPicker';
import { useEditorHandlers } from './ChatInput/hooks/useEditorHandlers';
import { ChatInputView } from './ChatInput/view/ChatInputView';
import { ICON_MAP, FALLBACK_MODE_BASE } from './ChatInput/modeConfig';
import { AttachedImage, ForcedToolGroup, ChatInputHandle } from './ChatInput/types';

export type { AttachedImage, ForcedToolGroup, ChatInputHandle };
export type { AttachedSkill } from '@/app/components/editor/richEditorUtils';

interface Props {
  onSend: (message: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: ContextPath[], forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => void;
  disabled?: boolean;
  mode: string;
  onModeChange: (mode: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  provider?: string;
  onProviderChange?: (provider: string) => void;
  isRunning?: boolean;
  onStop?: () => void;
  autoRunMode?: boolean;
  contextEstimate?: { used: number; limit: number };
  embedded?: boolean;
  autoFocus?: boolean;
  sessionId?: string;
  queueLength?: number;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto';
  onThinkingLevelChange?: (level: 'off' | 'low' | 'medium' | 'high' | 'auto') => void;
  onActivityLabelChange?: (label: string | null) => void;
}

const ChatInput = forwardRef<ChatInputHandle, Props>(({ onSend, disabled, mode, onModeChange, model, onModelChange, provider, onProviderChange, isRunning, onStop, autoRunMode, contextEstimate, embedded, autoFocus, sessionId, queueLength = 0, thinkingLevel = 'auto', onThinkingLevelChange, onActivityLabelChange }, ref) => {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const generalFileInputRef = useRef<HTMLInputElement>(null);
  const dispatch = useAppDispatch();
  const elementSelection = useElementSelection();

  const fallbackOwnerIdRef = useRef(`input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const ownerId = sessionId || fallbackOwnerIdRef.current;

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  useDraftLoad(editorRef, ownerId);

  const [hasContent, setHasContent] = useState(() => !!loadDraft(ownerId));
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const attachedSkillsRef = useRef(attachedSkills);
  attachedSkillsRef.current = attachedSkills;

  const skills = useAppSelector((state) => state.skills.items);
  const modesMap = useAppSelector((state) => state.modes.items);
  const modesArr = useMemo(() => Object.values(modesMap), [modesMap]);
  const sessionFrameworkOverhead = useAppSelector((state) =>
    sessionId ? (state.agents.sessions[sessionId]?.framework_overhead_tokens ?? 0) : 0,
  );

  const { allModelOptions, currentModelCtx, pdfSupported, imageSupported } = useChatInputModel(model);
  const compactionInFlightRef = useRef(false);

  useEffect(() => () => onActivityLabelChange?.(null), [onActivityLabelChange]);

  useEffect(() => {
    if (modesArr.length === 0) dispatch(fetchModes());
  }, [dispatch, modesArr.length]);

  const [modeAnchor, setModeAnchor] = useState<HTMLElement | null>(null);
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
  const [thinkingAnchor, setThinkingAnchor] = useState<HTMLElement | null>(null);

  const picker = useModelPicker(allModelOptions, model, modelAnchor);
  const { images, setImages, addImageFiles, removeImage, lightboxSrc, setLightboxSrc } = useImageAttachments();

  const {
    isUploading,
    contextPaths, setContextPaths,
    forcedTools, setForcedTools,
    copiedPathIdx, setCopiedPathIdx,
    oversizeQueue,
    summarizingPath,
    summarizingAll,
    summarizeError, setSummarizeError,
    sendBlock, setSendBlock,
    uploadAndAttachFiles,
    detachOversize,
    detachAllOversize,
    summarizeOversize,
    summarizeAllOversize,
    pendingPayloadEstimate,
    pendingKinds,
    pendingSendRef,
  } = useContextFiles(currentModelCtx, model, contextEstimate, sessionFrameworkOverhead);

  useImperativeHandle(ref, () => ({
    getConfig: () => {
      const editor = editorRef.current;
      const prompt = editor
        ? (editor.tagName === 'TEXTAREA'
            ? (editor as unknown as HTMLTextAreaElement).value.trim()
            : serializeEditorContent(editor, attachedSkillsRef.current).trim())
        : '';
      return { prompt, contextPaths, forcedTools };
    },
    setContent: (prompt: string, newContextPaths?: ContextPath[], newForcedTools?: ForcedToolGroup[]) => {
      const editor = editorRef.current;
      if (editor) {
        if (editor.tagName === 'TEXTAREA') (editor as unknown as HTMLTextAreaElement).value = prompt; else editor.textContent = prompt;
        setHasContent(!!prompt);
      }
      if (newContextPaths) setContextPaths(newContextPaths);
      if (newForcedTools) setForcedTools(newForcedTools);
    },
  }), [contextPaths, forcedTools]);

  const handleSend = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    if (summarizingPath || summarizingAll) return;
    // If files are flagged too big, popup will appear above the input. Capture
    // the user's intent to send so once they pick Shrink all / Remove all and
    // the queue drains, the send fires automatically (zero extra clicks).
    if (oversizeQueue.length > 0) {
      pendingSendRef.current = () => { handleSend(); };
      return;
    }
    const serialized = editor.tagName === 'TEXTAREA'
      ? (editor as unknown as HTMLTextAreaElement).value
      : serializeEditorContent(editor, attachedSkillsRef.current);
    let trimmed = serialized.trim();
    if (!trimmed) return;

    const block = computeSendBlock({
      trimmed,
      currentModelCtx,
      historyUsed: contextEstimate?.used ?? 0,
      contextPaths, sessionFrameworkOverhead,
    });
    if (block) {
      if (block.kind === 'too_long') {
        // This one message is too big to send even with zero history, so
        // compaction can't save it. Hard-block and tell the user plainly; they
        // shorten it and the block clears on the next send attempt. Don't fire
        // /compact (pointless) and don't queue a retry (it'd just re-block).
        pendingSendRef.current = null;
        setSendBlock(block);
        return;
      }
      // kind === 'compacting': history is the overflow source, which we CAN
      // shrink. Auto-compact invisibly, then continue this same send.
      if (!sessionId || compactionInFlightRef.current) return;
      compactionInFlightRef.current = true;
      setSendBlock(null);
      onActivityLabelChange?.('Compacting memory');
      try {
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tok) headers['Authorization'] = `Bearer ${tok}`;
        const resp = await fetch(`${API_BASE}/agents/sessions/${sessionId}/compact`, { method: 'POST', headers });
        if (!resp.ok) throw new Error(`compact failed: ${resp.status}`);
      } catch (err) {
        console.error('[auto-compact] failed:', err);
      }
      compactionInFlightRef.current = false;
    }

    // Fits now (e.g. user shortened a too-long message): clear any lingering block banner.
    setSendBlock(null);

    onboardingBus.emit('chat:message_sent');
    if (window.location.hash.includes('/apps/')) {
      onboardingBus.emit('app:generation_started');
    }

    if (sessionId && trimmed.startsWith('/')) {
      const cmd = trimmed.split(/\s+/)[0].toLowerCase();
      const handled = await handleSlashCommand(cmd, sessionId);
      if (handled) {
        if (editor.tagName === 'TEXTAREA') (editor as unknown as HTMLTextAreaElement).value = ''; else editor.innerHTML = '';
        deleteDraft(ownerId);
        setHasContent(false);
        return;
      }
    }

    const selectedEls = elementSelection?.elementsByOwner?.[ownerId] ?? [];
    const allImages = await materializeImages(images);
    trimmed = appendSelectedElements(trimmed, selectedEls, allImages);

    const sendImages = allImages.length > 0 ? allImages : undefined;
    const allForcedToolNames = forcedTools.flatMap((ft) => ft.tools);
    const currentSkills = Object.values(attachedSkillsRef.current);
    const sendSkills = currentSkills.length > 0
      ? currentSkills.map((s) => ({ id: s.id, name: s.name, content: s.content }))
      : undefined;
    const browserIds = selectedEls
      .filter((el) => el.semanticType === 'browser-card' && el.semanticData?.selectId)
      .map((el) => el.semanticData!.selectId as string);
    onSend(
      trimmed,
      sendImages,
      contextPaths.length > 0 ? contextPaths : undefined,
      allForcedToolNames.length > 0 ? allForcedToolNames : undefined,
      sendSkills,
      browserIds.length > 0 ? browserIds : undefined,
    );
    if (editor.tagName === 'TEXTAREA') (editor as unknown as HTMLTextAreaElement).value = ''; else editor.innerHTML = '';
    deleteDraft(ownerId);
    for (const img of images) {
      if (img.preview?.startsWith('blob:')) {
        try { URL.revokeObjectURL(img.preview); } catch {}
      }
    }
    setImages([]);
    setContextPaths([]);
    setForcedTools([]);
    setAttachedSkills({});
    setHasContent(false);
    elementSelection?.clearOwnerElements(ownerId);
  }, [disabled, images, contextPaths, forcedTools, onSend, elementSelection, ownerId, summarizingPath, summarizingAll, oversizeQueue, pendingSendRef, sessionId, currentModelCtx, contextEstimate, sessionFrameworkOverhead, setSendBlock, onActivityLabelChange]);

  const {
    picker: editorPicker, setPicker,
    isDragOver,
    handleInput, handleEditorClick, handlePickerSelect, handleKeyDown, handlePaste,
    handleDragOver, handleDragLeave, handleDrop,
  } = useEditorHandlers({
    editorRef, generalFileInputRef, ownerId, sessionId, autoRunMode, c, skills,
    elementSelection, setHasContent, setAttachedSkills, setForcedTools, onModeChange,
    addImageFiles, uploadAndAttachFiles, handleSend,
  });

  const currentMode = modesMap[mode];
  const FALLBACK_MODE = { ...FALLBACK_MODE_BASE, color: c.accent.primary };
  const modeConf = currentMode
    ? { label: currentMode.name, icon: ICON_MAP[currentMode.icon] || ICON_MAP.smart_toy, color: currentMode.color }
    : FALLBACK_MODE;

  const selectedElements = elementSelection?.elementsByOwner?.[ownerId] ?? [];
  const hasAttachments = images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0 || selectedElements.length > 0;

  return (
    <ChatInputView
      c={c}
      containerRef={containerRef}
      editorRef={editorRef}
      generalFileInputRef={generalFileInputRef}
      embedded={embedded}
      isDragOver={isDragOver}
      isUploading={isUploading}
      handleDragOver={handleDragOver}
      handleDragLeave={handleDragLeave}
      handleDrop={handleDrop}
      editorPicker={editorPicker}
      setPicker={setPicker}
      handlePickerSelect={handlePickerSelect}
      sendBlock={sendBlock}
      setSendBlock={setSendBlock}
      sessionId={sessionId}
      images={images}
      setLightboxSrc={setLightboxSrc}
      removeImage={removeImage}
      contextPaths={contextPaths}
      setContextPaths={setContextPaths}
      copiedPathIdx={copiedPathIdx}
      setCopiedPathIdx={setCopiedPathIdx}
      pdfSupported={pdfSupported}
      imageSupported={imageSupported}
      forcedTools={forcedTools}
      setForcedTools={setForcedTools}
      selectedElements={selectedElements}
      elementSelection={elementSelection}
      ownerId={ownerId}
      disabled={disabled}
      hasContent={hasContent}
      hasAttachments={hasAttachments}
      autoRunMode={autoRunMode}
      isRunning={isRunning}
      queueLength={queueLength}
      modeConf={modeConf}
      handleInput={handleInput}
      handleEditorClick={handleEditorClick}
      handleKeyDown={handleKeyDown}
      handlePaste={handlePaste}
      modesArr={modesArr}
      mode={mode}
      onModeChange={onModeChange}
      iconMap={ICON_MAP}
      modeAnchor={modeAnchor}
      setModeAnchor={setModeAnchor}
      modelAnchor={modelAnchor}
      setModelAnchor={setModelAnchor}
      thinkingAnchor={thinkingAnchor}
      setThinkingAnchor={setThinkingAnchor}
      allModelFlat={allModelOptions.flat}
      model={model}
      onModelChange={onModelChange}
      onProviderChange={onProviderChange}
      picker={picker}
      pendingKinds={pendingKinds}
      pendingPayloadEstimate={pendingPayloadEstimate}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={onThinkingLevelChange}
      contextEstimate={contextEstimate}
      addImageFiles={addImageFiles}
      uploadAndAttachFiles={uploadAndAttachFiles}
      onStop={onStop}
      handleSend={handleSend}
      lightboxSrc={lightboxSrc}
      oversizeQueue={oversizeQueue}
      summarizingPath={summarizingPath}
      summarizingAll={summarizingAll}
      summarizeOversize={summarizeOversize}
      summarizeAllOversize={summarizeAllOversize}
      detachOversize={detachOversize}
      detachAllOversize={detachAllOversize}
      currentModelCtx={currentModelCtx}
      summarizeError={summarizeError}
      setSummarizeError={setSummarizeError}
    />
  );
});

ChatInput.displayName = 'ChatInput';

// Shallow memo: AgentChat re-renders from unrelated session-local state shouldn't churn ChatInput.
export default React.memo(ChatInput);
