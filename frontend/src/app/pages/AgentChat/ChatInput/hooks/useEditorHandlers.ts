import { useState, useRef, useCallback, RefObject } from 'react';
import { CommandPickerItem } from '@/app/components/editor/CommandPicker';
import { useElementSelection } from '@/app/components/editor/ElementSelectionContext';
import {
  SKILL_PILL_ATTR,
  AttachedSkill,
  createSkillPillElement,
  detectEditorTrigger,
  TriggerState,
  EMPTY_TRIGGER,
} from '@/app/components/editor/richEditorUtils';
import { useAppDispatch } from '@/shared/hooks';
import { clearSessionMessages } from '@/shared/state/agentsSlice';
import { scheduleDraftSave } from './draftStore';
import { handleSlashCommand } from './slashCommands';
import { tryPasteClipboardCards } from './pasteCards';
import { ForcedToolGroup } from '../types';

type Skill = { id: string; name: string; content: string };

interface Params {
  editorRef: RefObject<HTMLDivElement>;
  generalFileInputRef: RefObject<HTMLInputElement>;
  ownerId: string;
  sessionId?: string;
  autoRunMode?: boolean;
  c: any;
  skills: Record<string, Skill>;
  elementSelection: ReturnType<typeof useElementSelection>;
  setHasContent: (v: boolean) => void;
  setAttachedSkills: React.Dispatch<React.SetStateAction<Record<string, AttachedSkill>>>;
  setForcedTools: React.Dispatch<React.SetStateAction<ForcedToolGroup[]>>;
  onModeChange: (mode: string) => void;
  addImageFiles: (files: FileList | File[]) => void;
  uploadAndAttachFiles: (files: File[]) => void;
  handleSend: () => void;
}

export function useEditorHandlers(p: Params) {
  const {
    editorRef, generalFileInputRef, ownerId, sessionId, autoRunMode, c, skills,
    elementSelection, setHasContent, setAttachedSkills, setForcedTools, onModeChange,
    addImageFiles, uploadAndAttachFiles, handleSend,
  } = p;
  const dispatch = useAppDispatch();
  const [picker, setPicker] = useState<TriggerState>(EMPTY_TRIGGER);
  const [isDragOver, setIsDragOver] = useState(false);
  // Set by handlePaste before the synthetic input fires so handleInput skips post-input scans paste can't invalidate.
  const justPastedRef = useRef(false);

  const updateHasContent = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    const hasPills = editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null;
    setHasContent(text.trim().length > 0 || hasPills);
  }, []);

  const syncAttachedSkills = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const pillIds = new Set(
      Array.from(editor.querySelectorAll(`[${SKILL_PILL_ATTR}]`))
        .map((el) => el.getAttribute(SKILL_PILL_ATTR))
        .filter(Boolean) as string[],
    );
    setAttachedSkills((prev) => {
      const prevKeys = Object.keys(prev);
      if (prevKeys.length === pillIds.size && prevKeys.every((k) => pillIds.has(k))) return prev;
      const next: Record<string, AttachedSkill> = {};
      for (const [id, skill] of Object.entries(prev)) {
        if (pillIds.has(id)) next[id] = skill;
      }
      return next;
    });
  }, []);

  const removeSkillPill = useCallback((skillId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const pill = editor.querySelector(`[${SKILL_PILL_ATTR}="${skillId}"]`);
    if (pill) pill.remove();
    setAttachedSkills((prev) => {
      const { [skillId]: _, ...rest } = prev;
      return rest;
    });
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    const hasPills = editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null;
    setHasContent(text.trim().length > 0 || hasPills);
    editor.focus();
  }, []);

  const detectTrigger = useCallback(() => {
    const result = detectEditorTrigger();
    if (result) {
      setPicker(result);
    } else {
      // Bailout when already hidden; otherwise spreading a new object re-renders all of ChatInput on every keystroke (~199ms input delay).
      setPicker((prev) => prev.visible ? { ...prev, visible: false } : prev);
    }
  }, []);

  const handleInput = useCallback(() => {
    if (justPastedRef.current) {
      justPastedRef.current = false;
      setHasContent(true);
      scheduleDraftSave(ownerId, () => editorRef.current?.innerHTML ?? '');
      return;
    }
    updateHasContent();
    detectTrigger();
    syncAttachedSkills();
    scheduleDraftSave(ownerId, () => editorRef.current?.innerHTML ?? '');
  }, [updateHasContent, detectTrigger, syncAttachedSkills, ownerId]);

  const handleEditorClick = useCallback(() => {
    detectTrigger();
  }, [detectTrigger]);

  const handlePickerSelect = (item: CommandPickerItem) => {
    setPicker((prev) => ({ ...prev, visible: false }));
    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();

    const { triggerNode, triggerOffset, filter } = picker;
    if (triggerNode && triggerNode.parentNode && editor.contains(triggerNode)) {
      const endOffset = Math.min(triggerOffset + 1 + filter.length, triggerNode.length);
      const range = document.createRange();
      range.setStart(triggerNode, triggerOffset);
      range.setEnd(triggerNode, endOffset);
      range.deleteContents();
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }

    if (item.type === 'skill') {
      const skill = skills[item.id];
      if (!skill) return;
      if (editor.querySelector(`[${SKILL_PILL_ATTR}="${skill.id}"]`)) return;

      const pill = createSkillPillElement(
        { id: skill.id, name: skill.name, content: skill.content },
        removeSkillPill,
        c.font.mono,
        c.status.error,
      );

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode(pill);
        const spacer = document.createTextNode('\u200B');
        pill.after(spacer);
        const newRange = document.createRange();
        newRange.setStartAfter(spacer);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }

      setAttachedSkills((prev) => ({
        ...prev,
        [skill.id]: { id: skill.id, name: skill.name, content: skill.content },
      }));
    } else if (item.type === 'mode') {
      onModeChange(item.id);
    } else if (item.type === 'context') {
      if (item.command === 'file') {
        generalFileInputRef.current?.click();
      } else if (item.toolNames && item.toolNames.length > 0) {
        setForcedTools((prev) => [...prev, { label: item.name, tools: item.toolNames!, icon: item.icon, iconKey: item.iconKey }]);
      } else {
        document.execCommand('insertText', false, `@${item.command} `);
      }
    }

    updateHasContent();
    setTimeout(() => editor.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (picker.visible && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (sessionId) {
        handleSlashCommand('/clear', sessionId).catch(() => {});
        dispatch(clearSessionMessages(sessionId));
      }
      const editor = editorRef.current;
      if (editor) {
        editor.innerHTML = '';
        updateHasContent();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !autoRunMode) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (tryPasteClipboardCards(elementSelection, ownerId)) {
      e.preventDefault();
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImageFiles(imageFiles);
      return;
    }
    e.preventDefault();
    const plain = e.clipboardData.getData('text/plain');
    if (plain) {
      justPastedRef.current = true;
      document.execCommand('insertText', false, plain);
    }
  }, [addImageFiles, elementSelection, ownerId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length === 0) return;
    const allFiles = Array.from(e.dataTransfer.files);
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const otherFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0) addImageFiles(imageFiles);
    if (otherFiles.length > 0) uploadAndAttachFiles(otherFiles);
  }, [addImageFiles, uploadAndAttachFiles]);

  return {
    picker, setPicker,
    isDragOver,
    updateHasContent,
    handleInput, handleEditorClick, handlePickerSelect, handleKeyDown, handlePaste,
    handleDragOver, handleDragLeave, handleDrop,
  };
}
