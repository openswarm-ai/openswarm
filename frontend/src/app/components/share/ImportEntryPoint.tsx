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
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { fetchWorkflows } from '@/shared/state/workflowsSlice';

import ImportDigest, { DigestHandle } from './ImportDigest';
import ImportModal from './ImportModal';
import { importCommit, importPreflight } from './shareApi';
import { ImportPreflight } from './shareTypes';
import { importNeedsConfirm } from './importNeedsConfirm';
import { DragVerdict, UNSUPPORTED_DROP_MESSAGE, firstImportable, judgeDrag, looksImportable } from './dragImportability';

export const IMPORT_OPEN_EVENT = 'openswarm:import-open';
const ACCEPT = '.swarm,.md,.zip';
const DIGEST_MS = 820; // keep in step with ImportDigest's wave so the blast reads fully

// Only routes that actually exist belong here. An imported app is an Output that shows up in the Apps sidebar; it has no standalone page (the /apps route was removed), so it must not navigate, or the whole app tree unmounts to a white screen.
const DEST: Record<string, (id: string) => string | null> = {
  dashboard: (id) => `/dashboard/${id}`,
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ImportEntryPoint: React.FC = () => {
  const c = useClaudeTokens();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const dashboardId = useAppSelector((s) => s.tempState.lastDashboardId) || undefined;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const digestRef = useRef<DigestHandle | null>(null);
  const [drag, setDrag] = useState<DragVerdict | null>(null);
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
      // Same staleness for apps: the Apps dock reads the outputs slice, which nothing refetches on import.
      if (rootType === 'app') dispatch(fetchOutputs());
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
      if (!file || confirmRef.current) return;
      if (!looksImportable(file.name)) {
        setToast({ msg: UNSUPPORTED_DROP_MESSAGE, sev: 'error' });
        return;
      }
      // The digest doubles as the spam guard: it refuses to start while busy.
      if (!digestRef.current?.play(x, y)) return;
      let pf: ImportPreflight;
      try {
        [, pf] = await Promise.all([delay(DIGEST_MS), importPreflight(file)]);
      } catch (e: any) {
        setToast({ msg: e?.message || "We couldn't read this file.", sev: 'error' });
        return;
      }
      if (importNeedsConfirm(pf)) {
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
    // Capture phase on purpose: the chat composer stops propagation on its drops, which starved the old bubbling listeners, left the "Drop to add" overlay painted for good and let Chromium open the dropped screenshot in place of the app.
    const onWebview = (t: EventTarget | null) => (t as HTMLElement | null)?.tagName === 'WEBVIEW';
    let lastOver = 0;
    let pulse: number | null = null;
    const clear = () => {
      lastOver = 0;
      setDrag(null);
      if (pulse !== null) {
        window.clearInterval(pulse);
        pulse = null;
      }
    };
    const onOver = (e: DragEvent) => {
      const dt = e.dataTransfer;
      const itemTypes = dt ? Array.from(dt.items).filter((i) => i.kind === 'file').map((i) => i.type) : [];
      const verdict = judgeDrag(dt ? Array.from(dt.types) : [], itemTypes);
      if (verdict === 'no-files' || onWebview(e.target)) {
        if (lastOver) clear();
        return;
      }
      e.preventDefault();
      lastOver = Date.now();
      setDrag(verdict);
      // dragover keeps firing every few hundred ms while a drag hovers the window, so silence means it left or ended, whichever events we never got.
      if (pulse === null) pulse = window.setInterval(() => { if (Date.now() - lastOver > 900) clear(); }, 200);
    };
    const onLeaveWindow = (e: DragEvent) => {
      if (e.relatedTarget === null) clear();
    };
    const onDropAnywhere = () => clear();
    const onDrop = (e: DragEvent) => {
      if (onWebview(e.target)) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      e.preventDefault();
      void handleFile(firstImportable(files) ?? files[0], e.clientX, e.clientY);
    };
    window.addEventListener('dragover', onOver, true);
    window.addEventListener('dragleave', onLeaveWindow, true);
    window.addEventListener('drop', onDropAnywhere, true);
    window.addEventListener('dragend', onDropAnywhere, true);
    window.addEventListener('drop', onDrop);
    return () => {
      clear();
      window.removeEventListener('dragover', onOver, true);
      window.removeEventListener('dragleave', onLeaveWindow, true);
      window.removeEventListener('drop', onDropAnywhere, true);
      window.removeEventListener('dragend', onDropAnywhere, true);
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
      <Fade in={drag !== null} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
        <Box data-osw-drop-overlay={drag ?? undefined} sx={{ position: 'fixed', inset: 0, zIndex: 2000, pointerEvents: 'none' }}>
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
              border: `2px dashed ${drag === 'unsupported' ? c.text.secondary : c.accent.primary}`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
            }}
          >
            <FileDownloadIcon sx={{ fontSize: 40, color: drag === 'unsupported' ? c.text.secondary : c.accent.primary }} />
            <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: c.text.primary }}>
              {drag === 'unsupported' ? UNSUPPORTED_DROP_MESSAGE : 'Drop to add to OpenSwarm'}
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
