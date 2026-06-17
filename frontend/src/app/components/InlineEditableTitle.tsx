import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import type { SxProps, Theme } from '@mui/material/styles';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  // Current title as shown to the user; seeds the edit field.
  value: string;
  // Called with the trimmed new title only when it actually changed.
  onCommit: (next: string) => void;
  // Layout + text styling shared by the read-only text and the input so the
  // two states line up (pass flex/font/color here).
  sx?: SxProps<Theme>;
  placeholder?: string;
  // Optional custom display node (e.g. the chat card's Typewriter); falls
  // back to a plain Typography of `value` when omitted.
  children?: React.ReactNode;
}

// Click-to-rename title. Reads as plain text until clicked, then becomes an
// inline input that commits on Enter/blur and cancels on Escape. Lives on
// pointer-drag card headers, so it stops pointer propagation (+ data-no-drag)
// to avoid starting a card drag while editing.
export default function InlineEditableTitle({ value, onCommit, sx, placeholder, children }: Props) {
  const c = useClaudeTokens();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const begin = useCallback(() => { setDraft(value); setEditing(true); }, [value]);

  const commit = useCallback(() => {
    const t = draft.trim();
    if (t && t !== value) onCommit(t);
    setEditing(false);
  }, [draft, value, onCommit]);

  if (editing) {
    return (
      <InputBase
        inputRef={inputRef}
        data-no-drag
        value={draft}
        placeholder={placeholder}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        sx={{ ...sx, '& input::placeholder': { color: c.text.muted, opacity: 1 } }}
      />
    );
  }

  return (
    <Box
      onClick={begin}
      // Card headers drag via onPointerDown + preventDefault, which otherwise
      // swallows this click. Stop the pointer here so the click reaches us and
      // enters edit mode (same trick the draft-title InputBase uses).
      onPointerDown={(e) => e.stopPropagation()}
      title="Click to rename"
      sx={{
        minWidth: 0, cursor: 'text', borderRadius: 0.5, px: 0.25, mx: -0.25,
        '&:hover': { bgcolor: c.bg.elevated },
        ...sx,
      }}
    >
      {children ?? (
        <Typography sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...sx }}>
          {value}
        </Typography>
      )}
    </Box>
  );
}
