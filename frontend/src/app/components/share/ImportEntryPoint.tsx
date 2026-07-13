// The one global import affordance. Drop a .swarm anywhere (or pick it): a GPU-safe pixel "digest" flash plays where you dropped it WHILE the preflight runs underneath, then it resolves straight into the import for safe bundles or a short confirm for ones that carry code/actions. Mount once near the app root.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import { useNavigate } from 'react-router-dom';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchWorkflows } from '@/shared/state/workflowsSlice';

import ImportDigest, { DigestHandle } from './ImportDigest';
import ImportModal from './ImportModal';
import { importCommit, importPreflight } from './shareApi';
import { ImportPreflight } from './shareTypes';

export const IMPORT_OPEN_EVENT = 'openswarm:import-open';
const ACCEPT = '.swarm,.md,.zip';
const DIGEST_MS = 820; // keep in step with ImportDigest's wave so the blast reads fully

// Only routes that actually exist belong here. An imported app is an Output that shows up in the Apps sidebar; it has no standalone page (the /apps route was removed), so it must not navigate, or the whole app tree unmounts to a white screen.
const DEST: Record<string, (id: string) => string | null> = {
  dashboard: (id) => `/dashboard/${id}`,
};

function looksImportable(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.swarm') || n.endsWith('.md') || n.endsWith('.zip');
}

// A bundle needs a confirm only if it can run code (an app) or wants actions connected; everything else is inert data and imports straight away.
function needsConfirm(pf: ImportPreflight): boolean {
  const s = pf.summary;
  const hasApp = s.root.type === 'app' || s.includes.some((i) => i.type === 'app');
  const hasAction = s.requirements.some((r) => r.kind === 'mcp_action');
  const risky = !!pf.review && pf.review.verdict !== 'clean';
  return hasApp || hasAction || risky;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ImportEntryPoint: React.FC = () => {
  const c = useClaudeTokens();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const dashboardId = useAppSelector((s) => s.tempState.lastDashboardId) || undefined;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const digestRef = useRef<DigestHandle | null>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<ImportPreflight | null>(null);
  const [committing, setCommitting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; sev: 'success' | 'error' } | null>(null);
  const confirmRef = useRef(false); // ignore new drops while a confirm is up

  const finish = useCallback(
    (rootType: string, rootId: string, name: string) => {
      const msg = rootType === 'app' ? `Added ${name} to your Apps` : `Added ${name}`;
      setToast({ msg, sev: 'success' });
      // A workflow has no route of its own, so nothing would pull it in: an open Workflows hub only fetches on mount and would keep showing a stale list. Import drops dashboard_id, and /list keeps unassigned workflows for every dashboard, so this surfaces it wherever the user is.
      if (rootType === 'workflow') dispatch(fetchWorkflows(dashboardId));
      const to = DEST[rootType]?.(rootId);
      if (to) navigate(to);
    },
    [navigate, dispatch, dashboardId],
  );

  const commitAndFinish = useCallback(
    async (pf: ImportPreflight) => {
      setCommitting(true);
      try {
        const res = await importCommit(pf.staging_token);
        finish(res.root_type, res.root_id, pf.summary.root.name);
        setConfirm(null);
        confirmRef.current = false;
      } catch (e: any) {
        setToast({ msg: e?.message || "We couldn't finish the import.", sev: 'error' });
      } finally {
        setCommitting(false);
      }
    },
    [finish],
  );

  const handleFile = useCallback(
    async (file: File | null, x: number, y: number) => {
      if (!file || !looksImportable(file.name) || confirmRef.current) return;
      // The digest doubles as the spam guard: it refuses to start while busy.
      if (!digestRef.current?.play(x, y)) return;
      let pf: ImportPreflight;
      try {
        [, pf] = await Promise.all([delay(DIGEST_MS), importPreflight(file)]);
      } catch (e: any) {
        setToast({ msg: e?.message || "We couldn't read this file.", sev: 'error' });
        return;
      }
      if (needsConfirm(pf)) {
        confirmRef.current = true;
        setConfirm(pf);
      } else {
        commitAndFinish(pf);
      }
    },
    [commitAndFinish],
  );

  useEffect(() => {
    const openPicker = () => inputRef.current?.click();
    window.addEventListener(IMPORT_OPEN_EVENT, openPicker);
    return () => window.removeEventListener(IMPORT_OPEN_EVENT, openPicker);
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onWebview = (t: EventTarget | null) => (t as HTMLElement)?.tagName === 'WEBVIEW';
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || onWebview(e.target)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setDragging(false);
      if (onWebview(e.target)) return;
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        e.preventDefault();
        void handleFile(f, e.clientX, e.clientY);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFile]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleFile(e.target.files?.[0] || null, window.innerWidth / 2, window.innerHeight / 2);
          e.target.value = '';
        }}
      />
      <ImportDigest ref={digestRef} color={c.accent.primary} />
      <Fade in={dragging} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
        <Box sx={{ position: 'fixed', inset: 0, zIndex: 2000, pointerEvents: 'none' }}>
          {/* Full-bleed dim, rounded to match the window so its corners don't
              spill past the OS's rounded corners. */}
          <Box sx={{ position: 'absolute', inset: 0, bgcolor: `${c.bg.page}e6`, borderRadius: '12px' }} />
          {/* The dashed drop-zone sits a hair inside so every corner stays in
              view inside the rounded window, instead of getting clipped. */}
          <Box
            sx={{
              position: 'absolute',
              inset: 14,
              borderRadius: '18px',
              border: `2px dashed ${c.accent.primary}`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
            }}
          >
            <FileDownloadIcon sx={{ fontSize: 40, color: c.accent.primary }} />
            <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: c.text.primary }}>
              Drop to add to OpenSwarm
            </Typography>
          </Box>
        </Box>
      </Fade>
      <ImportModal
        preflight={confirm}
        open={!!confirm}
        committing={committing}
        onConfirm={() => confirm && commitAndFinish(confirm)}
        onClose={() => {
          setConfirm(null);
          confirmRef.current = false;
        }}
      />
      <Snackbar
        open={!!toast}
        autoHideDuration={3500}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={toast?.sev || 'success'}
          variant="outlined"
          onClose={() => setToast(null)}
          sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.border.medium}` }}
        >
          {toast?.msg}
        </Alert>
      </Snackbar>
    </>
  );
};

export default ImportEntryPoint;
