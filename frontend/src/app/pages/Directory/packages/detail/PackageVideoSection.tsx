import React, { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import MovieIcon from '@mui/icons-material/Movie';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { videoEmbeds, type VideoEmbed } from '../catalog';
import YouTubePlayer from './YouTubePlayer';

// The visible band of the cropped YouTube player, and how far it is slid up to hide the letterboxed top.
const YT_WINDOW_HEIGHT = 500;
const YT_TOP_OFFSET = -160;

// maxresdefault is missing for some uploads, so fall back to the size every video has.
function fallbackThumb(e: React.SyntheticEvent<HTMLImageElement>) {
  const img = e.currentTarget;
  if (img.src.includes('maxresdefault')) img.src = img.src.replace('maxresdefault', 'hqdefault');
}

// A facade player: at rest a clean poster plus our own play button, so the resting state matches the rest of the UI.
function DemoVideo({ embed }: { embed: VideoEmbed }) {
  const c = useClaudeTokens();
  const [playing, setPlaying] = useState(false);

  const frame = {
    position: 'relative' as const,
    width: '100%',
    aspectRatio: '16 / 9',
    mb: 3,
    borderRadius: 3,
    overflow: 'hidden',
    bgcolor: '#000',
    border: `1px solid ${c.border.subtle}`,
  };

  if (embed.kind === 'file') {
    return (
      <Box sx={frame}>
        <Box
          component="video"
          src={embed.src}
          controls
          preload="metadata"
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      </Box>
    );
  }

  // The overflow crop is the only thing that removes YouTube's edge-anchored chrome from the square player.
  if (playing && embed.videoId) {
    return (
      <Box sx={{ height: YT_WINDOW_HEIGHT, borderRadius: 3, overflow: 'hidden' }}>
        <Box sx={{ mt: `${YT_TOP_OFFSET}px` }}>
          <YouTubePlayer videoId={embed.videoId} />
        </Box>
      </Box>
    );
  }

  return (
    <Box
      onClick={() => setPlaying(true)}
      role="button"
      aria-label="Play demo video"
      sx={{ ...frame, cursor: 'pointer', '&:hover .demo-play': { transform: 'translate(-50%, -50%) scale(1.06)' } }}
    >
      {embed.poster && (
        <Box
          component="img"
          src={embed.poster}
          alt=""
          onError={fallbackThumb}
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
      <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,0.18)' }} />
      <Box
        className="demo-play"
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 68,
          height: 68,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(8px)',
          boxShadow: c.shadow.lg,
          transition: c.transition,
        }}
      >
        <PlayArrowRounded sx={{ fontSize: 40, color: c.text.primary, ml: 0.5 }} />
      </Box>
    </Box>
  );
}

function UpNextThumb({
  item,
  active,
  onClick,
}: {
  item: { url: string; embed: VideoEmbed };
  active: boolean;
  onClick: () => void;
}) {
  const c = useClaudeTokens();
  return (
    <Box
      onClick={onClick}
      role="button"
      aria-label="Play this video"
      sx={{
        position: 'relative',
        width: { xs: 140, sm: '100%' },
        flexShrink: 0,
        aspectRatio: '16 / 9',
        borderRadius: 2,
        overflow: 'hidden',
        cursor: 'pointer',
        bgcolor: '#000',
        border: `2px solid ${active ? c.accent.primary : c.border.subtle}`,
        boxShadow: active ? `0 0 0 3px ${c.accent.primary}33` : 'none',
        transition: c.transition,
        opacity: active ? 1 : 0.82,
        '&:hover': { opacity: 1 },
      }}
    >
      {item.embed.poster ? (
        <Box
          component="img"
          src={item.embed.poster}
          alt=""
          onError={fallbackThumb}
          sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <MovieIcon sx={{ fontSize: 28, color: 'rgba(255,255,255,0.6)' }} />
        </Box>
      )}
      <Box sx={{ position: 'absolute', inset: 0, bgcolor: active ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.12)' }} />
      {active && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{
            position: 'absolute',
            bottom: 6,
            left: 6,
            px: 0.75,
            py: 0.25,
            borderRadius: 999,
            bgcolor: c.accent.primary,
            boxShadow: c.shadow.sm,
          }}
        >
          <GraphicEqIcon sx={{ fontSize: 13, color: '#fff' }} />
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: '#fff', lineHeight: 1, letterSpacing: '0.01em' }}>
            Now playing
          </Typography>
        </Stack>
      )}
    </Box>
  );
}

// Keying DemoVideo on the active URL remounts it, so switching clips starts the new one cleanly.
export default function PackageVideoSection({ raw }: { raw: string }) {
  const c = useClaudeTokens();
  const videos = useMemo(() => videoEmbeds(raw), [raw]);
  const [activeUrl, setActiveUrl] = useState(videos[0]?.url ?? '');
  if (videos.length === 0) return null;
  const active = videos.find((v) => v.url === activeUrl) ?? videos[0];
  const hasUpNext = videos.length > 1;

  return (
    <Stack
      direction={{ xs: 'column', sm: hasUpNext ? 'row' : 'column' }}
      spacing={hasUpNext ? 2 : 0}
      alignItems="flex-start"
    >
      <Box sx={{ flex: 1, minWidth: 0, width: '100%', '& > *': { mb: '0 !important' } }}>
        <DemoVideo key={active.url} embed={active.embed} />
      </Box>
      {hasUpNext && (
        <Box sx={{ width: { xs: '100%', sm: 118 }, flexShrink: 0 }}>
          <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.muted, mb: 1 }}>
            Up next
          </Typography>
          <Stack
            direction={{ xs: 'row', sm: 'column' }}
            sx={{ gap: 1.25, overflowX: { xs: 'auto', sm: 'visible' }, pb: 0.5 }}
          >
            {videos.map((v) => (
              <UpNextThumb key={v.url} item={v} active={v.url === active.url} onClick={() => setActiveUrl(v.url)} />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}
