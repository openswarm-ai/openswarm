import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CommandPicker, { CommandPickerItem } from '@/app/components/CommandPicker';
import {
  SKILL_PILL_ATTR,
  AttachedSkill,
  createSkillPillElement,
  serializeEditorContent,
  detectEditorTrigger,
  TriggerState,
  EMPTY_TRIGGER,
} from '@/app/components/richEditorUtils';
import TemplateInvokeModal from '@/app/pages/AgentChat/TemplateInvokeModal';
import { useAppSelector } from '@/shared/hooks';
import { PromptTemplate } from '@/shared/state/templatesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface RichPromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
}

const LINE_HEIGHT = 1.5;
const FONT_SIZE = 0.85;

const RichPromptEditor: React.FC<RichPromptEditorProps> = ({
  value,
  onChange,
  label = '',
  placeholder = '',
  minRows = 3,
  maxRows = 8,
}) => {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const attachedSkillsRef = useRef(attachedSkills);
  attachedSkillsRef.current = attachedSkills;

  const [picker, setPicker] = useState<TriggerState>(EMPTY_TRIGGER);
  const [pickerRect, setPickerRect] = useState<DOMRect | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);

  const templates = useAppSelector((state) => state.templates.items);
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

  // Sync external value → editor on mount / when value changes externally
  const lastEmittedRef = useRef(value);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    // External change — update editor content
    lastEmittedRef.current = value;
    editor.textContent = value;
    setHasContent(!!value);
  }, [value]);

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

    if (item.type === 'template') {
      const tmpl = templates[item.id];
      if (!tmpl) return;
      if (tmpl.fields.length === 0) {
        document.execCommand('insertText', false, tmpl.template);
      } else {
        setSelectedTemplate(tmpl);
      }
    } else if (item.type === 'skill') {
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
      return;
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const plain = e.clipboardData.getData('text/plain');
    if (plain) document.execCommand('insertText', false, plain);
  }, []);

  return (
    <Box ref={wrapperRef} sx={{ position: 'relative' }}>
      {picker.visible && pickerRect && createPortal(
        <div
          style={{
            position: 'fixed',
            top: pickerRect.top,
            left: pickerRect.left,
            width: pickerRect.width,
            height: 0,
            zIndex: 1400,
            pointerEvents: 'none',
          }}
        >
          <div style={{ position: 'relative', width: '100%', pointerEvents: 'auto' }}>
            <CommandPicker
              trigger={picker.trigger}
              filter={picker.filter}
              onSelect={handlePickerSelect}
              onClose={() => setPicker((p) => ({ ...p, visible: false }))}
              visible={picker.visible}
            />
          </div>
        </div>,
        document.body,
      )}

      <Box
        onClick={() => editorRef.current?.focus()}
        sx={{
          position: 'relative',
          border: `1px solid ${focused ? c.accent.primary : c.border.medium}`,
          borderRadius: '4px',
          bgcolor: c.bg.page,
          transition: 'border-color 0.15s',
          '&:hover': {
            borderColor: focused ? c.accent.primary : c.text.primary,
          },
          cursor: 'text',
        }}
      >
        {label && (
          <Typography
            component="label"
            sx={{
              position: 'absolute',
              left: 12,
              top: isLabelFloating ? -1 : '50%',
              transform: isLabelFloating ? 'translateY(-50%) scale(0.75)' : 'translateY(-50%)',
              transformOrigin: 'top left',
              color: focused ? c.accent.primary : c.text.tertiary,
              fontSize: '1rem',
              lineHeight: 1,
              pointerEvents: 'none',
              transition: 'all 0.15s ease',
              bgcolor: isLabelFloating ? c.bg.page : 'transparent',
              px: isLabelFloating ? 0.5 : 0,
              zIndex: 1,
            }}
          >
            {label}
          </Typography>
        )}

        <Box sx={{ px: 1.75, pt: label ? 2 : 1.25, pb: 1.25, position: 'relative' }}>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onClick={handleEditorClick}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{
              width: '100%',
              minHeight: `${minHeight}rem`,
              maxHeight: `${maxHeight}rem`,
              overflowY: 'auto',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: c.text.primary,
              fontSize: `${FONT_SIZE}rem`,
              lineHeight: `${LINE_HEIGHT}`,
              fontFamily: 'inherit',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          />
          {!hasContent && (
            <div
              style={{
                position: 'absolute',
                top: label ? 16 : 10,
                left: 14,
                right: 14,
                color: c.text.tertiary,
                fontSize: `${FONT_SIZE}rem`,
                lineHeight: `${LINE_HEIGHT}`,
                fontFamily: 'inherit',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {placeholder}
            </div>
          )}
        </Box>
      </Box>

      {selectedTemplate && (
        <TemplateInvokeModal
          template={selectedTemplate}
          open={!!selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onApply={(rendered) => {
            const editor = editorRef.current;
            if (editor) {
              document.execCommand('insertText', false, rendered);
            }
            setSelectedTemplate(null);
            updateHasContent();
            emitChange();
          }}
        />
      )}
    </Box>
  );
};

export default RichPromptEditor;
