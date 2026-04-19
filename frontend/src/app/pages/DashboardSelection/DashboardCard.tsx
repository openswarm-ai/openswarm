import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import DashboardIcon from '@mui/icons-material/Dashboard';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Dashboard } from '@/shared/state/dashboardsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { formatRelativeTime } from '@/app/pages/Dashboard/_shared/formatRelativeTime';

interface DashboardCardProps {
  dashboard: Dashboard;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenameSubmit: () => void;
  onCancelRename: () => void;
  onOpenMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onClick: () => void;
}

const DashboardCard: React.FC<DashboardCardProps> = ({
  dashboard: d,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onCancelRename,
  onOpenMenu,
  onClick,
}) => {
  const c = useClaudeTokens();

  return (
    <Box
      onClick={() => {
        if (!isRenaming) onClick();
      }}
      sx={{
        cursor: isRenaming ? 'default' : 'pointer',
        borderRadius: 3,
        border: `1px solid ${c.border.subtle}`,
        bgcolor: c.bg.surface,
        overflow: 'hidden',
        transition: 'all 0.2s ease',
        '&:hover': {
          borderColor: c.border.strong,
          boxShadow: c.shadow.md,
          transform: 'translateY(-2px)',
        },
        '&:hover .card-actions': { opacity: 1 },
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        sx={{
          height: 120,
          bgcolor: c.accent.primary + '12',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {d.thumbnail ? (
          <Box
            component="img"
            src={d.thumbnail}
            alt={`${d.name} preview`}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'top left',
            }}
          />
        ) : (
          <DashboardIcon
            sx={{ fontSize: 48, color: c.accent.primary, opacity: 0.5 }}
          />
        )}
        <Box
          className="card-actions"
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            gap: 0.5,
            opacity: 0,
            transition: 'opacity 0.15s',
          }}
        >
          <Tooltip title="More actions">
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMenu(e);
              }}
              sx={{
                bgcolor: c.bg.surface,
                color: c.text.muted,
                boxShadow: c.shadow.sm,
                '&:hover': { bgcolor: c.bg.elevated },
              }}
            >
              <MoreVertIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box sx={{ p: 2, flex: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {isRenaming ? (
          <TextField
            autoFocus
            size="small"
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameSubmit();
              if (e.key === 'Escape') onCancelRename();
            }}
            onClick={(e) => e.stopPropagation()}
            sx={{
              '& .MuiOutlinedInput-root': {
                fontSize: '0.95rem',
                fontWeight: 600,
              },
            }}
          />
        ) : (
          <Typography
            sx={{
              fontSize: '0.95rem',
              fontWeight: 600,
              color: c.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {d.name}
          </Typography>
        )}
        <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>
          Updated {formatRelativeTime(d.updated_at)}
        </Typography>
      </Box>
    </Box>
  );
};

export default DashboardCard;
