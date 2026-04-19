import React, { useState, useRef, useCallback, useEffect } from 'react';
import { CommandPickerItem } from './CommandPicker/components/commandPickerTypes';
import {
  SKILL_PILL_ATTR,
  AttachedSkill,
  createSkillPillElement,
  serializeEditorContent,
  deserializeToEditor,
  detectEditorTrigger,
  TriggerState,
  EMPTY_TRIGGER,
} from './richEditorUtils';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { RichPromptEditorProps, LINE_HEIGHT, FONT_SIZE } from './richPromptEditorTypes';

export function useRichPromptEditor({
  value,
  onChange,
  minRows = 3,
  maxRows = 8,
}: RichPromptEditorProps) {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const attachedSkillsRef = useRef(attachedSkills);
  attachedSkillsRef.current = attachedSkills;
  const removeSkillPillRef = useRef<(id: string) => void>(() => {});
  const [picker, setPicker] = useState<TriggerState>(EMPTY_TRIGGER);
  const [pickerRect, setPickerRect] = useState<DOMRect | null>(null);
  const skills = useAppSelector((state) => state.skills.items);

  useEffect(() => {
    if (picker.visible && wrapperRef.current) {
      setPickerRect(wrapperRef.current.getBoundingClientRect());
    } else {
      setPickerRect(null);
    }
  }, [picker.visible]);

  const minHeight = minRows * FONT_SIZE * LINE_HEIGHT;
  const maxHeight = maxRows * FONT_SIZE * LINE_HEIGHT;
  const isLabelFloating = focused || hasContent;

  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;

    if (/\{\{skill:.+?\}\}/.test(value)) {
      const skillsByName: Record<string, AttachedSkill> = {};
      for (const s of Object.values(skills)) {
        skillsByName[s.name] = { id: s.id, name: s.name, content: s.content };
      }
      const restored = deserializeToEditor(
        editor,
        value,
        skillsByName,
        (id) => removeSkillPillRef.current(id),
        c.font.mono,
        c.status.error,
      );
      setAttachedSkills(restored);
    } else {
      editor.textContent = value;
    }
    setHasContent(!!value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const emitChange = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const serialized = serializeEditorContent(editor, attachedSkillsRef.current);
    lastEmittedRef.current = serialized;
    onChange(serialized);
  }, [onChange]);

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
    updateHasContent();
    emitChange();
    editor.focus();
  }, [updateHasContent, emitChange]);
  removeSkillPillRef.current = removeSkillPill;

  const detectTrigger = useCallback(() => {
    const result = detectEditorTrigger();
    if (result) {
      setPicker(result);
    } else {
      setPicker((p) => ({ ...p, visible: false }));
    }
  }, []);

  const handleInput = useCallback(() => {
    updateHasContent();
    detectTrigger();
    syncAttachedSkills();
    emitChange();
  }, [updateHasContent, detectTrigger, syncAttachedSkills, emitChange]);

  const handleEditorClick = useCallback(() => {
    detectTrigger();
  }, [detectTrigger]);

  const handlePickerSelect = (item: CommandPickerItem) => {
    setPicker((p) => ({ ...p, visible: false }));
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
      document.execCommand('insertText', false, item.name);
    } else if (item.type === 'context') {
      document.execCommand('insertText', false, `@${item.command} `);
    }

    updateHasContent();
    emitChange();
    setTimeout(() => editor.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (picker.visible && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const plain = e.clipboardData.getData('text/plain');
    if (plain) document.execCommand('insertText', false, plain);
  }, []);

  return {
    c, editorRef, wrapperRef, focused, setFocused, hasContent,
    picker, setPicker, pickerRect,
    minHeight, maxHeight, isLabelFloating,
    handleInput, handleEditorClick, handlePickerSelect,
    handleKeyDown, handlePaste, updateHasContent, emitChange,
  };
}
