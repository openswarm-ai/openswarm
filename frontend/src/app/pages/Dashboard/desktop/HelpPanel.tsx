import React, { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { AnimatePresence, motion } from 'framer-motion';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import ArrowOutwardRoundedIcon from '@mui/icons-material/ArrowOutwardRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createDraftSession, launchAndSendFirstMessage, type AgentConfig } from '@/shared/state/agentsSlice';
import { getLastDashboardId } from '@/shared/lastDashboardId';

const REPO_ISSUES_URL = 'https://github.com/openswarm-ai/openswarm/issues/new';
const DOCS_URL = 'https://docs.openswarm.com';

function openExternal(url: string): void {
  const api = (window as unknown as { openswarm?: { openExternal?: (u: string) => void } }).openswarm;
  if (api?.openExternal) api.openExternal(url);
  else window.open(url, '_blank');
}

type Pane = 'root' | 'bug' | 'idea';

// The Help panel: Linear/Raycast-style popover off the Help pill. Ask leads (starts a real chat with
// the question), then report-a-bug / request-a-feature (open a PREFILLED GitHub issue: version + OS
// attached in the body, no secret and no backend needed, and the user can watch the thread for team
// replies), then docs. Closes on outside click or Esc via the parent.
const HelpPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const model = useAppSelector((s) => s.settings.data.default_model);
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const [pane, setPane] = useState<Pane>('root');
  const [ask, setAsk] = useState('');
  const [reportText, setReportText] = useState('');

  const startChat = useCallback((prompt: string): void => {
    const p = prompt.trim();
    if (!p) return;
    const dashboardId = getLastDashboardId() ?? undefined;
    const config: AgentConfig = { name: 'Help', model, mode: 'agent', dashboard_id: dashboardId };
    const draftId = dispatch(createDraftSession({ mode: 'agent', model, dashboardId: dashboardId ?? '', setActive: true })).payload.draftId;
    void dispatch(launchAndSendFirstMessage({ draftId, config, prompt: p, mode: 'agent', model, expand: true }));
    onClose();
  }, [dispatch, model, onClose]);

  const fileOnGitHub = useCallback((kind: 'bug' | 'idea'): void => {
    const body = [
      reportText.trim(),
      '',
      '---',
      `App version: ${appVersion ?? 'dev'}`,
      `Platform: ${navigator.platform}`,
    ].join('\n');
    const params = new URLSearchParams({
      title: reportText.trim().split('\n')[0].slice(0, 80) || (kind === 'bug' ? 'Bug report' : 'Feature request'),
      labels: kind === 'bug' ? 'bug' : 'enhancement',
      body,
    });
    openExternal(`${REPO_ISSUES_URL}?${params.toString()}`);
    onClose();
  }, [reportText, appVersion, onClose]);

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
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 316, zIndex: 1500,
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
            <Box component="button" onClick={() => { setReportText(''); setPane('bug'); }} sx={rowSx}>
              <BugReportOutlinedIcon sx={iconSx} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500 }}>Report a bug</Typography>
                <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)' }}>Version attached automatically</Typography>
              </Box>
              <ChevronRightRoundedIcon sx={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }} />
            </Box>
            <Box component="button" onClick={() => { setReportText(''); setPane('idea'); }} sx={rowSx}>
              <LightbulbOutlinedIcon sx={iconSx} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 500 }}>Request a feature</Typography>
                <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)' }}>Tell us what's missing</Typography>
              </Box>
              <ChevronRightRoundedIcon sx={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }} />
            </Box>
            <Box component="button" onClick={() => { openExternal(DOCS_URL); onClose(); }} sx={rowSx}>
              <MenuBookOutlinedIcon sx={iconSx} />
              <Typography sx={{ flex: 1, fontSize: '0.8125rem', fontWeight: 500 }}>Docs &amp; shortcuts</Typography>
              <ArrowOutwardRoundedIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
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
            <Typography sx={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.45)', mt: 0.75 }}>
              Opens a prefilled GitHub issue; watch it for replies from the team.
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1.25 }}>
              <Box component="button" onClick={onClose} sx={{ border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.55)', fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', px: 1, py: 0.5 }}>Cancel</Box>
              <Box
                component="button"
                onClick={() => fileOnGitHub(pane === 'bug' ? 'bug' : 'idea')}
                disabled={!reportText.trim()}
                sx={{
                  border: 'none', borderRadius: '9px', px: 1.5, py: 0.6, fontFamily: 'inherit',
                  fontSize: '0.8125rem', fontWeight: 600, cursor: reportText.trim() ? 'pointer' : 'default',
                  background: reportText.trim() ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.15)',
                  color: reportText.trim() ? '#1c1b19' : 'rgba(255,255,255,0.4)',
                }}
              >
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
