import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Fade from '@mui/material/Fade';
import { API_BASE } from '@/shared/config';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Shown ONCE per version, right after an update: what actually changed, in the same words the Help
// agent and the GitHub release body carry. A release that ships with no story is a bug the backend
// test catches; a user who never hears about the fix is the bug this card catches.
interface WhatsNew {
  version: string;
  headline: string;
  highlights: string[];
  fixes: string[];
}

const SEEN_KEY = 'openswarm.whatsNew.seenVersion';

export default function WhatsNewCard(): React.ReactElement | null {
  const c = useClaudeTokens();
  const [note, setNote] = React.useState<WhatsNew | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/help/whats-new`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: WhatsNew | null) => {
        if (cancelled || !data?.version) return;
        let seen: string | null = null;
        try { seen = window.localStorage.getItem(SEEN_KEY); } catch { /* private mode */ }
        if (seen === data.version) return;
        setNote(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const dismiss = React.useCallback(() => {
    if (note) {
      try { window.localStorage.setItem(SEEN_KEY, note.version); } catch { /* private mode */ }
    }
    setNote(null);
  }, [note]);

  if (!note) return null;
  const lines = [...note.highlights.map((t) => ({ t, kind: 'new' })), ...note.fixes.map((t) => ({ t, kind: 'fixed' }))];

  return (
    <Fade in timeout={{ enter: 260, exit: 200 }}>
      <Box
        data-select-type="whats-new"
        sx={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1450, width: 380, maxWidth: '90vw',
          bgcolor: c.bg.surface, border: `1px solid ${c.border.medium}`, borderRadius: '14px',
          boxShadow: '0 18px 44px rgba(0,0,0,0.28)', p: 2,
        }}
      >
        <Typography sx={{ fontSize: c.font.size.sm, color: c.text.muted, mb: 0.25 }}>
          {`What's new in ${note.version}`}
        </Typography>
        <Typography sx={{ fontSize: c.font.size.base, fontWeight: 600, color: c.text.primary, mb: 1.25 }}>
          {note.headline}
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 2, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {lines.slice(0, 5).map((l) => (
            <Typography key={l.t} component="li" sx={{ fontSize: c.font.size.sm, color: c.text.secondary, lineHeight: 1.5 }}>
              {l.t}
            </Typography>
          ))}
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
          <Button size="small" onClick={dismiss} sx={{ color: c.accent.primary, fontWeight: 600, textTransform: 'none' }}>
            Got it
          </Button>
        </Box>
      </Box>
    </Fade>
  );
}
