import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import { API_BASE, getAuthToken } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface FollowupChipsProps {
  sessionId: string | undefined;
  /** True while a turn is running; chips hide and refetch on the next settle. */
  busy: boolean;
  /** Message count of the session; a change while idle means a turn landed, time to refresh. */
  messageCount: number;
  enabled: boolean;
  onPick: (prompt: string) => void;
}

// Chat-specific follow-ups in the user's own voice, Claude-style chips above the composer. The
// backend stays silent until the chat has >= 2 real exchanges, so rendering [] as nothing IS the
// turn gate; clicking sends immediately (the text is already written the way the user types).
const FollowupChips: React.FC<FollowupChipsProps> = ({ sessionId, busy, messageCount, enabled, onPick }) => {
  const c = useClaudeTokens();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    if (!sessionId || !enabled || busy) {
      setSuggestions([]);
      return undefined;
    }
    const seq = ++fetchSeqRef.current;
    // Small settle delay so the fetch reads the turn's final transcript, not a mid-commit state.
    const timer = setTimeout(async () => {
      try {
        const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
        const headers: Record<string, string> = {};
        if (tok) headers['Authorization'] = `Bearer ${tok}`;
        // Same after-turn beat also feeds the memory distiller; fire-and-forget, backend gates cost.
        void fetch(`${API_BASE}/memory/distill/${sessionId}`, { method: 'POST', headers }).catch(() => {});
        const resp = await fetch(`${API_BASE}/agents/sessions/${sessionId}/followups?count=3`, { headers });
        if (!resp.ok || seq !== fetchSeqRef.current) return;
        const data = await resp.json();
        if (seq !== fetchSeqRef.current) return;
        setSuggestions(Array.isArray(data.suggestions)
          ? data.suggestions.filter((s: unknown): s is string => typeof s === 'string' && !!s)
          : []);
      } catch { /* fail open: no chips */ }
    }, 900);
    return () => clearTimeout(timer);
  }, [sessionId, enabled, busy, messageCount]);

  if (suggestions.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, px: 2, pb: 1 }}>
      {suggestions.map((s) => (
        <Box
          key={s}
          role="button"
          onClick={() => { setSuggestions([]); onPick(s); }}
          sx={{
            px: 1.25,
            py: 0.5,
            borderRadius: 999,
            border: `1px solid ${c.border.medium}`,
            bgcolor: c.bg.surface,
            color: c.text.secondary,
            fontSize: '0.8125rem',
            lineHeight: 1.4,
            cursor: 'pointer',
            userSelect: 'none',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            transition: 'border-color 0.15s ease, color 0.15s ease, background 0.15s ease',
            '&:hover': { borderColor: c.border.strong, color: c.text.primary, bgcolor: c.bg.elevated },
          }}
        >
          {s}
        </Box>
      ))}
    </Box>
  );
};

export default FollowupChips;
