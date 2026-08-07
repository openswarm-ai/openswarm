import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import { EmptyState } from '@/app/components/feedback/Loading';
import { DarkTokensScope } from '@/shared/styles/ThemeContext';
import type { Output } from '@/shared/state/outputsSlice';

interface ApplicationsWindowProps {
  outputs: Record<string, Output>;
  onOpenApp: (outputId: string) => void;
  onClose: () => void;
}

// Stable per-app hue so icon-less apps are told apart at a glance; the old shared orange made every fallback tile an identical twin.
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Every tile is a generated ICON (gradient + monogram): a screenshot crushed to 68px reads as mud,
// so the screenshot lives in the hover preview instead and the row stays dock-uniform.
function AppTile({ output }: { output: Output }): React.ReactElement {
  const glyph = (output.icon || '').trim();
  const h = hueFor(output.name || '?');
  return (
    <Box
      sx={{
        width: 68,
        height: 68,
        borderRadius: '16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14), 0 6px 18px rgba(0,0,0,0.32)',
        background: `linear-gradient(160deg, hsl(${h}, 42%, 52%), hsl(${(h + 24) % 360}, 48%, 34%))`,
        fontSize: glyph && glyph.length <= 3 ? '1.5rem' : '1.375rem',
        fontWeight: 590,
        color: 'rgba(255,255,255,0.94)',
      }}
    >
      {glyph && glyph.length <= 3 ? glyph : (output.name || '?').trim().charAt(0).toUpperCase()}
    </Box>
  );
}

// Quick-look screenshot beside the hovered tile; fixed so the grid scroller can't clip it.
function AppHoverPreview({ preview }: { preview: { src: string; x: number; y: number; below: boolean } }): React.ReactElement {
  return (
    <Box
      sx={{
        position: 'fixed',
        left: preview.x,
        top: preview.y,
        transform: 'translateX(-50%)',
        zIndex: 30,
        pointerEvents: 'none',
        width: 220,
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 16px 40px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.12)',
        '@keyframes appprev-in': {
          from: { opacity: 0, transform: `translateX(-50%) translateY(${preview.below ? -4 : 4}px)` },
          to: { opacity: 1, transform: 'translateX(-50%) translateY(0)' },
        },
        animation: 'appprev-in 0.14s ease-out 0.3s both',
      }}
    >
      <Box component="img" src={preview.src} alt="" sx={{ display: 'block', width: '100%', aspectRatio: '16 / 10', objectFit: 'cover' }} />
    </Box>
  );
}

/** Launchpad-style window over the canvas: the user's OpenSwarm apps, newest first. Deliberately NOT the machine's /Applications; this launcher is for things built in OpenSwarm. */
function ApplicationsWindow({ outputs, onOpenApp, onClose }: ApplicationsWindowProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<{ src: string; x: number; y: number; below: boolean } | null>(null);

  const apps = useMemo(() => {
    const all = Object.values(outputs);
    const q = query.trim().toLowerCase();
    const matched = q
      ? all.filter((o) => o.name.toLowerCase().includes(q) || (o.description || '').toLowerCase().includes(q))
      : all;
    return [...matched].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }, [outputs, query]);

  return (
    <>
      <Box onClick={onClose} sx={{ position: 'absolute', inset: 0, zIndex: 19 }} />
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 20,
          width: 620,
          maxWidth: 'calc(100% - 80px)',
          maxHeight: 'calc(100% - 120px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '20px',
          background: 'rgba(18,16,24,0.86)',
          backdropFilter: 'blur(28px) saturate(160%)',
          WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.07)',
          p: 2.5,
          '@keyframes appwin-in': {
            from: { opacity: 0, transform: 'translate(-50%, -50%) scale(0.96)' },
            to: { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
          },
          animation: 'appwin-in 0.18s cubic-bezier(0.2, 0.8, 0.2, 1) both',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, px: 0.5 }}>
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 650, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>
            Applications
          </Typography>
          {Object.keys(outputs).length > 0 && (
            <Box sx={{ px: 0.9, py: 0.1, borderRadius: 999, background: 'rgba(255,255,255,0.09)', fontSize: '0.6875rem', fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>
              {Object.keys(outputs).length}
            </Box>
          )}
        </Box>

        {Object.keys(outputs).length > 8 && (
          <Box
            component="input"
            autoFocus
            value={query}
            placeholder="Search your apps"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            sx={{
              mb: 2,
              px: 1.5,
              py: 0.75,
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              fontSize: '0.8125rem',
              fontFamily: 'inherit',
              outline: 'none',
              '&::placeholder': { color: 'rgba(255,255,255,0.45)' },
            }}
          />
        )}

        <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 120 }}>
          {apps.length === 0 && (
            // The window is glass over the canvas, so the shared empty state needs dark-surface tokens to be readable.
            <DarkTokensScope>
              {Object.keys(outputs).length === 0 ? (
                <EmptyState
                  icon={<GridViewRoundedIcon sx={{ fontSize: 32 }} />}
                  title="No apps yet"
                  hint="Ask an agent to build one and it lands here."
                />
              ) : (
                <EmptyState title="No apps match that search." />
              )}
            </DarkTokensScope>
          )}
          {apps.length > 0 && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 1.5, pb: 0.5 }}>
              {apps.map((output) => (
                <Box
                  key={output.id}
                  onClick={() => { onOpenApp(output.id); onClose(); }}
                  onMouseEnter={(e: React.MouseEvent<HTMLElement>) => {
                    if (!output.thumbnail) { setPreview(null); return; }
                    const r = e.currentTarget.getBoundingClientRect();
                    const below = r.top < 170;
                    setPreview({ src: output.thumbnail, x: r.left + r.width / 2, y: below ? r.bottom + 10 : r.top - 148, below });
                  }}
                  onMouseLeave={() => setPreview(null)}
                  title={output.description || output.name}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 1,
                    py: 1.25,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s ease',
                    '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
                    '&:hover .osw-app-tile': { transform: 'translateY(-2px) scale(1.05)', filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.35))' },
                    '&:active .osw-app-tile': { transform: 'scale(0.97)', filter: 'none' },
                  }}
                >
                  <Box className="osw-app-tile" sx={{ transition: 'transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), filter 0.16s ease', display: 'flex' }}>
                    <AppTile output={output} />
                  </Box>
                  <Typography sx={{ fontSize: '0.71875rem', fontWeight: 500, color: 'rgba(255,255,255,0.78)', textAlign: 'center', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', px: 0.5 }}>
                    {output.name}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Box>
      {preview && <AppHoverPreview preview={preview} />}
    </>
  );
}

export default ApplicationsWindow;
