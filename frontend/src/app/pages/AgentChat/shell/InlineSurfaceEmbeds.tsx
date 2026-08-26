import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion } from 'framer-motion';
import LanguageIcon from '@mui/icons-material/Language';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearTiledCard, focusBrowserCard, focusViewCard } from '@/shared/state/dashboardLayoutSlice';
import { captureBrowserShot } from '@/shared/captureBrowserShot';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';

// The desktop-redesign frame: the surfaces an agent is driving live INSIDE its chat. Each linked
// browser card renders as a live snapshot embed (same visual grammar as the tool cards: rounded,
// bordered, quiet chrome header) that repaints while the agent works; each built app renders as an
// open row. Clicking pops the real card out on the canvas (exiting full size view first if needed),
// which IS the "drag it out" gesture without inventing a second windowing system inside the chat.
const SNAPSHOT_MS = 2500;

function useBrowserSnapshot(browserId: string, live: boolean): string | null {
  const [shot, setShot] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    let timer = 0;
    const grab = async (): Promise<void> => {
      const img = await captureBrowserShot(browserId);
      if (!dead && img) setShot(img);
      // Live sessions repaint forever; idle ones retry a few times so a webview that mounts late
      // (fullscreen hiding the canvas, load races) still yields one real frame instead of a blank.
      tries += 1;
      if (!dead && (live || (tries < 6))) timer = window.setTimeout(() => { void grab(); }, SNAPSHOT_MS);
    };
    let tries = 0;
    void grab();
    return () => { dead = true; window.clearTimeout(timer); };
  }, [browserId, live]);
  return shot;
}

const BrowserEmbed: React.FC<{ c: ClaudeTokens; browserId: string; title: string; url: string; live: boolean; onOpen: () => void }> = ({ c, browserId, title, url, live, onOpen }) => {
  const shot = useBrowserSnapshot(browserId, live);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={{ width: '100%' }}
    >
      <Box
        onClick={onOpen}
        sx={{
          border: `1px solid ${c.border.subtle}`, borderRadius: 2, overflow: 'hidden', cursor: 'pointer',
          bgcolor: c.bg.elevated, transition: 'border-color 150ms, box-shadow 150ms',
          '&:hover': { borderColor: c.border.strong, boxShadow: c.shadow.md },
          '&:hover .osw-embed-open': { opacity: 1 },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.75, borderBottom: `1px solid ${c.border.subtle}` }}>
          <LanguageIcon sx={{ fontSize: 14, color: c.text.muted, flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title || 'Browser'}
          </Typography>
          <Typography sx={{ fontSize: '0.6875rem', color: c.text.ghost, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {url}
          </Typography>
          {live && (
            <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: c.status.success, flexShrink: 0 }} />
          )}
          <Box className="osw-embed-open" sx={{ display: 'flex', alignItems: 'center', gap: 0.4, opacity: 0, transition: 'opacity 120ms', color: c.text.muted, flexShrink: 0 }}>
            <OpenInFullRoundedIcon sx={{ fontSize: 12 }} />
            <Typography sx={{ fontSize: '0.625rem', fontWeight: 600 }}>Open on canvas</Typography>
          </Box>
        </Box>
        {shot ? (
          <Box component="img" src={shot} alt="" sx={{ display: 'block', width: '100%', maxHeight: 260, objectFit: 'cover', objectPosition: 'top' }} />
        ) : (
          <Box sx={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.ghost, fontSize: '0.75rem' }}>
            {live ? 'Loading page view...' : 'Page view unavailable'}
          </Box>
        )}
      </Box>
    </motion.div>
  );
};


// An app built in this chat gets the same treatment as a browser: a titled frame with a real view
// of the thing, not a text row. It was a one-line link while browsers showed a live picture, which
// is the asymmetry Eric reported ("it should show that it's inside the agent like browser agents").
// Uses the stored `thumbnail` rather than a live capture: app cards never register a webview in
// browserRegistry, so captureBrowserShot cannot see them, and inventing that path blind is how a
// preview becomes a renderer crash.
const AppEmbed: React.FC<{ c: ClaudeTokens; name: string; thumbnail: string | null; live: boolean; onOpen: () => void }> = ({ c, name, thumbnail, live, onOpen }) => (
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.25 }}
    style={{ width: '100%' }}
  >
    <Box
      onClick={onOpen}
      sx={{
        border: `1px solid ${c.border.subtle}`, borderRadius: 2, overflow: 'hidden', cursor: 'pointer',
        bgcolor: c.bg.elevated, transition: 'border-color 150ms, box-shadow 150ms',
        '&:hover': { borderColor: c.border.strong, boxShadow: c.shadow.md },
        '&:hover .osw-embed-open': { opacity: 1 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.75, borderBottom: `1px solid ${c.border.subtle}` }}>
        <GridViewRoundedIcon sx={{ fontSize: 14, color: c.accent.primary, flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
        </Typography>
        <Typography sx={{ fontSize: '0.6875rem', color: c.text.ghost, flex: 1 }}>Built in this chat</Typography>
        {live && <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: c.status.success, flexShrink: 0 }} />}
        <Box className="osw-embed-open" sx={{ display: 'flex', alignItems: 'center', gap: 0.4, opacity: 0, transition: 'opacity 120ms', color: c.text.muted, flexShrink: 0 }}>
          <OpenInFullRoundedIcon sx={{ fontSize: 12 }} />
          <Typography sx={{ fontSize: '0.625rem', fontWeight: 600 }}>Open on canvas</Typography>
        </Box>
      </Box>
      {thumbnail ? (
        <Box component="img" src={thumbnail} alt="" sx={{ display: 'block', width: '100%', maxHeight: 260, objectFit: 'cover', objectPosition: 'top' }} />
      ) : (
        <Box sx={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.text.ghost, fontSize: '0.75rem' }}>
          {live ? 'Building...' : 'Preview not captured yet'}
        </Box>
      )}
    </Box>
  </motion.div>
);

const InlineSurfaceEmbeds: React.FC<{ c: ClaudeTokens; sessionId: string; fullscreen?: boolean }> = ({ c, sessionId, fullscreen }) => {
  const dispatch = useAppDispatch();
  const browserCards = useAppSelector((s) => s.dashboardLayout.browserCards);
  const outputs = useAppSelector((s) => s.outputs.items);
  // Primitives, not the whole sessions map: this mounts per chat and was re-rendering per stream tick of EVERY session.
  const sessionStatus = useAppSelector((s) => s.agents.sessions[sessionId]?.status);
  const childBrowserKey = useAppSelector((s) => (fullscreen
    ? Object.values(s.agents.sessions)
        .filter((x) => x.parent_session_id === sessionId && x.browser_id)
        .map((x) => x.browser_id as string)
        .join('|')
    : ''));
  const live = sessionStatus === 'running' || sessionStatus === 'waiting_approval';

  const linkedBrowsers = useMemo(() => {
    // A chat's browsers arrive two ways: cards this session spawned directly (spawned_by), and cards
    // driven by its browser sub-agents (child session's browser_id). Union both, keyed by card id.
    const childBrowserIds = new Set(childBrowserKey ? childBrowserKey.split('|') : []);
    // A docked browser renders its REAL card inside the chat (even in full size view), so the
    // snapshot embed would be a stale duplicate right next to the live thing.
    return Object.values(browserCards).filter(
      (bc) => !bc.docked_to && (bc.spawned_by === sessionId || childBrowserIds.has(bc.browser_id)),
    );
  }, [browserCards, childBrowserKey, sessionId]);
  const linkedApps = useMemo(
    () => Object.values(outputs).filter((o) => o.session_id === sessionId),
    [outputs, sessionId],
  );

  // ONE surface at a time: on the canvas the REAL card (beside the chat) is the browser; the chat
  // mirror only takes over in full size view, where the canvas is hidden. Both at once read as two
  // browsers (they aren't; the embed is a live snapshot of the same webview).
  if (!fullscreen) return null;
  if (linkedBrowsers.length === 0 && linkedApps.length === 0) return null;

  const popOut = (fire: () => void): void => {
    // Full size view hides the canvas; step out first so "open on canvas" lands somewhere visible.
    if (fullscreen) dispatch(clearTiledCard(sessionId));
    fire();
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, my: 1 }}>
      {linkedBrowsers.map((bc) => {
        const tab = bc.tabs.find((t) => t.id === bc.activeTabId) ?? bc.tabs[0];
        return (
          <BrowserEmbed
            key={bc.browser_id}
            c={c}
            browserId={bc.browser_id}
            title={tab?.title ?? ''}
            url={tab?.url ?? ''}
            live={live}
            onOpen={() => popOut(() => dispatch(focusBrowserCard(bc.browser_id)))}
          />
        );
      })}
      {linkedApps.map((o) => (
        <AppEmbed
          key={o.id}
          c={c}
          name={o.name || 'App'}
          thumbnail={o.thumbnail ?? null}
          live={live}
          onOpen={() => popOut(() => dispatch(focusViewCard(o.id)))}
        />
      ))}
    </Box>
  );
};

export default InlineSurfaceEmbeds;
