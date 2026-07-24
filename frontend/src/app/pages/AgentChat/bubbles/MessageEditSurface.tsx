import React, { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import {
  deserializeToEditor, serializeEditorContent, type AttachedSkill,
} from '@/app/components/editor/richEditorUtils';

const SKILL_RE = /\{\{skill:([^}]+)\}\}/g;

// Reconstruct the AttachedSkill map from a message's raw {{skill:X}} markers so the edit surface can
// render them as real chips (like the composer) instead of the ugly raw braces the old textarea showed.
function skillsFromText(text: string): Record<string, AttachedSkill> {
  const byName: Record<string, AttachedSkill> = {};
  let i = 0;
  for (const m of text.matchAll(SKILL_RE)) {
    const name = m[1];
    if (!byName[name]) byName[name] = { id: `edit-skill-${i++}-${name}`, name, content: '' };
  }
  return byName;
}

interface Props {
  // The editable prose (everything before the element-context block). Skill markers render as chips.
  userMessage: string;
  // The trailing "Selected UI Elements" block (or ''), preserved read-only and re-attached on save.
  elementSuffix: string;
  // Human labels for the preserved element context, shown as quiet read-only chips.
  elementLabels: string[];
  onSave: (fullContent: string) => void;
  onCancel: () => void;
}

// Pill-aware, in-place edit for a user message: same contenteditable + skill-chip grammar as the main
// composer, so editing a message with skills/selected-elements no longer dumps raw {{skill:...}} and
// "---Selected UI Elements---" text into a bare textarea. Elements stay attached (read-only) across an edit.
const MessageEditSurface: React.FC<Props> = ({ userMessage, elementSuffix, elementLabels, onSave, onCancel }) => {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const skillsRef = useRef<Record<string, AttachedSkill>>({});

  // Populate the contenteditable ONCE (uncontrolled: React must not re-write innerHTML under the cursor).
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const remove = (id: string): void => { delete skillsRef.current[id]; };
    skillsRef.current = deserializeToEditor(el, userMessage, skillsFromText(userMessage), remove, c.font.mono, c.status.error);
    el.focus();
    // Cursor to the end so typing appends, matching how you'd resume the message.
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (): void => {
    const el = editorRef.current;
    if (!el) return;
    const edited = serializeEditorContent(el, skillsRef.current).trim();
    if (!edited) return; // never let an edit blank the message
    onSave(edited + elementSuffix);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, width: '100%' }}>
      {elementLabels.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {elementLabels.map((label, i) => (
            <Box key={i} sx={{ fontSize: '0.6875rem', color: c.text.muted, bgcolor: 'rgba(255,255,255,0.06)', border: `1px solid ${c.border.subtle}`, borderRadius: '999px', px: 0.9, py: 0.15, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
            </Box>
          ))}
        </Box>
      )}
      <Box
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        sx={{
          color: c.text.primary,
          fontSize: '0.875rem',
          lineHeight: 1.55,
          bgcolor: 'rgba(255,255,255,0.06)',
          borderRadius: '10px',
          px: 1.25,
          py: 1,
          minHeight: '1.55em',
          outline: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          '&:focus': { boxShadow: `0 0 0 1px ${c.accent.primary}55` },
        }}
      />
      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end', alignItems: 'center' }}>
        <Button size="small" onClick={onCancel} sx={{ color: c.text.muted, fontSize: '0.75rem', textTransform: 'none', minWidth: 0, px: 1 }}>Cancel</Button>
        <Button size="small" onClick={save} sx={{ color: c.accent.primary, fontWeight: 600, fontSize: '0.75rem', textTransform: 'none', minWidth: 0, px: 1 }}>Save</Button>
      </Box>
    </Box>
  );
};

export default MessageEditSurface;
