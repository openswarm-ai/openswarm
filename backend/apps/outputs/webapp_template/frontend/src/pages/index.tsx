import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const Home: React.FC = () => {
  const c = useClaudeTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100%',
        px: 2,
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.8 }}
      >
        <Box sx={{ maxWidth: 440, width: '100%', textAlign: 'center' }}>
          <Box
            component="img"
            src="/logo.png"
            alt="OpenSwarm"
            sx={{ width: 48, height: 48, objectFit: 'contain', mb: 1 }}
          />
          <Typography
            variant="h6"
            sx={{
              fontWeight: 700,
              color: c.text.primary,
              mb: 0.5,
              fontFamily: c.font.serif,
              letterSpacing: '-0.01em',
            }}
          >
            OpenSwarm
          </Typography>
          <Typography
            sx={{
              fontSize: '0.875rem',
              color: c.text.secondary,
              fontFamily: c.font.serif,
            }}
          >
            Web app template — ready to build.
          </Typography>
        </Box>
      </motion.div>
    </Box>
  );
};

export default Home;
