import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface ChatHeaderProps {
  session: {
    name: string;
    status: string;
    model: string;
    branch_name: string | null;
    cost_usd: number;
    id: string;
  };
  isDraft: boolean;
  onClose?: () => void;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({ session, isDraft, onClose }) => {
  const c = useClaudeTokens();
  const STATUS_STYLES: Record<string, { color: string; bg: string }> = {
    running: { color: c.status.success, bg: c.status.successBg },
    waiting_approval: { color: c.status.warning, bg: c.status.warningBg },
    completed: { color: c.text.tertiary, bg: c.bg.secondary },
    error: { color: c.status.error, bg: c.status.errorBg },
    stopped: { color: c.text.tertiary, bg: c.bg.secondary },
  };
  const statusStyle = STATUS_STYLES[session.status] || { color: c.text.tertiary, bg: c.bg.secondary };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.5,
        borderBottom: `0.5px solid ${c.border.medium}`,
        bgcolor: c.bg.surface,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography noWrap sx={{ color: c.text.primary, fontWeight: 600 }}>{session.name}</Typography>
          {!isDraft && (
            <Chip
              label={session.status.replace('_', ' ')}
              size="small"
              sx={{
                bgcolor: statusStyle.bg,
                color: statusStyle.color,
                fontWeight: 600,
                fontSize: '0.7rem',
                height: 20,
              }}
            />
          )}
        </Box>
        {!isDraft && (
          <Box sx={{ display: 'flex', gap: 1.5, mt: 0.25 }}>
            <Typography variant="caption" sx={{ color: c.text.tertiary }}>{session.model}</Typography>
            <Typography variant="caption" sx={{ color: c.text.tertiary }}>{session.branch_name}</Typography>
            {session.cost_usd > 0 && (
              <Typography variant="caption" sx={{ color: c.accent.primary }}>
                ${session.cost_usd.toFixed(4)}
              </Typography>
            )}
          </Box>
        )}
      </Box>
      {onClose && (
        <IconButton onClick={onClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
};

export default ChatHeader;
