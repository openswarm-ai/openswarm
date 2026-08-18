import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';

// "Resume Agent Response" pill shown after a stopped turn. Presentational; the caller owns when it shows.
export function ResumeAgentButton({ onResume, c }: { onResume: () => void; c: ReturnType<typeof useClaudeTokens> }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start', my: 0.75 }}>
      <Box
        onClick={onResume}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.5,
          py: 0.75,
          borderRadius: '12px',
          cursor: 'pointer',
          bgcolor: `${c.accent.primary}10`,
          border: `1px solid ${c.accent.primary}30`,
          transition: 'all 0.15s',
          '&:hover': {
            bgcolor: `${c.accent.primary}1a`,
            border: `1px solid ${c.accent.primary}50`,
          },
        }}
      >
        <PlayArrowIcon sx={{ fontSize: 14, color: c.accent.primary }} />
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: c.accent.primary }}>
          Resume Agent Response
        </Typography>
      </Box>
    </Box>
  );
}
