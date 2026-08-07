import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import VerifiedIcon from '@mui/icons-material/Verified';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchTools } from '@/shared/state/toolsSlice';
import { INTEGRATIONS, Integration } from '../Tools/integrations';
import { installIntegration } from '../Tools/installIntegration';
import DirectoryFilterBar from './DirectoryFilterBar';

interface Props {
  onOpenInstalled?: (toolId: string) => void;
}

const POPULAR_IDS = ['google-workspace', 'slack', 'notion'];

// Vetted integrations only, per the MCP-surface rule: the Directory never lists arbitrary
// community MCP servers, so every card here carries the verified mark honestly.
const DirectoryConnectorsTab: React.FC<Props> = ({ onOpenInstalled }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const tools = useAppSelector((s) => s.tools.items);
  const [query, setQuery] = useState('');
  const [filterSelected, setFilterSelected] = useState<string[]>(['installed', 'not-installed']);
  const [sort, setSort] = useState('popular');
  const toggleFilter = (value: string) => setFilterSelected((p) => (p.includes(value) ? p.filter((v) => v !== value) : [...p, value]));
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });

  useEffect(() => { dispatch(fetchTools()); }, [dispatch]);

  const installedToolByName = useMemo(() => {
    const m: Record<string, { id: string }> = {};
    for (const t of Object.values(tools)) m[t.name] = { id: t.id };
    return m;
  }, [tools]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = INTEGRATIONS.filter((ig) =>
      !q || ig.name.toLowerCase().includes(q) || ig.description.toLowerCase().includes(q));
    out = out.filter((ig) => (installedToolByName[ig.name] ? filterSelected.includes('installed') : filterSelected.includes('not-installed')));
    if (sort === 'name') out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [query, filterSelected, sort, installedToolByName]);

  const popular = useMemo(
    () => POPULAR_IDS.map((id) => INTEGRATIONS.find((ig) => ig.id === id)).filter((ig): ig is Integration => !!ig),
    [],
  );

  const handleInstall = async (ig: Integration) => {
    setInstallingId(ig.id);
    try {
      const res = await installIntegration(dispatch, ig);
      setSnackbar({ open: true, message: res.message, severity: res.severity });
    } finally {
      setInstallingId(null);
    }
  };

  const actionFor = (ig: Integration) => {
    const installed = installedToolByName[ig.name];
    if (installingId === ig.id) return <CircularProgress size={18} sx={{ color: c.text.tertiary, m: 0.5 }} />;
    if (installed) {
      return (
        <IconButton size="small" onClick={() => onOpenInstalled?.(installed.id)} sx={{ color: c.status.success, '&:hover': { color: c.text.primary } }}>
          <CheckCircleIcon sx={{ fontSize: 20 }} />
        </IconButton>
      );
    }
    return (
      <IconButton size="small" onClick={() => { void handleInstall(ig); }} sx={{ color: c.text.secondary, '&:hover': { color: c.text.primary, bgcolor: c.bg.secondary } }}>
        <AddIcon sx={{ fontSize: 20 }} />
      </IconButton>
    );
  };

  const iconBox = (ig: Integration, size: number) => (
    <Box sx={{
      width: size, height: size, borderRadius: `${Math.round(size * 0.28)}px`, flexShrink: 0,
      border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {ig.icon}
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%', minHeight: 0 }}>
      <DirectoryFilterBar
        searchPlaceholder="Search connectors..."
        query={query}
        onQuery={setQuery}
        filterSections={[
          { label: 'Status', options: [{ value: 'installed', label: 'Installed' }, { value: 'not-installed', label: 'Not installed' }] },
        ]}
        filterSelected={filterSelected}
        onToggleFilter={toggleFilter}
        sortOptions={[
          { value: 'popular', label: 'Default' },
          { value: 'name', label: 'Alphabetical' },
        ]}
        sortValue={sort}
        onSort={setSort}
      />

      <Box sx={{
        flex: 1, minHeight: 0, overflow: 'auto', pr: 0.5,
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
      }}>
        {!query.trim() && filterSelected.length === 2 && (
          <>
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.06em', color: c.text.tertiary, textTransform: 'uppercase', mb: 1.25 }}>
              Popular
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1.5, mb: 2.5 }}>
              {popular.map((ig) => (
                <Box key={ig.id} sx={{
                  display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1.25,
                  border: `1px solid ${c.border.subtle}`, borderRadius: '12px', bgcolor: c.bg.surface,
                  transition: 'border-color 0.12s, box-shadow 0.12s',
                  '&:hover': { borderColor: c.border.medium, boxShadow: c.shadow.sm },
                }}>
                  {iconBox(ig, 30)}
                  <Typography noWrap sx={{ fontSize: '0.9375rem', fontWeight: 600, color: c.text.primary, flex: 1 }}>{ig.name}</Typography>
                  {actionFor(ig)}
                </Box>
              ))}
            </Box>
          </>
        )}

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.75, alignContent: 'start' }}>
          {list.length === 0 ? (
            <Box sx={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', pt: 8 }}>
              <Typography sx={{ fontSize: '0.875rem', color: c.text.ghost }}>No connectors match your search.</Typography>
            </Box>
          ) : list.map((ig) => (
            <Box key={ig.id} sx={{
              border: `1px solid ${c.border.subtle}`, borderRadius: '14px', p: 2.25,
              bgcolor: c.bg.surface, display: 'flex', gap: 1.5,
              transition: 'border-color 0.12s, box-shadow 0.12s',
              '&:hover': { borderColor: c.border.medium, boxShadow: c.shadow.sm },
            }}>
              {iconBox(ig, 44)}
              <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography noWrap sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>{ig.name}</Typography>
                  <VerifiedIcon sx={{ fontSize: 15, color: c.text.tertiary, flexShrink: 0 }} />
                </Box>
                <Typography sx={{
                  fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.5,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {ig.description}
                </Typography>
              </Box>
              <Box sx={{ flexShrink: 0, alignSelf: 'flex-start' }}>{actionFor(ig)}</Box>
            </Box>
          ))}
        </Box>
      </Box>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((p) => ({ ...p, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar((p) => ({ ...p, open: false }))} sx={{ fontSize: '0.8125rem' }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default DirectoryConnectorsTab;
