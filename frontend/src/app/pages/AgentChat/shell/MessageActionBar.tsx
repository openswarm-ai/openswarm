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
import ThumbUpOffAltIcon from '@mui/icons-material/ThumbUpOffAlt';
import ThumbUpAltIcon from '@mui/icons-material/ThumbUpAlt';
import ThumbDownOffAltIcon from '@mui/icons-material/ThumbDownOffAlt';
import ThumbDownAltIcon from '@mui/icons-material/ThumbDownAlt';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import FeedbackDialog, { Sentiment } from './FeedbackDialog';

interface BranchNavProps {
  currentIndex: number;
  totalBranches: number;
  disabled?: boolean;
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
  sessionId?: string;
  messageId?: string;
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
  sessionId,
  messageId,
}) => {
  const c = useClaudeTokens();
  const [copied, setCopied] = useState(false);
  const [dialogSentiment, setDialogSentiment] = useState<Sentiment | null>(null);
  const [submitted, setSubmitted] = useState<Sentiment | null>(null);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUser = role === 'user';
  const canRate = !isUser && !!sessionId && !!messageId;

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
                disabled={branchNav.disabled || branchNav.currentIndex === 0}
                sx={btnSx(c)}
              >
                <ChevronLeftIcon sx={{ fontSize: 16 }} />
              </IconButton>
              <Typography
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.6875rem',
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
                disabled={branchNav.disabled || branchNav.currentIndex === branchNav.totalBranches - 1}
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
          {canRate && (
            <>
              <Tooltip title="Give positive feedback" arrow>
                <IconButton size="small" onClick={() => setDialogSentiment('up')} sx={btnSx(c)}>
                  {submitted === 'up'
                    ? <ThumbUpAltIcon sx={{ fontSize: 16, color: c.accent.primary }} />
                    : <ThumbUpOffAltIcon sx={{ fontSize: 16 }} />}
                </IconButton>
              </Tooltip>
              <Tooltip title="Give negative feedback" arrow>
                <IconButton size="small" onClick={() => setDialogSentiment('down')} sx={btnSx(c)}>
                  {submitted === 'down'
                    ? <ThumbDownAltIcon sx={{ fontSize: 16, color: c.accent.primary }} />
                    : <ThumbDownOffAltIcon sx={{ fontSize: 16 }} />}
                </IconButton>
              </Tooltip>
            </>
          )}
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
      {canRate && dialogSentiment && (
        <FeedbackDialog
          open
          sentiment={dialogSentiment}
          sessionId={sessionId!}
          messageId={messageId!}
          onClose={() => setDialogSentiment(null)}
          onSubmitted={() => { setSubmitted(dialogSentiment); setDialogSentiment(null); }}
        />
      )}
    </Box>
  );
};

// Callbacks are per-message inline arrows; compare by presence + branch-nav primitives since closures are msg-id-keyed.
export default React.memo(MessageActionBar, (prev, next) => (
  prev.role === next.role
  && !!prev.onCopy === !!next.onCopy
  && !!prev.onEdit === !!next.onEdit
  && !!prev.onRegenerate === !!next.onRegenerate
  && !!prev.onBranch === !!next.onBranch
  && prev.branchNav?.currentIndex === next.branchNav?.currentIndex
  && prev.branchNav?.totalBranches === next.branchNav?.totalBranches
  && prev.branchNav?.disabled === next.branchNav?.disabled
  && prev.messageId === next.messageId
  && prev.sessionId === next.sessionId
));
