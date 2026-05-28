import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { API_BASE, getAuthToken } from '@/shared/config';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { SendBlock } from '../hooks/useContextFiles';

interface Props {
  sendBlock: NonNullable<SendBlock>;
  c: ClaudeTokens;
  sessionId?: string;
  setSendBlock: (v: SendBlock) => void;
  setContextPaths: React.Dispatch<React.SetStateAction<ContextPath[]>>;
  setModelAnchor: (el: HTMLElement | null) => void;
}

export const SendBlockBanner: React.FC<Props> = ({ sendBlock, c, sessionId, setSendBlock, setContextPaths, setModelAnchor }) => {
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  const over = sendBlock.estimate - sendBlock.window;
  return (
    <Box sx={{ mx: 1.5, mt: 1, mb: 0.5, p: 1.25, borderRadius: '10px', border: `1px solid ${c.status.error}`, bgcolor: `${c.status.error}10` }}>
      <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: c.status.error, mb: 0.5 }}>
        This send would overflow the model's context window
      </Typography>
      <Typography sx={{ fontSize: '0.72rem', color: c.text.secondary, mb: 0.75, fontVariantNumeric: 'tabular-nums' }}>
        ~{fmt(sendBlock.estimate)} of {fmt(sendBlock.window)} tokens ({over > 0 ? `${fmt(over)} over` : 'at cap'}). History {fmt(sendBlock.history)} · Files {fmt(sendBlock.files)} · Tools/MCPs {fmt(sendBlock.framework)} · This message {fmt(sendBlock.prompt)}.
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
        {sessionId && (
          <Box
            component="button"
            onClick={async () => {
              try {
                const tok = (() => { try { return getAuthToken(); } catch { return ''; } })();
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (tok) headers['Authorization'] = `Bearer ${tok}`;
                await fetch(`${API_BASE}/agents/sessions/${sessionId}/compact`, { method: 'POST', headers });
                setSendBlock(null);
              } catch (err) { console.error(err); }
            }}
            sx={{
              background: c.accent.primary, color: '#fff', border: 'none', borderRadius: '6px',
              px: 1, py: 0.5, fontSize: '0.72rem', cursor: 'pointer', '&:hover': { opacity: 0.9 },
            }}
          >
            Compact memory
          </Box>
        )}
        {sendBlock.largestFile && (
          <Box
            component="button"
            onClick={() => {
              const p = sendBlock.largestFile!.path;
              setContextPaths((prev) => prev.filter((cp) => cp.path !== p));
              setSendBlock(null);
            }}
            sx={{
              background: 'transparent', color: c.text.primary, border: `1px solid ${c.border.subtle}`,
              borderRadius: '6px', px: 1, py: 0.5, fontSize: '0.72rem', cursor: 'pointer',
              '&:hover': { background: c.bg.secondary },
            }}
          >
            Detach largest file (~{fmt(sendBlock.largestFile.tokens)})
          </Box>
        )}
        <Box
          component="button"
          onClick={(e) => { setModelAnchor(e.currentTarget as HTMLElement); setSendBlock(null); }}
          sx={{
            background: 'transparent', color: c.text.primary, border: `1px solid ${c.border.subtle}`,
            borderRadius: '6px', px: 1, py: 0.5, fontSize: '0.72rem', cursor: 'pointer',
            '&:hover': { background: c.bg.secondary },
          }}
        >
          Switch model
        </Box>
        <Box
          component="button"
          onClick={() => setSendBlock(null)}
          sx={{
            background: 'transparent', color: c.text.muted, border: 'none',
            borderRadius: '6px', px: 1, py: 0.5, fontSize: '0.72rem', cursor: 'pointer',
            '&:hover': { background: c.bg.secondary },
          }}
        >
          Dismiss
        </Box>
      </Box>
    </Box>
  );
};
