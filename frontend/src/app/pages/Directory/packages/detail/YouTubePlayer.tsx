import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import PauseRounded from '@mui/icons-material/PauseRounded';
import VolumeUpRounded from '@mui/icons-material/VolumeUpRounded';
import VolumeOffRounded from '@mui/icons-material/VolumeOffRounded';
import FullscreenRounded from '@mui/icons-material/FullscreenRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface YouTubePlayerApi {
  playVideo: () => void;
  pauseVideo: () => void;
  mute: () => void;
  unMute: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
}

interface YouTubeReadyEvent {
  target: YouTubePlayerApi;
}

interface YouTubeStateEvent {
  target: YouTubePlayerApi;
  data: number;
}

interface YouTubeApi {
  Player: new (
    host: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, number>;
      events: {
        onReady: (e: YouTubeReadyEvent) => void;
        onStateChange: (e: YouTubeStateEvent) => void;
      };
    },
  ) => YouTubePlayerApi;
  PlayerState: { PLAYING: number };
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

// The iframe API script is global and answers through one window callback, so every player shares a single load.
function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiPromise;
}

function fmt(seconds: number): string {
  const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function YouTubePlayer({ videoId }: { videoId: string }) {
  const c = useClaudeTokens();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YouTubePlayerApi | null>(null);
  const rafRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    let disposed = false;
    void loadApi().then(() => {
      const api = window.YT;
      if (disposed || !api || !hostRef.current) return;
      playerRef.current = new api.Player(hostRef.current, {
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          rel: 0,
          fs: 0,
          disablekb: 1,
          iv_load_policy: 3,
          playsinline: 1,
        },
        events: {
          onReady: (e) => {
            setReady(true);
            setDur(e.target.getDuration() || 0);
            e.target.playVideo();
          },
          onStateChange: (e) => {
            const playingNow = e.data === api.PlayerState.PLAYING;
            setPlaying(playingNow);
            if (playingNow) setDur(e.target.getDuration() || 0);
          },
        },
      });
    });
    return () => {
      disposed = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try {
        playerRef.current?.destroy();
      } catch {
        // A player torn down with its iframe already gone throws on destroy; nothing left to clean up.
      }
    };
  }, [videoId]);

  useEffect(() => {
    const tick = () => {
      const p = playerRef.current;
      if (p?.getCurrentTime) setCur(p.getCurrentTime() || 0);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) {
      p.unMute();
      setMuted(false);
    } else {
      p.mute();
      setMuted(true);
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const p = playerRef.current;
    if (!p || !dur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    p.seekTo(frac * dur, true);
    setCur(frac * dur);
  };

  const goFullscreen = () => {
    const el = hostRef.current?.parentElement;
    el?.requestFullscreen?.();
  };

  // Square frame on purpose: YouTube anchors its title and control chrome to the player box, so a box taller than 16:9 letterboxes the video and lands that chrome on the black bands the caller crops away.
  const frame = {
    position: 'relative' as const,
    width: '100%',
    aspectRatio: '1 / 1',
    mb: 3,
    borderRadius: 3,
    overflow: 'hidden',
    bgcolor: '#000',
    border: `1px solid ${c.border.subtle}`,
  };

  return (
    <Box sx={frame} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Box
        ref={hostRef}
        sx={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          '& iframe': { width: '100%', height: '100%', border: 0, display: 'block' },
        }}
      />

      {/* Swallows every hover and click so YouTube never paints its own chrome. */}
      <Box onClick={togglePlay} sx={{ position: 'absolute', inset: 0, cursor: 'pointer', zIndex: 2 }} />

      {/* Opaque while paused, hiding YouTube's title, share and watch-later overlay behind our own play button. */}
      <Box
        onClick={togglePlay}
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          bgcolor: '#000',
          opacity: ready && playing ? 0 : 1,
          pointerEvents: ready && playing ? 'none' : 'auto',
          transition: 'opacity 160ms ease',
        }}
      >
        <Box
          sx={{
            width: 68,
            height: 68,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(255,255,255,0.92)',
            boxShadow: c.shadow.lg,
          }}
        >
          <PlayArrowRounded sx={{ fontSize: 40, color: '#111', ml: 0.5 }} />
        </Box>
      </Box>

      <Box
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 5,
          px: 1.5,
          pt: 3,
          pb: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)',
          opacity: playing && hover ? 1 : 0,
          pointerEvents: playing && hover ? 'auto' : 'none',
          transition: 'opacity 160ms ease',
        }}
      >
        <Box
          onClick={seek}
          sx={{ position: 'relative', height: 4, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.28)', cursor: 'pointer', mb: 0.5 }}
        >
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${dur ? (cur / dur) * 100 : 0}%`,
              bgcolor: '#fff',
              borderRadius: 2,
            }}
          />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <IconButton onClick={togglePlay} size="small" sx={{ color: '#fff' }}>
            {playing ? <PauseRounded /> : <PlayArrowRounded />}
          </IconButton>
          <IconButton onClick={toggleMute} size="small" sx={{ color: '#fff' }}>
            {muted ? <VolumeOffRounded /> : <VolumeUpRounded />}
          </IconButton>
          <Box sx={{ fontSize: '0.78rem', color: '#fff', fontVariantNumeric: 'tabular-nums', ml: 0.5 }}>
            {fmt(cur)} / {fmt(dur)}
          </Box>
          <Box sx={{ flex: 1 }} />
          <IconButton onClick={goFullscreen} size="small" sx={{ color: '#fff' }}>
            <FullscreenRounded />
          </IconButton>
        </Box>
      </Box>
    </Box>
  );
}
