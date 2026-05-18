import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

/** /context drawer: shows session MCPs, ctx%, cache hits, compaction. Opened via window CustomEvent from ChatInput's slash handler. */
export default function ContextDrawer() {
  const c = useClaudeTokens();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const session = useAppSelector((state) => (openFor ? state.agents.sessions[openFor] : undefined));

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.open && detail?.sessionId) setOpenFor(detail.sessionId);
      else setOpenFor(null);
    };
    window.addEventListener('openswarm:context-drawer', handler);
    return () => window.removeEventListener('openswarm:context-drawer', handler);
  }, []);

  if (!openFor || !session) return null;

  const ctxPct = session.ctx_used_pct ?? 0;
  const cachePct = session.cache_read_pct ?? 0;
  const ctxColor = ctxPct >= 0.9 ? '#ef4444' : ctxPct >= 0.7 ? '#f59e0b' : c.text.secondary;

  return (
    <Drawer
      anchor="right"
      open
      onClose={() => setOpenFor(null)}
      PaperProps={{ sx: { width: 380, bgcolor: c.bg.surface, color: c.text.primary } }}
    >
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Session context</Typography>
          <IconButton size="small" onClick={() => setOpenFor(null)} sx={{ color: c.text.tertiary }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, mb: 2 }}>
          <Box sx={{ p: 1.5, borderRadius: 1, border: `1px solid ${c.border.medium}` }}>
            <Typography variant="caption" sx={{ color: c.text.tertiary, display: 'block' }}>
              Context used
            </Typography>
            <Typography variant="h5" sx={{ color: ctxColor, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(ctxPct * 100)}%
            </Typography>
            <Typography variant="caption" sx={{ color: c.text.tertiary }}>
              {(session.tokens?.input || 0).toLocaleString()} / 200K tokens
            </Typography>
          </Box>
          <Box sx={{ p: 1.5, borderRadius: 1, border: `1px solid ${c.border.medium}` }}>
            <Typography variant="caption" sx={{ color: c.text.tertiary, display: 'block' }}>
              Cache hit
            </Typography>
            <Typography variant="h5" sx={{ color: c.text.primary, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(cachePct * 100)}%
            </Typography>
            <Typography variant="caption" sx={{ color: c.text.tertiary }}>
              {(session.cache_read_tokens || 0).toLocaleString()} cached tokens
            </Typography>
          </Box>
        </Box>

        <Section title="Active MCP servers" emptyText="None; model must MCPSearch + MCPActivate to use one">
          {(session.active_mcps || []).map((m) => (
            <Pill key={m} label={m} color={c.accent.primary} />
          ))}
        </Section>

        <Section title="Compaction" emptyText="">
          <Typography variant="caption" sx={{ color: c.text.secondary }}>
            {session.compacted_through_msg_id
              ? `Earlier history compacted through ${String(session.compacted_through_msg_id).slice(0, 8)}…`
              : 'Original history intact (no compaction yet).'}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: c.text.tertiary }}>
            Auto-compact triggers at 65% ctx; pre-send guard trims at 90%.
          </Typography>
        </Section>

        <Section title="Tips" emptyText="">
          <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block', mb: 0.5 }}>
            • <code>/compact</code>: summarize old turns now
          </Typography>
          <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block', mb: 0.5 }}>
            • <code>/clear</code>: fresh SDK session, keep chat history visible
          </Typography>
          <Typography variant="caption" sx={{ color: c.text.secondary, display: 'block' }}>
            • <code>/context</code>: open this drawer
          </Typography>
        </Section>
      </Box>
    </Drawer>
  );
}

function Section({ title, emptyText, children }: { title: string; emptyText: string; children: React.ReactNode }) {
  const c = useClaudeTokens();
  const arr = React.Children.toArray(children);
  const hasContent = arr.length > 0;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="caption" sx={{ color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', mb: 0.5 }}>
        {title}
      </Typography>
      {hasContent ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>{children}</Box>
      ) : (
        <Typography variant="caption" sx={{ color: c.text.tertiary, fontStyle: 'italic' }}>
          {emptyText}
        </Typography>
      )}
    </Box>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  const c = useClaudeTokens();
  return (
    <Box
      sx={{
        px: 1,
        py: 0.25,
        borderRadius: 1,
        border: `1px solid ${c.border.medium}`,
        bgcolor: c.bg.elevated,
        fontSize: 12,
        color,
      }}
    >
      {label}
    </Box>
  );
}
