import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Icon from '@mui/material/Icon';
import { Output } from '@/shared/state/outputsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  output: Output;
  onClick: () => void;
  onDelete: () => void;
  onRun: () => void;
}

const ViewCard: React.FC<Props> = ({ output, onClick, onDelete, onRun }) => {
  const c = useClaudeTokens();

  return (
    <Box
      onClick={onClick}
      sx={{
        cursor: 'pointer',
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
          height: 160,
          bgcolor: c.accent.primary + '18',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {output.thumbnail ? (
          <Box
            component="img"
            src={output.thumbnail}
            alt={`${output.name} preview`}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'top left',
            }}
          />
        ) : (
          <Icon
            sx={{
              fontSize: 48,
              color: c.accent.primary,
              opacity: 0.7,
            }}
          >
            {output.icon}
          </Icon>
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
          <Tooltip title="Run">
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onRun(); }}
              sx={{
                bgcolor: c.bg.surface,
                color: c.accent.primary,
                boxShadow: c.shadow.sm,
                '&:hover': { bgcolor: c.bg.elevated },
              }}
            >
              <PlayArrowIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              sx={{
                bgcolor: c.bg.surface,
                color: c.status.error,
                boxShadow: c.shadow.sm,
                '&:hover': { bgcolor: c.bg.elevated },
              }}
            >
              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box sx={{ p: 2, flex: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
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
          {output.name}
        </Typography>
        <Typography
          sx={{
            fontSize: '0.8rem',
            color: c.text.muted,
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minHeight: '2.2em',
          }}
        >
          {output.description || 'No description'}
        </Typography>
      </Box>
    </Box>
  );
};

export default ViewCard;
