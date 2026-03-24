import React, { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import EditIcon from '@mui/icons-material/Edit';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import ReplayIcon from '@mui/icons-material/Replay';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface BranchNavProps {
  currentIndex: number;
  totalBranches: number;
  onPrevious: () => void;
  onNext: () => void;
}

interface Props {
  role: 'user' | 'assistant';
  onCopy: () => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onBranch?: () => void;
  branchNav?: BranchNavProps;
}

const btnSx = (c: ReturnType<typeof useClaudeTokens>) => ({
  color: c.text.tertiary,
  p: 0.4,
  '&:hover': { color: c.text.secondary, bgcolor: 'transparent' },
  '&.Mui-disabled': { color: c.border.medium },
});

const MessageActionBar: React.FC<Props> = ({
  role,
  onCopy,
  onEdit,
  onRegenerate,
  onBranch,
  branchNav,
}) => {
  const c = useClaudeTokens();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUser = role === 'user';

  return (
    <Box
      className="msg-actions"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        gap: 0,
        opacity: 0,
        transition: 'opacity 0.15s',
        mt: -0.25,
        mb: 0.25,
        minHeight: 28,
      }}
    >
      {isUser ? (
        <>
          <Tooltip title="Coming soon" arrow>
            <span>
              <IconButton size="small" disabled sx={btnSx(c)}>
                <BookmarkBorderIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={copied ? 'Copied!' : 'Copy'} arrow>
            <IconButton size="small" onClick={handleCopy} sx={btnSx(c)}>
              {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
          {onEdit && (
            <Tooltip title="Edit" arrow>
              <IconButton size="small" onClick={onEdit} sx={btnSx(c)}>
                <EditIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          {branchNav && branchNav.totalBranches > 1 && (
            <Box sx={{ display: 'inline-flex', alignItems: 'center', ml: 0.25 }}>
              <IconButton
                size="small"
                onClick={branchNav.onPrevious}
                disabled={branchNav.currentIndex === 0}
                sx={btnSx(c)}
              >
                <ChevronLeftIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <Typography
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.7rem',
                  minWidth: 28,
                  textAlign: 'center',
                  userSelect: 'none',
                }}
              >
                {branchNav.currentIndex + 1} / {branchNav.totalBranches}
              </Typography>
              <IconButton
                size="small"
                onClick={branchNav.onNext}
                disabled={branchNav.currentIndex === branchNav.totalBranches - 1}
                sx={btnSx(c)}
              >
                <ChevronRightIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Box>
          )}
        </>
      ) : (
        <>
          <Tooltip title={copied ? 'Copied!' : 'Copy'} arrow>
            <IconButton size="small" onClick={handleCopy} sx={btnSx(c)}>
              {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
          {onRegenerate && (
            <Tooltip title="Regenerate" arrow>
              <IconButton size="small" onClick={onRegenerate} sx={btnSx(c)}>
                <ReplayIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          {onBranch && (
            <Tooltip title="Branch chat" arrow>
              <IconButton size="small" onClick={onBranch} sx={btnSx(c)}>
                <CallSplitIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
        </>
      )}
    </Box>
  );
};

export default MessageActionBar;
