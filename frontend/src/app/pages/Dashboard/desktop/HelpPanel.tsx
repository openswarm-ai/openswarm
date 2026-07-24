import React, { useCallback, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { AnimatePresence, motion } from 'framer-motion';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import ArrowOutwardRoundedIcon from '@mui/icons-material/ArrowOutwardRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, launchAndSendFirstMessage, type AgentConfig } from '@/shared/state/agentsSlice';
import { getLastDashboardId } from '@/shared/lastDashboardId';
import { API_BASE } from '@/shared/config';

const REPO_ISSUES_URL = 'https://github.com/openswarm-ai/openswarm/issues/new';
const DOCS_URL = 'https://docs.openswarm.com';
const DISCORD_URL = 'https://discord.com/channels/1486442924391796896/1486442927554170892';

const WHATS_NEW: Array<{ text: string }> = [
  { text: 'Dictation lands where your cursor is, with AI cleanup' },
  { text: 'Sign in keeps your setup tied to your account' },
  { text: 'Text size setting + a cleaner canvas composer' },
];

function openExternal(url: string): void {
  const api = (window as unknown as { openswarm?: { openExternal?: (u: string) => void } }).openswarm;
  if (api?.openExternal) api.openExternal(url);
  else window.open(url, '_blank');
}

async function fileToB64(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Pane = 'root' | 'bug' | 'idea';

// The Help panel: Linear/Raycast-style popover off the Help pill. Ask leads (starts a real chat),
// then report-a-bug / request-a-feature: the local backend assembles a diagnostics bundle (redacted
// env facts + log tail + the user's screenshots) into one folder, we reveal it in the file manager,
// and open a PREFILLED GitHub issue for them to drag the folder's files into. Nothing uploads by
// itself and no secret can ride along (the bundle is allowlisted server-side). Then community + docs.
const HelpPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const model = useAppSelector((s) => s.settings.data.default_model);
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const [pane, setPane] = useState<Pane>('root');
  const [ask, setAsk] = useState('');
  const [reportText, setReportText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const startChat = useCallback((prompt: string): void => {
    const p = prompt.trim();
    if (!p) return;
    const dashboardId = getLastDashboardId() ?? undefined;
    const config: AgentConfig = { name: 'Help', model, mode: 'agent', dashboard_id: dashboardId };
    const draftId = dispatch(createDraftSession({ mode: 'agent', model, dashboardId: dashboardId ?? '', setActive: true })).payload.draftId;
    void dispatch(launchAndSendFirstMessage({ draftId, config, prompt: p, mode: 'agent', model, expand: true }));
    onClose();
  }, [dispatch, model, onClose]);

  const submitReport = useCallback(async (kind: 'bug' | 'idea'): Promise<void> => {
    if (sending) return;
    setSending(true);
    try {
      // 1. Local diagnostics bundle (report.md + the user's files), revealed for drag-into-the-issue.
      const attachments = await Promise.all(files.slice(0, 6).map(async (f) => ({ name: f.name, data_b64: await fileToB64(f) })));
      const res = await fetch(`${API_BASE}/help/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, description: reportText, attachments }),
      });
      let folder: string | null = null;
      if (res.ok) {
        const data = (await res.json()) as { folder?: string };
        folder = data.folder ?? null;
      }
      // 2. Prefilled GitHub issue; the body points at the revealed bundle so nothing gets lost.
      const bodyLines = [
        reportText.trim(),
        '',
        '---',
        `App version: ${appVersion ?? 'dev'}`,
        `Platform: ${navigator.platform}`,
        folder ? 'Diagnostics: drag the files from the folder OpenSwarm just revealed into this issue.' : '',
      ].filter(Boolean);
      const params = new URLSearchParams({
        title: reportText.trim().split('\n')[0].slice(0, 80) || (kind === 'bug' ? 'Bug report' : 'Feature request'),
        labels: kind === 'bug' ? 'bug' : 'enhancement',
        body: bodyLines.join('\n'),
      });
      openExternal(`${REPO_ISSUES_URL}?${params.toString()}`);
      if (folder) {
        const api = (window as unknown as { openswarm?: { revealBundle?: (p: string) => Promise<unknown> } }).openswarm;
        void api?.revealBundle?.(folder);
      }
      onClose();
    } finally {
      setSending(false);
    }
  }, [sending, files, reportText, appVersion, onClose]);

  const rowSx = {
    display: 'flex', alignItems: 'center', gap: 1.25, width: '100%',
    px: 1.25, py: 1, borderRadius: '9px', border: 'none', background: 'transparent',
    color: 'rgba(255,255,255,0.9)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' as const,
    '&:hover': { background: 'rgba(255,255,255,0.07)' },
  };
  const iconSx = { fontSize: 17, color: 'rgba(255,255,255,0.65)', flexShrink: 0 };
  const fieldSx = {
    width: '100%', boxSizing: 'border-box' as const, resize: 'none' as const,
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px',
    color: 'rgba(255,255,255,0.92)', fontFamily: 'inherit', fontSize: '0.8125rem', lineHeight: 1.5,
    padding: '9px 11px', outline: 'none',
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 324, zIndex: 1500,
          background: 'rgba(22,17,26,0.94)',
          backdropFilter: 'blur(24px) saturate(150%)', WebkitBackdropFilter: 'blur(24px) saturate(150%)',
          border: '1px solid rgba(255,255,255,0.1)', borderRadius: '14px',
          boxShadow: '0 22px 60px -18px rgba(0,0,0,0.6)', overflow: 'hidden',
          cursor: 'default',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {pane === 'root' ? (
          <Box sx={{ p: 1 }}>
            <Box sx={{ px: 1.25, pt: 0.75, pb: 0.5 }}>
              <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: 'rgba(255,255,255,0.95)' }}>How can we help?</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mx: 1, my: 0.75, px: 1.25, py: 0.75, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px' }}>
              <AutoAwesomeRoundedIcon sx={{ fontSize: 15, color: 'rgba(255,255,255,0.5)' }} />
              <Box
                component="input"
                value={ask}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAsk(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') startChat(ask); e.stopPropagation(); }}
                placeholder="Ask OpenSwarm anything..."
                sx={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'rgba(255,255,255,0.92)', fontFamily: 'inherit', fontSize: '0.8125rem', '&::placeholder': { color: 'rgba(255,255,255,0.4)' } }}
              />
              {ask.trim() && (
                <Box component="button" onClick={() => startChat(ask)} sx={{ display: 'flex', border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', p: 0 }}>
                  <ArrowUpwardRoundedIcon sx={{ fontSize: 16 }} />
                </Box>
              )}
            </Box>
            <Box component="button" onClick={() => { setReportText(''); setFiles([]); setPane('bug'); }} sx={rowSx}>
              <BugReportOutlinedIcon sx={iconSx} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500 }}>Report a bug</Typography>
                <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)' }}>Diagnostics packaged automatically</Typography>
              </Box>
              <ChevronRightRoundedIcon sx={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }} />
            </Box>
            <Box component="button" onClick={() => { setReportText(''); setFiles([]); setPane('idea'); }} sx={rowSx}>
              <LightbulbOutlinedIcon sx={iconSx} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500 }}>Request a feature</Typography>
                <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)' }}>Tell us what's missing</Typography>
              </Box>
              <ChevronRightRoundedIcon sx={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }} />
            </Box>
            <Box component="button" onClick={() => { openExternal(DISCORD_URL); onClose(); }} sx={rowSx}>
              <ForumOutlinedIcon sx={iconSx} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500 }}>Talk to the team</Typography>
                <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)' }}>Join the Discord</Typography>
              </Box>
              <ArrowOutwardRoundedIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
            </Box>
            <Box component="button" onClick={() => { openExternal(DOCS_URL); onClose(); }} sx={rowSx}>
              <MenuBookOutlinedIcon sx={iconSx} />
              <Typography sx={{ flex: 1, fontSize: '0.8125rem', fontWeight: 500 }}>Docs &amp; shortcuts</Typography>
              <ArrowOutwardRoundedIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
            </Box>
            <Box sx={{ height: '1px', background: 'rgba(255,255,255,0.09)', mx: 1.25, my: 0.75 }} />
            <Box sx={{ px: 1.25, pb: 0.75 }}>
              <Typography sx={{ fontSize: '0.625rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', mb: 0.5 }}>
                What's new{appVersion ? ` · v${appVersion}` : ''}
              </Typography>
              {WHATS_NEW.map((n) => (
                <Box key={n.text} sx={{ display: 'flex', gap: 0.9, alignItems: 'flex-start', my: 0.4 }}>
                  <Box sx={{ width: 5, height: 5, borderRadius: '50%', background: '#4fdf9f', mt: '6px', flexShrink: 0 }} />
                  <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.45 }}>{n.text}</Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ) : (
          <Box sx={{ p: 1.5 }}>
            <Box component="button" onClick={() => setPane('root')} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.55)', fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'inherit', p: 0, mb: 1 }}>
              <ArrowBackRoundedIcon sx={{ fontSize: 14 }} /> {pane === 'bug' ? 'Report a bug' : 'Request a feature'}
            </Box>
            <Box
              component="textarea"
              autoFocus
              rows={4}
              value={reportText}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReportText(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
              placeholder={pane === 'bug' ? 'What went wrong?' : "What's missing?"}
              sx={fieldSx}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.log,.json,.md,.pdf"
              hidden
              onChange={(e) => { if (e.target.files) setFiles((prev) => [...prev, ...Array.from(e.target.files!)].slice(0, 6)); e.target.value = ''; }}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
              <Box component="button" onClick={() => fileInputRef.current?.click()} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, border: '1px dashed rgba(255,255,255,0.25)', background: 'transparent', color: 'rgba(255,255,255,0.65)', borderRadius: '8px', px: 1, py: 0.4, fontSize: '0.6875rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                <AttachFileRoundedIcon sx={{ fontSize: 12 }} /> Add screenshots or files
              </Box>
              {files.map((f, i) => (
                <Box key={`${f.name}-${i}`} component="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} title="Remove" sx={{ border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.75)', borderRadius: '8px', px: 0.9, py: 0.4, fontSize: '0.6875rem', cursor: 'pointer', fontFamily: 'inherit', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name}
                </Box>
              ))}
            </Box>
            {pane === 'bug' && (
              <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)', mt: 0.75, lineHeight: 1.45 }}>
                We'll package a diagnostic report (your email, app version, recent activity, no keys or secrets) with your files, reveal it in Finder, and open a prefilled GitHub issue to drop it into.
              </Typography>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1.25 }}>
              <Box component="button" onClick={onClose} sx={{ border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.55)', fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', px: 1, py: 0.5 }}>Cancel</Box>
              <Box
                component="button"
                onClick={() => { void submitReport(pane === 'bug' ? 'bug' : 'idea'); }}
                disabled={!reportText.trim() || sending}
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.75,
                  border: 'none', borderRadius: '9px', px: 1.5, py: 0.6, fontFamily: 'inherit',
                  fontSize: '0.8125rem', fontWeight: 600, cursor: reportText.trim() && !sending ? 'pointer' : 'default',
                  background: reportText.trim() ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.15)',
                  color: reportText.trim() ? '#1c1b19' : 'rgba(255,255,255,0.4)',
                }}
              >
                {sending && <CircularProgress size={12} thickness={6} sx={{ color: '#1c1b19' }} />}
                Continue on GitHub
              </Box>
            </Box>
          </Box>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export default HelpPanel;
