import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import { motion } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { HEALTH_CHECK_URL } from '@/shared/state/API_ENDPOINTS';

const BACKEND_ENABLED = process.env.BACKEND_ENABLED;

type HealthStatus = 'idle' | 'loading' | 'ok' | 'error';

interface HealthResult {
  status: HealthStatus;
  message: string;
  latencyMs: number | null;
}

const Health: React.FC = () => {
  const c = useClaudeTokens();
  const [result, setResult] = useState<HealthResult>({
    status: 'idle',
    message: '',
    latencyMs: null,
  });

  const pingHealth = useCallback(async () => {
    setResult({ status: 'loading', message: '', latencyMs: null });
    const start = performance.now();
    try {
      const res = await fetch(HEALTH_CHECK_URL);
      const elapsed = Math.round(performance.now() - start);
      const text = await res.text();
      if (res.ok) {
        setResult({ status: 'ok', message: text, latencyMs: elapsed });
      } else {
        setResult({ status: 'error', message: `${res.status} — ${text}`, latencyMs: elapsed });
      }
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      const msg = err instanceof Error ? err.message : 'Network error';
      setResult({ status: 'error', message: msg, latencyMs: elapsed });
    }
  }, []);

  const statusColor =
    result.status === 'ok'
      ? c.status.success
      : result.status === 'error'
        ? c.status.error
        : c.text.tertiary;

  const statusBg =
    result.status === 'ok'
      ? c.status.successBg
      : result.status === 'error'
        ? c.status.errorBg
        : 'transparent';

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
            Health
          </Typography>

          <Typography
            sx={{
              fontSize: '0.875rem',
              color: c.text.secondary,
              mb: 4,
              fontFamily: c.font.serif,
            }}
          >
            {BACKEND_ENABLED ? 'Backend health check' : 'Frontend-only mode'}
          </Typography>

          <Box
            sx={{
              borderRadius: `${c.radius.xl}px`,
              border: `1px solid ${c.border.subtle}`,
              bgcolor: c.bg.surface,
              boxShadow: c.shadow.sm,
              overflow: 'hidden',
              transition: 'all 0.2s ease',
              '&:hover': {
                borderColor: c.border.strong,
                boxShadow: c.shadow.md,
              },
            }}
          >
            {BACKEND_ENABLED ? (
              <>
                <Box sx={{ p: 3 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 1,
                      mb: 3,
                    }}
                  >
                    <FavoriteIcon
                      sx={{
                        fontSize: 16,
                        color: c.accent.primary,
                        ...(result.status === 'loading' && {
                          '@keyframes pulse': {
                            '0%, 100%': { opacity: 0.4, transform: 'scale(0.8)' },
                            '50%': { opacity: 1, transform: 'scale(1.2)' },
                          },
                          animation: 'pulse 1.5s ease-in-out infinite',
                        }),
                      }}
                    />
                    <Typography
                      sx={{
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: c.text.secondary,
                        fontFamily: c.font.serif,
                      }}
                    >
                      Service Status
                    </Typography>
                  </Box>

                  <Button
                    onClick={pingHealth}
                    disabled={result.status === 'loading'}
                    variant="contained"
                    disableElevation
                    sx={{
                      bgcolor: c.accent.primary,
                      color: '#fff',
                      fontWeight: 500,
                      fontFamily: c.font.serif,
                      fontSize: '0.875rem',
                      borderRadius: `${c.radius.lg}px`,
                      px: 3,
                      py: 1,
                      textTransform: 'none',
                      transition: c.transition,
                      '&:hover': { bgcolor: c.accent.hover },
                      '&:active': {
                        bgcolor: c.accent.pressed,
                        transform: 'scale(0.98)',
                      },
                      '&.Mui-disabled': {
                        bgcolor: c.accent.primary,
                        opacity: 0.6,
                        color: '#fff',
                      },
                    }}
                  >
                    {result.status === 'loading' ? (
                      <CircularProgress size={18} sx={{ color: '#fff', mr: 1 }} />
                    ) : null}
                    {result.status === 'loading' ? 'Pinging...' : 'Ping Health'}
                  </Button>
                </Box>

                {result.status !== 'idle' && result.status !== 'loading' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    transition={{ duration: 0.25, ease: [0.165, 0.85, 0.45, 1] }}
                  >
                    <Box
                      sx={{
                        borderTop: `0.5px solid ${c.border.medium}`,
                        px: 3,
                        py: 2,
                        bgcolor: statusBg,
                      }}
                    >
                      <Typography
                        sx={{
                          fontSize: '0.8rem',
                          fontWeight: 500,
                          color: statusColor,
                          fontFamily: c.font.mono,
                          mb: 0.5,
                        }}
                      >
                        {result.status === 'ok' ? 'Healthy' : 'Unreachable'}
                      </Typography>
                      <Typography
                        sx={{
                          fontSize: '0.75rem',
                          color: c.text.muted,
                          fontFamily: c.font.mono,
                        }}
                      >
                        Response: {result.message}
                        {result.latencyMs !== null && ` · ${result.latencyMs}ms`}
                      </Typography>
                    </Box>
                  </motion.div>
                )}
              </>
            ) : (
              <Box sx={{ p: 3 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                    mb: 2,
                  }}
                >
                  <CloudOffIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                  <Typography
                    sx={{
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      color: c.text.secondary,
                      fontFamily: c.font.serif,
                    }}
                  >
                    No Backend Configured
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    fontSize: '0.75rem',
                    color: c.text.muted,
                    fontFamily: c.font.mono,
                  }}
                >
                  Initialize the backend and set
                  <br />
                  the BACKEND_PORT in .env.
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </motion.div>
    </Box>
  );
};

export default Health;
