import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export const IS_MAC = /Mac/.test(navigator.platform);

/** Platform default for the dictation hotkey; F5 is deliberately absent (macOS routes it to Siri before apps ever see it). */
export function dictationDefaultCombo(): string {
  // fn/Globe on mac (native watcher), Ctrl+Win on windows: the same physical bottom-corner key.
  return IS_MAC ? 'Fn' : 'Ctrl+Meta';
}

export function comboDisplay(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'Fn') return 'fn';
      if (p === 'Meta') return IS_MAC ? '⌘' : 'Win';
      if (p === 'Ctrl') return IS_MAC ? '⌃' : 'Ctrl';
      if (p === 'Alt') return IS_MAC ? '⌥' : 'Alt';
      if (p === 'Shift') return IS_MAC ? '⇧' : 'Shift';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(IS_MAC ? '' : '+');
}

/** Click-to-record shortcut chip: click arms it, the next non-modifier keydown becomes the combo ("Meta+Shift+d" parts format, same as new_agent_shortcut). */
const ShortcutRecorderChip: React.FC<{ value: string; onChange: (combo: string) => void }> = ({ value, onChange }) => {
  const c = useClaudeTokens();
  const [recording, setRecording] = useState(false);
  return (
    <Box
      tabIndex={0}
      onKeyDown={(e) => {
        if (!recording) return;
        if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
        e.preventDefault();
        if (e.key === 'Escape') { setRecording(false); return; }
        const parts: string[] = [];
        if (e.metaKey) parts.push('Meta');
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
        onChange(parts.join('+'));
        setRecording(false);
      }}
      onBlur={() => setRecording(false)}
      onClick={() => setRecording(true)}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.5,
        py: 0.75,
        borderRadius: `${c.radius.sm}px`,
        border: `1px solid ${recording ? c.accent.primary : c.border.medium}`,
        cursor: 'pointer',
        outline: 'none',
        transition: 'border-color 0.15s',
        '&:hover': { borderColor: c.accent.primary },
      }}
    >
      <KeyboardIcon sx={{ fontSize: 16, color: recording ? c.accent.primary : c.text.tertiary }} />
      {recording ? (
        <Typography sx={{ fontSize: '0.8125rem', color: c.accent.primary, fontWeight: 500 }}>
          Press shortcut…
        </Typography>
      ) : (
        <Typography sx={{ fontSize: '0.8125rem', color: c.text.primary, fontFamily: c.font.mono, fontWeight: 500 }}>
          {comboDisplay(value)}
        </Typography>
      )}
    </Box>
  );
};

export default ShortcutRecorderChip;
