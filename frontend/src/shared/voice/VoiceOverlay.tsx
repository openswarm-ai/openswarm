import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import MicIcon from '@mui/icons-material/Mic';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentPasteRoundedIcon from '@mui/icons-material/ContentPasteRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useThemeAccent } from '@/shared/styles/ThemeContext';
import { useVoice } from './VoiceDictationContext';

// WhisperFlow-style presence: while the mic is hot, an accent-tinted aurora breathes up from the
// bottom edge, its height and glow riding the live mic level. Imperative rAF writes only (opacity +
// transform on a fixed layer), so 60Hz voice never re-renders React.
const VoiceAurora: React.FC<{ volumeRef: React.MutableRefObject<number> }> = ({ volumeRef }) => {
  const { accent } = useThemeAccent();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      const el = ref.current;
      if (el) {
        const v = volumeRef.current;
        el.style.opacity = String(0.35 + v * 0.65);
        el.style.transform = `scaleY(${0.55 + v * 1.1})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [volumeRef]);
  const a = accent || '#6b62f0';
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, height: 130, zIndex: 2147482999,
        pointerEvents: 'none', transformOrigin: 'bottom',
        background: `linear-gradient(to top, ${a}55 0%, ${a}2e 35%, transparent 100%)`,
        filter: 'blur(14px)',
        transition: 'opacity 120ms linear',
      }}
    />
  );
};

// The whole point: dictation must never look like "nothing happened." This floats a small status
// card above the composer for every phase (listening, transcribing, downloading the model) and shows
// the transcript + whether it was pasted or just copied. Non-interactive, auto-dismisses.
const FEEDBACK_MS = 4500;

function feedbackIcon(icon: string): React.ReactElement {
  if (icon === 'check') return <CheckRoundedIcon sx={{ fontSize: 16, color: '#4ade80' }} />;
  if (icon === 'clipboard') return <ContentPasteRoundedIcon sx={{ fontSize: 15, color: 'rgba(255,255,255,0.8)' }} />;
  if (icon === 'mic') return <MicIcon sx={{ fontSize: 16, color: '#ff8a8a' }} />;
  return <InfoOutlinedIcon sx={{ fontSize: 15, color: 'rgba(255,255,255,0.8)' }} />;
}

const VoiceOverlay: React.FC = () => {
  const { state, pct, feedback, volumeRef } = useVoice();
  const [showFeedback, setShowFeedback] = useState(false);

  useEffect(() => {
    if (!feedback) return undefined;
    setShowFeedback(true);
    const t = setTimeout(() => setShowFeedback(false), FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  const live = state !== 'idle';
  const visible = live || (showFeedback && !!feedback);
  if (!visible) return null;
  const aurora = state === 'recording' ? <VoiceAurora volumeRef={volumeRef} /> : null;

  let content: React.ReactElement;
  if (state === 'recording') {
    content = (
      <>
        <MicIcon sx={{ fontSize: 16, color: '#ff8a8a' }} />
        <span>Listening</span>
        <Box component="span" sx={{
          width: 6, height: 6, borderRadius: '50%', background: '#ff8a8a', ml: 0.25,
          '@keyframes vpulse': { '0%,100%': { opacity: 0.3 }, '50%': { opacity: 1 } },
          animation: 'vpulse 1s ease-in-out infinite',
        }} />
      </>
    );
  } else if (state === 'transcribing') {
    content = (<><CircularProgress size={13} thickness={5} sx={{ color: 'rgba(255,255,255,0.7)' }} /><span>Transcribing</span></>);
  } else if (state === 'preparing') {
    content = (<><CircularProgress size={13} thickness={5} sx={{ color: 'rgba(255,255,255,0.7)' }} /><span>Downloading voice model {pct}%</span></>);
  } else if (feedback) {
    content = (
      <>
        {feedbackIcon(feedback.icon)}
        <Box component="span" sx={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {feedback.text}
        </Box>
      </>
    );
  } else {
    return null;
  }

  return (
    <>
    {aurora}
    <Box
      sx={{
        position: 'fixed',
        bottom: 84,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.75,
        py: 0.9,
        maxWidth: '80vw',
        borderRadius: 999,
        background: 'rgba(22,12,34,0.9)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
        color: 'rgba(255,255,255,0.92)',
        fontSize: '0.8125rem',
        fontWeight: 500,
        '@keyframes vin': { from: { opacity: 0, transform: 'translate(-50%, 6px)' }, to: { opacity: 1, transform: 'translate(-50%, 0)' } },
        animation: 'vin 0.16s ease-out',
      }}
    >
      {content}
    </Box>
    </>
  );
};

export default VoiceOverlay;
