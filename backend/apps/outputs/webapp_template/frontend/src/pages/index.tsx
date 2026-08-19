// Cold-start home page for a freshly-seeded OpenSwarm App.
//
// Renders the same Bayer-dither shader as the inline splash in
// `index.html`, so when React mounts and clears `#root`, the animation
// keeps going without a visible flash. The agent overwrites this file
// on its first turn (see SKILL.md), at which point the dither
// disappears and the real app takes over.

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import PixelBlast from '../components/PixelBlast';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const Home: React.FC = () => {
  const c = useClaudeTokens();

  return (
    <Box
      sx={{
        position: 'relative',
        minHeight: '100vh',
        overflow: 'hidden',
        bgcolor: '#1a1a1a',
      }}
    >
      <PixelBlast
        color={c.accent.primary}
        pixelSize={4}
        speed={0.5}
        edgeFade={0.3}
      />
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          pointerEvents: 'none',
          textAlign: 'center',
          px: 3,
        }}
      >
        <Typography
          sx={{
            fontFamily: 'Charter, Georgia, serif',
            fontSize: '2rem',
            fontWeight: 500,
            color: '#f5f5f5',
            letterSpacing: '-0.02em',
            textShadow: '0 2px 24px rgba(26, 26, 26, 0.8)',
          }}
        >
          What're we brewing?
        </Typography>
        <Typography
          sx={{
            fontSize: '0.9rem',
            color: '#b8b8b8',
            maxWidth: 420,
            lineHeight: 1.55,
            textShadow: '0 2px 24px rgba(26, 26, 26, 0.8)',
          }}
        >
          Drop the recipe below. I'll handle the rest.
        </Typography>
      </Box>
    </Box>
  );
};

export default Home;
