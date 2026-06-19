// Publish an app to {slug}.openswarm.host. Flow: scan the code (AST + an aux-LLM
// pass, on the user's own creds) -> if findings, show them with Cancel/Fix/Publish
// Anyway -> build + upload -> show the live link. Already-published apps open
// straight to the manage view (visit / copy / unpublish).
import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Fade from '@mui/material/Fade';
import CloseIcon from '@mui/icons-material/Close';
import PublicIcon from '@mui/icons-material/Public';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { setOutputPublishState } from '@/shared/state/outputsSlice';

import { ReviewSummary } from './shareTypes';
import { publishApp, publishPreflight, unpublishApp } from './publishApi';

interface Props {
  outputId: string;
  outputName: string;
  open: boolean;
  onClose: () => void;
}

type Phase = 'scanning' | 'review' | 'publishing' | 'done' | 'error';

const PublishModal: React.FC<Props> = ({ outputId, outputName, open, onClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const publishedUrl = useAppSelector((s) => s.outputs.items[outputId]?.published_url) ?? null;

  const [phase, setPhase] = useState<Phase>('scanning');
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const runScan = useCallback(() => {
    setPhase('scanning');
    setReview(null);
    setErrorMsg('');
    let alive = true;
    publishPreflight(outputId)
      .then((r) => alive && (setReview(r), setPhase('review')))
      .catch((e) => alive && (setErrorMsg(e?.message || "We couldn't check this app."), setPhase('error')));
    return () => {
      alive = false;
    };
  }, [outputId]);

  useEffect(() => {
    if (!open) return;
    setShowDetails(false);
    if (publishedUrl) {
      setLiveUrl(publishedUrl);
      setPhase('done');
      return;
    }
    return runScan();
  }, [open, publishedUrl, runScan]);

  const doPublish = async (force: boolean) => {
    setPhase('publishing');
    try {
      const res = await publishApp(outputId, { force });
      if (res.ok && res.published_url) {
        dispatch(
          setOutputPublishState({
            id: outputId,
            published_slug: res.published_slug ?? null,
            published_url: res.published_url,
            publish_status: 'published',
          }),
        );
        setLiveUrl(res.published_url);
        setPhase('done');
      } else if (res.blocked && res.review) {
        setReview(res.review);
        setPhase('review');
      } else {
        setErrorMsg(res.error || 'Publishing failed. Please try again.');
        setPhase('error');
      }
    } catch (e: any) {
      setErrorMsg(e?.message || 'Publishing failed. Please try again.');
      setPhase('error');
    }
  };

  const doUnpublish = async () => {
    setBusy(true);
    try {
      await unpublishApp(outputId);
      dispatch(setOutputPublishState({ id: outputId, published_slug: null, published_url: null, publish_status: null }));
      setToast('App unpublished');
      onClose();
    } catch (e: any) {
      setToast(e?.message || "We couldn't unpublish.");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!liveUrl) return;
    await navigator.clipboard.writeText(liveUrl);
    setToast('Link copied');
  };

  const findings = review?.findings ?? [];
  const hasFindings = (review && review.verdict !== 'clean') || findings.length > 0;

  const center = (node: React.ReactNode) => (
    <Box sx={{ minHeight: 150, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, px: 2 }}>
      {node}
    </Box>
  );

  const body = () => {
    if (phase === 'scanning') {
      return center(
        <>
          <CircularProgress size={22} sx={{ color: c.accent.primary }} />
          <Typography sx={{ fontSize: '0.85rem', color: c.text.secondary }}>Checking your app before it goes live...</Typography>
        </>,
      );
    }
    if (phase === 'publishing') {
      return center(
        <>
          <CircularProgress size={22} sx={{ color: c.accent.primary }} />
          <Typography sx={{ fontSize: '0.85rem', color: c.text.secondary }}>Building and publishing your app...</Typography>
        </>,
      );
    }
    if (phase === 'error') {
      return center(
        <>
          <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, color: c.text.primary }}>Something went wrong</Typography>
          <Typography sx={{ fontSize: '0.82rem', color: c.text.secondary, textAlign: 'center' }}>{errorMsg}</Typography>
        </>,
      );
    }
    if (phase === 'done') {
      return (
        <Box sx={{ px: 2.5, py: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleOutlineIcon sx={{ color: c.status.success, fontSize: 22 }} />
            <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: c.text.primary }}>Your app is live</Typography>
          </Box>
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 1, p: 1, borderRadius: `${c.radius.md}px`,
              border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.secondary,
            }}
          >
            <Typography sx={{ flex: 1, minWidth: 0, fontSize: '0.82rem', color: c.text.primary, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {liveUrl}
            </Typography>
            <IconButton size="small" onClick={copyLink} sx={{ color: c.text.tertiary }}><ContentCopyIcon sx={{ fontSize: 16 }} /></IconButton>
            <IconButton size="small" onClick={() => liveUrl && window.open(liveUrl, '_blank')} sx={{ color: c.text.tertiary }}><OpenInNewIcon sx={{ fontSize: 16 }} /></IconButton>
          </Box>
        </Box>
      );
    }
    // review
    if (!hasFindings) {
      return center(
        <>
          <CheckCircleOutlineIcon sx={{ color: c.status.success, fontSize: 26 }} />
          <Typography sx={{ fontSize: '0.88rem', color: c.text.primary }}>Looks good. Ready to publish.</Typography>
        </>,
      );
    }
    return (
      <Box sx={{ px: 2.5, py: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningAmberIcon sx={{ color: c.status.warning, fontSize: 22 }} />
          <Typography sx={{ fontSize: '0.92rem', fontWeight: 600, color: c.text.primary }}>
            {findings.length} security risk{findings.length === 1 ? '' : 's'} found
          </Typography>
        </Box>
        <Typography sx={{ fontSize: '0.8rem', color: c.text.secondary }}>
          You can still publish, fix them first, or cancel.
        </Typography>
        <Button onClick={() => setShowDetails((s) => !s)} sx={{ alignSelf: 'flex-start', textTransform: 'none', color: c.accent.primary, fontSize: '0.78rem', px: 0.5 }}>
          {showDetails ? 'Hide details' : 'Show details'}
        </Button>
        {showDetails && (
          <Box component="ul" sx={{ m: 0, pl: 2.5, color: c.text.secondary, fontSize: '0.76rem', lineHeight: 1.55, maxHeight: 160, overflow: 'auto' }}>
            {findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </Box>
        )}
      </Box>
    );
  };

  const actions = () => {
    if (phase === 'scanning' || phase === 'publishing') return null;
    if (phase === 'error') {
      return (
        <>
          <Button onClick={onClose} sx={{ color: c.text.muted, textTransform: 'none' }}>Close</Button>
          <Button variant="contained" onClick={runScan} sx={{ bgcolor: c.accent.primary, textTransform: 'none' }}>Try again</Button>
        </>
      );
    }
    if (phase === 'done') {
      return (
        <>
          <Button onClick={doUnpublish} disabled={busy} sx={{ color: c.status.error, textTransform: 'none' }}>Unpublish</Button>
          <Button variant="contained" onClick={onClose} sx={{ bgcolor: c.accent.primary, textTransform: 'none' }}>Done</Button>
        </>
      );
    }
    // review
    if (!hasFindings) {
      return (
        <>
          <Button onClick={onClose} sx={{ color: c.text.muted, textTransform: 'none' }}>Cancel</Button>
          <Button variant="contained" onClick={() => doPublish(false)} sx={{ bgcolor: c.accent.primary, textTransform: 'none' }}>Publish</Button>
        </>
      );
    }
    return (
      <>
        <Button onClick={onClose} sx={{ color: c.text.muted, textTransform: 'none' }}>Cancel</Button>
        <Button onClick={runScan} sx={{ color: c.accent.primary, textTransform: 'none' }}>Fix</Button>
        <Button variant="contained" onClick={() => doPublish(true)} sx={{ bgcolor: c.status.warning, textTransform: 'none', '&:hover': { bgcolor: c.status.warning } }}>
          Publish anyway
        </Button>
      </>
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth={false}
        TransitionComponent={Fade}
        transitionDuration={{ enter: 200, exit: 220 }}
        PaperProps={{ sx: { width: 440, maxWidth: '92vw', bgcolor: c.bg.page, borderRadius: `${c.radius.xl}px`, border: `1px solid ${c.border.subtle}`, boxShadow: c.shadow.lg } }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, pt: 2.5, pb: 0.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PublicIcon sx={{ fontSize: 18, color: c.accent.primary }} />
            <Typography sx={{ fontSize: '1.02rem', fontWeight: 700, color: c.text.primary }}>Publish {outputName}</Typography>
          </Box>
          <IconButton size="small" onClick={onClose} sx={{ color: c.text.tertiary }}><CloseIcon sx={{ fontSize: 18 }} /></IconButton>
        </Box>
        {body()}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, px: 3, pb: 2, pt: 1 }}>{actions()}</Box>
      </Dialog>
      <Snackbar open={!!toast} autoHideDuration={2500} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </>
  );
};

export default PublishModal;
