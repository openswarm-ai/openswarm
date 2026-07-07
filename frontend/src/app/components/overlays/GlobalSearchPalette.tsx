import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import SearchIcon from '@mui/icons-material/Search';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import BoltIcon from '@mui/icons-material/Bolt';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { searchHistory, resumeSession, HistorySession } from '@/shared/state/agentsSlice';
import { displaySessionName } from '@/shared/state/sessionDisplay';
import { setPendingFocusAgentId } from '@/shared/state/tempStateSlice';
import { createDashboard } from '@/shared/state/dashboardsSlice';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { friendlyStatusLabel } from '@/shared/statusLabel';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface DashboardResult {
  kind: 'dashboard';
  id: string;
  name: string;
}

interface SessionResult {
  kind: 'session';
  id: string;
  name: string;
  dashboardId: string | null;
  status: string;
  closedAt: string | null;
}

interface ActionResult {
  kind: 'action';
  id: string;
  name: string;
  keywords: string;
}

type Result = DashboardResult | SessionResult | ActionResult;

// Spotlight-style commands; matched against name + keywords once the user types.
const ACTIONS: ActionResult[] = [
  { kind: 'action', id: 'new-dashboard', name: 'New dashboard', keywords: 'create board canvas workspace' },
  { kind: 'action', id: 'settings', name: 'Open Settings', keywords: 'preferences general theme options' },
  { kind: 'action', id: 'settings-models', name: 'Connect a model', keywords: 'settings models api key provider subscription' },
  { kind: 'action', id: 'go-skills', name: 'Go to Skills', keywords: 'customize skills' },
  { kind: 'action', id: 'go-actions', name: 'Go to Actions', keywords: 'customize tools actions mcp' },
  { kind: 'action', id: 'all-dashboards', name: 'All dashboards', keywords: 'overview picker browse boards' },
];

const GlobalSearchPalette: React.FC<Props> = ({ open, onClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dashboards = useAppSelector((s) => s.dashboards.items);
  const sessions = useAppSelector((s) => s.agents.sessions);
  const history = useAppSelector((s) => s.agents.history);
  const searchResults = useAppSelector((s) => s.agents.historySearch.results);
  const searchLoading = useAppSelector((s) => s.agents.historySearch.loading);
  const searchQuery = useAppSelector((s) => s.agents.historySearch.query);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch(searchHistory({ q: query.trim(), limit: 30, offset: 0 }));
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, dispatch]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Actions, then dashboards, then sessions; merges in-memory active sessions with historySearch.results.
  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    // Commands surface only once typed, Spotlight-style; the empty palette stays content-first.
    const actionResults: ActionResult[] = q
      ? ACTIONS.filter((a) => `${a.name} ${a.keywords}`.toLowerCase().includes(q)).slice(0, 4)
      : [];
    const dashboardResults: DashboardResult[] = Object.values(dashboards)
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 5)
      .map((d) => ({ kind: 'dashboard', id: d.id, name: d.name }));

    const sessionMap = new Map<string, SessionResult>();
    for (const s of Object.values(sessions)) {
      const sessionDisplayName = displaySessionName(s.name);
      if (q && !sessionDisplayName.toLowerCase().includes(q)) continue;
      sessionMap.set(s.id, {
        kind: 'session',
        id: s.id,
        name: sessionDisplayName,
        dashboardId: s.dashboard_id || null,
        status: s.status,
        closedAt: null,
      });
    }
    // Empty query falls back to recent history, not the full dump.
    const historyPool: HistorySession[] = q ? searchResults : Object.values(history).slice(0, 20);
    for (const h of historyPool) {
      if (sessionMap.has(h.id)) continue;
      if (q && !(h.name || '').toLowerCase().includes(q)) continue;
      sessionMap.set(h.id, {
        kind: 'session',
        id: h.id,
        name: h.name || 'Untitled',
        dashboardId: h.dashboard_id || null,
        status: h.status,
        closedAt: h.closed_at,
      });
    }
    const sessionResults = Array.from(sessionMap.values()).slice(0, 30);
    return [...actionResults, ...dashboardResults, ...sessionResults];
  }, [query, dashboards, sessions, history, searchResults]);

  const runAction = useCallback((id: string) => {
    switch (id) {
      case 'new-dashboard':
        dispatch(createDashboard('Untitled Dashboard')).then((res) => {
          if (createDashboard.fulfilled.match(res)) navigate(`/dashboard/${res.payload.id}`);
        });
        break;
      case 'settings': dispatch(openSettingsModal()); break;
      case 'settings-models': dispatch(openSettingsModal('models')); break;
      // Skills/Actions live in Settings now (the sidebar Customization section moved there).
      case 'go-skills': dispatch(openSettingsModal('skills')); break;
      case 'go-actions': dispatch(openSettingsModal('tools')); break;
      case 'all-dashboards': navigate('/'); break;
    }
  }, [dispatch, navigate]);

  const handleSelect = useCallback((r: Result) => {
    if (r.kind === 'action') {
      runAction(r.id);
    } else if (r.kind === 'dashboard') {
      navigate(`/dashboard/${r.id}`);
    } else {
      if (r.dashboardId) {
        navigate(`/dashboard/${r.dashboardId}`);
        if (r.closedAt) {
          // Closed history: resume so it lands in `sessions` and layout can place a card.
          dispatch(resumeSession({ sessionId: r.id })).then(() => {
            dispatch(setPendingFocusAgentId(r.id));
          });
        } else {
          dispatch(setPendingFocusAgentId(r.id));
        }
      } else if (r.closedAt) {
        // Orphan closed session: resume; we can't navigate anywhere meaningful.
        dispatch(resumeSession({ sessionId: r.id }));
      }
    }
    onClose();
  }, [navigate, dispatch, onClose, runAction]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) handleSelect(results[selectedIndex]);
    }
  }, [results, selectedIndex, handleSelect, onClose]);

  if (!open) return null;

  const actionSection = results.filter((r): r is ActionResult => r.kind === 'action');
  const dashSection = results.filter((r): r is DashboardResult => r.kind === 'dashboard');
  const sessSection = results.filter((r): r is SessionResult => r.kind === 'session');

  const flatIndexOf = (r: Result) => results.indexOf(r);
  const isStillSearching = !!query.trim() && searchLoading && searchQuery !== query.trim();

  return (
    <>
      {/* Backdrop */}
      <Box
        onClick={onClose}
        sx={{ position: 'fixed', inset: 0, zIndex: 1400, bgcolor: 'rgba(0,0,0,0.35)' }}
      />
      {/* Palette */}
      <Box
        onKeyDown={handleKeyDown}
        sx={{
          position: 'fixed',
          top: '13%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 680,
          maxHeight: 560,
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.xl}px`,
          boxShadow: c.shadow.lg,
          zIndex: 1401,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Input row */}
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2.25, py: 1.75, borderBottom: `1px solid ${c.border.subtle}` }}>
          <SearchIcon sx={{ fontSize: '1.4rem', color: c.text.muted, mr: 1.5 }} />
          <InputBase
            inputRef={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, or type a command…"
            fullWidth
            sx={{
              fontSize: '1.05rem',
              fontFamily: c.font.sans,
              color: c.text.primary,
              '& input::placeholder': { color: c.text.muted, opacity: 1 },
            }}
          />
          {isStillSearching && <CircularProgress size={16} sx={{ color: c.text.muted, ml: 1 }} />}
          <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost, ml: 1.5, fontFamily: c.font.mono }}>
            esc
          </Typography>
        </Box>

        {/* Results */}
        <Box sx={{ overflowY: 'auto', flex: 1 }}>
          {results.length === 0 ? (
            <Typography sx={{ px: 2, py: 3, fontSize: '0.85rem', color: c.text.muted, textAlign: 'center' }}>
              {query.trim() ? 'No matches' : 'No dashboards or chats yet'}
            </Typography>
          ) : (
            <>
              {actionSection.map((r) => {
                const idx = flatIndexOf(r);
                return (
                  <ResultRow
                    key={`a-${r.id}`}
                    icon={<BoltIcon sx={{ fontSize: 18, color: c.accent.primary }} />}
                    title={r.name}
                    selected={idx === selectedIndex}
                    onClick={() => handleSelect(r)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    c={c}
                  />
                );
              })}
              {dashSection.length > 0 && (
                <SectionHeader label="Dashboards" c={c} />
              )}
              {dashSection.map((r) => {
                const idx = flatIndexOf(r);
                return (
                  <ResultRow
                    key={`d-${r.id}`}
                    icon={<DashboardIcon sx={{ fontSize: 19, color: c.accent.primary }} />}
                    title={r.name}
                    subtitle="Dashboard"
                    selected={idx === selectedIndex}
                    onClick={() => handleSelect(r)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    c={c}
                  />
                );
              })}
              {sessSection.length > 0 && (
                <SectionHeader label="Chats" c={c} />
              )}
              {sessSection.map((r) => {
                const idx = flatIndexOf(r);
                const dashName = r.dashboardId ? dashboards[r.dashboardId]?.name : null;
                const subtitle = [
                  dashName && `in ${dashName}`,
                  r.closedAt ? 'closed' : friendlyStatusLabel(r.status),
                ].filter(Boolean).join(' · ');
                return (
                  <ResultRow
                    key={`s-${r.id}`}
                    icon={<ChatBubbleOutlineIcon sx={{ fontSize: 16, color: c.text.muted }} />}
                    title={r.name}
                    subtitle={subtitle}
                    selected={idx === selectedIndex}
                    onClick={() => handleSelect(r)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    c={c}
                  />
                );
              })}
            </>
          )}
        </Box>

        {/* Hint footer */}
        <Box
          sx={{
            px: 1.75,
            py: 0.75,
            borderTop: `1px solid ${c.border.subtle}`,
            display: 'flex',
            gap: 1.5,
            alignItems: 'center',
            color: c.text.ghost,
            fontSize: '0.7rem',
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </Box>
      </Box>
    </>
  );
};

const SectionHeader: React.FC<{ label: string; c: ReturnType<typeof useClaudeTokens> }> = ({ label, c }) => (
  <Typography
    sx={{
      px: 2.25,
      pt: 1.5,
      pb: 0.5,
      fontSize: '0.72rem',
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: c.text.ghost,
    }}
  >
    {label}
  </Typography>
);

interface RowProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  c: ReturnType<typeof useClaudeTokens>;
}

const ResultRow: React.FC<RowProps> = ({ icon, title, subtitle, selected, onClick, onMouseEnter, c }) => (
  <Box
    onClick={onClick}
    onMouseEnter={onMouseEnter}
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1.5,
      px: 2.25,
      py: 1.25,
      cursor: 'pointer',
      bgcolor: selected ? c.bg.secondary : 'transparent',
    }}
  >
    <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22 }}>
      {icon}
    </Box>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        sx={{
          fontSize: '0.95rem',
          fontWeight: 500,
          color: c.text.primary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </Typography>
      {subtitle && (
        <Typography
          sx={{
            fontSize: '0.78rem',
            color: c.text.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            mt: 0.25,
          }}
        >
          {subtitle}
        </Typography>
      )}
    </Box>
  </Box>
);

export default GlobalSearchPalette;
