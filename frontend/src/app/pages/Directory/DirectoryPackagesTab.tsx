import React, { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchMarketplaceListings } from '@/shared/state/marketplaceCatalogSlice';
import { fetchSkills } from '@/shared/state/skillsSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { fetchWorkflows } from '@/shared/state/workflowsSlice';
import { addViewCard, openWorkflowsApp } from '@/shared/state/dashboardLayoutSlice';
import ImportModal from '@/app/components/share/ImportModal';
import { importNeedsConfirm } from '@/app/components/share/importNeedsConfirm';
import { importCommit } from '@/app/components/share/shareApi';
import type { ImportPreflight } from '@/app/components/share/shareTypes';
import DirectoryFilterBar from './DirectoryFilterBar';
import PackageCard from './packages/PackageCard';
import PackageDialog from './packages/detail/PackageDialog';
import PackageBundleCard from './packages/PackageBundleCard';
import PackageBundleDialog from './packages/detail/PackageBundleDialog';
import { stagePackageInstall } from './packages/installPackage';
import { fetchInstalls, installState, recordFor, recordInstall, type InstallRecord, type PillState } from './packages/installs';
import { KIND_LABELS, isBundle, resolveBundleMembers, type Listing } from './packages/catalog';

type Toast = { message: string; severity: 'success' | 'error' } | null;

// The store tab: packages published to the marketplace sheet. Install downloads the .swarm and hands
// it to the ordinary bundle import, so what a package can do to this machine is reviewed the same way
// a dropped file is.
const DirectoryPackagesTab: React.FC<{ onOpenSkill?: (skillId: string) => void }> = ({ onOpenSkill }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { listings, loading, loaded, source, error } = useAppSelector((s) => s.marketplaceCatalog);
  const outputs = useAppSelector((s) => s.outputs.items);
  const skills = useAppSelector((s) => s.skills.items);
  const workflows = useAppSelector((s) => s.workflows.items);
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [sort, setSort] = useState('newest');
  const [openListing, setOpenListing] = useState<Listing | null>(null);
  const [openBundle, setOpenBundle] = useState<Listing | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Record<string, InstallRecord>>({});
  const [confirm, setConfirm] = useState<{ preflight: ImportPreflight; listingId: string } | null>(null);
  const [committing, setCommitting] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    dispatch(fetchMarketplaceListings(false));
    // The live lists decide whether Open still has something to open; the record alone only says Get is done.
    dispatch(fetchOutputs());
    dispatch(fetchSkills());
    dispatch(fetchWorkflows(undefined));
    let alive = true;
    fetchInstalls().then((m) => { if (alive) setInstalls(m); }).catch(() => {});
    return () => { alive = false; };
  }, [dispatch]);

  const stateFor = (listing: Listing): PillState => (
    installingId === listing.id ? 'installing' : installState(listing, installs[listing.id], { outputs, skills, workflows })
  );

  const openInstalled = (listing: Listing) => {
    const rec = installs[listing.id];
    if (!rec) return;
    if (rec.output_id) dispatch(addViewCard({ outputId: rec.output_id }));
    else if (rec.workflow_id) dispatch(openWorkflowsApp({ workflowId: rec.workflow_id }));
    else if (rec.skill_id) onOpenSkill?.(rec.skill_id);
  };

  const packages = useMemo(() => listings.filter((l) => !isBundle(l)), [listings]);
  const bundles = useMemo(() => listings.filter(isBundle), [listings]);
  const kindOptions = useMemo(
    () => Array.from(new Set(packages.map((l) => l.kind).filter(Boolean))).sort()
      .map((k) => ({ value: k, label: KIND_LABELS[k] || k })),
    [packages],
  );

  const matchesQuery = (l: Listing, q: string): boolean =>
    !q || [l.title, l.description, l.tags, l.author].some((field) => field.toLowerCase().includes(q));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = packages.filter((l) => (kinds.length === 0 || kinds.includes(l.kind)) && matchesQuery(l, q));
    return [...rows].sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title);
      if (sort === 'kind') return a.kind.localeCompare(b.kind);
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
  }, [packages, query, kinds, sort]);

  // A bundle has no single kind, so it leaves the view entirely once the user narrows to one.
  const visibleBundles = useMemo(() => {
    if (kinds.length > 0) return [];
    const q = query.trim().toLowerCase();
    return bundles.filter((b) => matchesQuery(b, q));
  }, [bundles, query, kinds]);

  // The pill turning into Open is the feedback, the way the App Store does it: no toast, no tab jump.
  const finish = async (listingId: string, rootType: string, rootId: string) => {
    const version = listings.find((l) => l.id === listingId)?.version ?? '';
    // Nothing else refetches these on import, so an installed package would otherwise stay invisible.
    if (rootType === 'skill') dispatch(fetchSkills());
    if (rootType === 'app') dispatch(fetchOutputs());
    if (rootType === 'workflow') dispatch(fetchWorkflows(undefined));
    try {
      setInstalls(await recordInstall(recordFor(listingId, rootType, rootId, version)));
    } catch (e: unknown) {
      setInstalls((prev) => ({ ...prev, [listingId]: { ...recordFor(listingId, rootType, rootId, version), installed_at: Date.now() / 1000 } }));
      setToast({ message: e instanceof Error ? e.message : "Installed, but the store couldn't remember it.", severity: 'error' });
    }
  };

  const commit = async (preflight: ImportPreflight, listingId: string) => {
    setCommitting(true);
    try {
      const res = await importCommit(preflight.staging_token);
      await finish(listingId, res.root_type, res.root_id);
      setConfirm(null);
    } catch (e: unknown) {
      setToast({ message: e instanceof Error ? e.message : "We couldn't finish the install.", severity: 'error' });
    } finally {
      setCommitting(false);
    }
  };

  const install = async (listingId: string) => {
    setInstallingId(listingId);
    try {
      const preflight = await stagePackageInstall(listingId);
      if (importNeedsConfirm(preflight)) setConfirm({ preflight, listingId });
      else await commit(preflight, listingId);
    } catch (e: unknown) {
      setToast({ message: e instanceof Error ? e.message : "We couldn't download this package.", severity: 'error' });
    } finally {
      setInstallingId(null);
    }
  };

  const installBundle = async (bundle: Listing) => {
    const members = resolveBundleMembers(bundle, listings).filter((m) => m.download_url);
    if (members.length === 0) {
      setToast({ message: 'This bundle has no installable packages yet.', severity: 'error' });
      return;
    }
    // One at a time: each member gets its own review, and a bundle must not be a way to skip one.
    for (const member of members) {
      await install(member.id);
    }
  };

  const sectionLabel = (label: string, count?: number): React.ReactElement | null => {
    if (!label) return null;
    return (
      <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, letterSpacing: '0.01em' }}>
          {label}
        </Typography>
        {typeof count === 'number' && (
          <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>{count}</Typography>
        )}
      </Stack>
    );
  };

  const body = (): React.ReactElement => {
    if (loading && !loaded) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 8 }}>
          <CircularProgress size={24} sx={{ color: c.accent.primary }} />
        </Box>
      );
    }
    if (visible.length === 0 && visibleBundles.length === 0) {
      return (
        <Typography sx={{ fontSize: '0.9375rem', color: c.text.tertiary, pt: 6, textAlign: 'center' }}>
          {error ? error : 'No packages match that search yet.'}
        </Typography>
      );
    }
    return (
      <>
        {visibleBundles.length > 0 && (
          <Box sx={{ mb: 3 }}>
            {sectionLabel('Collections')}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {visibleBundles.map((bundle) => (
                <PackageBundleCard
                  key={bundle.id}
                  bundle={bundle}
                  members={resolveBundleMembers(bundle, listings)}
                  onOpen={() => setOpenBundle(bundle)}
                />
              ))}
            </Box>
          </Box>
        )}
        {visible.length > 0 && sectionLabel(visibleBundles.length > 0 ? 'All packages' : '', visible.length)}
        <Box
          sx={{
            display: 'grid',
            // Fills the width at any card size, so an odd count leaves one gap rather than half a row.
            gridTemplateColumns: 'repeat(auto-fill, minmax(272px, 1fr))',
            gap: 1.25,
            alignContent: 'start',
          }}
        >
          {visible.map((listing) => (
            <PackageCard
              key={listing.id}
              listing={listing}
              state={stateFor(listing)}
              onOpen={() => setOpenListing(listing)}
              onGet={() => { void install(listing.id); }}
              onOpenInstalled={() => openInstalled(listing)}
              onTag={(tag) => setQuery(tag)}
            />
          ))}
        </Box>
      </>
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 1.75 }}>
      <DirectoryFilterBar
        searchPlaceholder="Search packages, tags, authors"
        query={query}
        onQuery={setQuery}
        filterSections={[{ label: 'Kind', options: kindOptions }]}
        filterSelected={kinds}
        onToggleFilter={(value) => setKinds((prev) => (prev.includes(value) ? prev.filter((k) => k !== value) : [...prev, value]))}
        sortOptions={[
          { value: 'newest', label: 'Newest' },
          { value: 'name', label: 'Name' },
          { value: 'kind', label: 'Kind' },
        ]}
        sortValue={sort}
        onSort={setSort}
        leading={
          loaded ? (
            <Typography sx={{ fontSize: '0.8125rem', color: c.text.muted }}>
              {visible.length + visibleBundles.length} {visible.length + visibleBundles.length === 1 ? 'result' : 'results'}
            </Typography>
          ) : null
        }
      />
      {source === 'cache' && (
        <Typography sx={{ fontSize: '0.8125rem', color: c.text.muted }}>
          Showing the last catalog we loaded; the marketplace could not be reached just now.
        </Typography>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}>{body()}</Box>
      <PackageDialog
        listing={openListing}
        state={openListing ? stateFor(openListing) : 'get'}
        onInstall={() => { if (openListing) void install(openListing.id); }}
        onOpen={() => { if (openListing) openInstalled(openListing); }}
        onClose={() => setOpenListing(null)}
      />
      <PackageBundleDialog
        bundle={openBundle}
        members={openBundle ? resolveBundleMembers(openBundle, listings) : []}
        stateOf={(id) => { const l = listings.find((x) => x.id === id); return l ? stateFor(l) : 'get'; }}
        onOpenInstalled={(member) => openInstalled(member)}
        installing={installingId !== null}
        onInstallAll={() => { if (openBundle) void installBundle(openBundle); }}
        onInstallMember={(id) => { void install(id); }}
        onOpenMember={(member) => { setOpenBundle(null); setOpenListing(member); }}
        onClose={() => setOpenBundle(null)}
      />
      <ImportModal
        preflight={confirm?.preflight ?? null}
        open={!!confirm}
        committing={committing}
        onConfirm={() => confirm && commit(confirm.preflight, confirm.listingId)}
        onClose={() => setConfirm(null)}
      />
      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity || 'success'} variant="filled" onClose={() => setToast(null)}>
          {toast?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default DirectoryPackagesTab;
