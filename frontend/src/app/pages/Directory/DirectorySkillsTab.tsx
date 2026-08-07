import React, { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchSkills } from '@/shared/state/skillsSlice';
import {
  fetchAllRegistrySkills,
  installCuratedSkill,
  searchCommunitySkills,
  CommunitySkill,
  RegistrySkill,
} from '@/shared/state/skillRegistrySlice';
import DirectoryFilterBar from './DirectoryFilterBar';
import CommunityInstallConfirm from './dialogs/CommunityInstallConfirm';

interface Props {
  onOpenInstalled?: (skillId: string) => void;
}

interface SkillCardModel {
  key: string;
  slug: string;
  publisher: string;
  description: string;
  installs: number | null;
  isCommunity: boolean;
  curated?: RegistrySkill;
  community?: CommunitySkill;
}

export function formatInstallCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

const DirectorySkillsTab: React.FC<Props> = ({ onOpenInstalled }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { skills: curated, loading: curatedLoading } = useAppSelector((s) => s.skillRegistry);
  const localSkills = useAppSelector((s) => s.skills.items);

  const [query, setQuery] = useState('');
  // claude.ai grammar: Filter by is checkable sections. Community starts unchecked so the landing view is the Anthropic set, same as claude.ai's.
  const [filterSelected, setFilterSelected] = useState<string[]>(['installed', 'not-installed', 'anthropic']);
  const [sort, setSort] = useState('popular');
  const toggleFilter = (value: string) => setFilterSelected((p) => (p.includes(value) ? p.filter((v) => v !== value) : [...p, value]));
  const [community, setCommunity] = useState<CommunitySkill[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<CommunitySkill | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (curated.length === 0) dispatch(fetchAllRegistrySkills());
    dispatch(fetchSkills());
  }, [dispatch, curated.length]);

  // skills.sh is the npx-installable community registry; its results carry install counts.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const seq = ++searchSeq.current;
      setCommunityLoading(true);
      try {
        const res = await searchCommunitySkills(query.trim());
        if (seq === searchSeq.current) setCommunity(res);
      } catch {
        if (seq === searchSeq.current) setCommunity([]);
      } finally {
        if (seq === searchSeq.current) setCommunityLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const installedNames = useMemo(
    () => new Set(Object.values(localSkills).map((s) => s.name.trim().toLowerCase())),
    [localSkills],
  );
  const localIdByName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of Object.values(localSkills)) m[s.name.trim().toLowerCase()] = s.id;
    return m;
  }, [localSkills]);

  const cards = useMemo((): SkillCardModel[] => {
    const q = query.trim().toLowerCase();
    // Join curated skills to their skills.sh twin (source anthropics/skills) so Anthropic cards get real install counts.
    const communityByName = new Map(community.map((cs) => [cs.name.trim().toLowerCase(), cs]));
    const out: SkillCardModel[] = [];
    if (filterSelected.includes('anthropic')) {
      for (const sk of curated) {
        if (q && !sk.name.toLowerCase().includes(q) && !sk.description.toLowerCase().includes(q)) continue;
        const twin = communityByName.get(sk.name.trim().toLowerCase());
        out.push({
          key: `curated:${sk.folder}`,
          slug: sk.name.toLowerCase().replace(/\s+/g, '-'),
          publisher: 'Anthropic',
          description: sk.description,
          installs: twin && /anthropic/i.test(twin.source) ? twin.installs : null,
          isCommunity: false,
          curated: sk,
        });
      }
    }
    if (filterSelected.includes('community')) {
      const curatedNames = new Set(curated.map((sk) => sk.name.trim().toLowerCase()));
      for (const cs of community) {
        // Anthropic-sourced twins already render as curated cards; listing them twice reads as duplicates.
        if (/anthropic/i.test(cs.source) && curatedNames.has(cs.name.trim().toLowerCase())) continue;
        if (q && !cs.name.toLowerCase().includes(q) && !cs.source.toLowerCase().includes(q)) continue;
        out.push({
          key: `community:${cs.source}/${cs.skillId}`,
          slug: cs.skillId.toLowerCase().replace(/\s+/g, '-'),
          publisher: cs.source,
          // skills.sh sometimes echoes the install count as the description; the meta line already carries it.
          description: /^[\d,.]+ installs?$/.test(cs.description.trim()) ? '' : cs.description,
          installs: cs.installs,
          isCommunity: true,
          community: cs,
        });
      }
    }
    const statusOk = (installed: boolean): boolean => (installed ? filterSelected.includes('installed') : filterSelected.includes('not-installed'));
    const withStatus = out.filter((card) => statusOk(installedNames.has((card.curated?.name ?? card.community?.name ?? '').trim().toLowerCase())));
    if (sort === 'name') withStatus.sort((a, b) => a.slug.localeCompare(b.slug));
    else {
      // claude.ai's landing order: installed first, then popularity descending.
      const rank = (card: SkillCardModel): number => (installedNames.has((card.curated?.name ?? card.community?.name ?? '').trim().toLowerCase()) ? 1 : 0);
      withStatus.sort((a, b) => rank(b) - rank(a) || (b.installs ?? -1) - (a.installs ?? -1));
    }
    return withStatus;
  }, [curated, community, query, filterSelected, sort, installedNames]);

  const handleInstallCurated = async (card: SkillCardModel) => {
    if (!card.curated) return;
    setInstallingKey(card.key);
    try {
      await dispatch(installCuratedSkill(card.curated.folder)).unwrap();
      await dispatch(fetchSkills());
      setSnackbar({ open: true, message: `Installed "${card.curated.name}"`, severity: 'success' });
    } catch (e) {
      const msg = (e as { message?: string })?.message || 'unknown error';
      setSnackbar({ open: true, message: `Install failed: ${msg}`, severity: 'error' });
    } finally {
      setInstallingKey(null);
    }
  };

  const isInstalled = (card: SkillCardModel): boolean => {
    const name = (card.curated?.name ?? card.community?.name ?? '').trim().toLowerCase();
    return installedNames.has(name);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%', minHeight: 0 }}>
      <DirectoryFilterBar
        searchPlaceholder="Search skills..."
        query={query}
        onQuery={setQuery}
        filterSections={[
          { label: 'Status', options: [{ value: 'installed', label: 'Installed' }, { value: 'not-installed', label: 'Not installed' }] },
          { label: 'Source', options: [{ value: 'anthropic', label: 'Anthropic' }, { value: 'community', label: 'Community' }] },
        ]}
        filterSelected={filterSelected}
        onToggleFilter={toggleFilter}
        sortOptions={[
          { value: 'popular', label: 'Most popular' },
          { value: 'name', label: 'Name A-Z' },
        ]}
        sortValue={sort}
        onSort={setSort}
      />

      <Box sx={{
        flex: 1, minHeight: 0, overflow: 'auto', pr: 0.5,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.75, alignContent: 'start',
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
      }}>
        {(curatedLoading && curated.length === 0) || (communityLoading && cards.length === 0) ? (
          <Box sx={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', pt: 8 }}>
            <CircularProgress size={24} sx={{ color: c.accent.primary }} />
          </Box>
        ) : cards.length === 0 ? (
          <Box sx={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', pt: 8 }}>
            <Typography sx={{ fontSize: '0.875rem', color: c.text.ghost }}>No skills match your search.</Typography>
          </Box>
        ) : cards.map((card) => {
          const installed = isInstalled(card);
          return (
            <Box
              key={card.key}
              sx={{
                border: `1px solid ${c.border.subtle}`, borderRadius: '14px', p: 2.25,
                bgcolor: c.bg.surface, display: 'flex', flexDirection: 'column', gap: 0.5,
                transition: 'border-color 0.12s, box-shadow 0.12s',
                '&:hover': { borderColor: c.border.medium, boxShadow: c.shadow.sm },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                <Typography noWrap sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>
                  /{card.slug}
                </Typography>
                {installingKey === card.key ? (
                  <CircularProgress size={18} sx={{ color: c.text.tertiary, m: 0.5 }} />
                ) : installed ? (
                  <IconButton
                    size="small"
                    onClick={() => {
                      const id = localIdByName[(card.curated?.name ?? card.community?.name ?? '').trim().toLowerCase()];
                      if (id && onOpenInstalled) onOpenInstalled(id);
                    }}
                    sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
                  >
                    <SettingsOutlinedIcon sx={{ fontSize: 19 }} />
                  </IconButton>
                ) : (
                  <IconButton
                    size="small"
                    onClick={() => (card.isCommunity ? setConfirmTarget(card.community ?? null) : void handleInstallCurated(card))}
                    sx={{ color: c.text.secondary, '&:hover': { color: c.text.primary, bgcolor: c.bg.secondary } }}
                  >
                    <AddIcon sx={{ fontSize: 20 }} />
                  </IconButton>
                )}
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: -0.5 }}>
                <Typography noWrap sx={{ fontSize: '0.8125rem', color: c.text.tertiary }}>{card.publisher}</Typography>
                {card.installs !== null && (
                  <>
                    <Box sx={{ width: 3, height: 3, borderRadius: '50%', bgcolor: c.text.ghost, flexShrink: 0 }} />
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, color: c.text.tertiary }}>
                      <FileDownloadOutlinedIcon sx={{ fontSize: 14 }} />
                      <Typography sx={{ fontSize: '0.8125rem' }}>{formatInstallCount(card.installs)}</Typography>
                    </Box>
                  </>
                )}
              </Box>
              {card.description && (
                <Typography sx={{
                  fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.5,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>
                  {card.description}
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>

      <CommunityInstallConfirm
        skill={confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onInstalled={(name) => {
          setConfirmTarget(null);
          void dispatch(fetchSkills());
          setSnackbar({ open: true, message: `Installed "${name}"`, severity: 'success' });
        }}
      />

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

export default DirectorySkillsTab;
