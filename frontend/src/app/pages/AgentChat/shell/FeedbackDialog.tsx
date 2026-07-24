import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { report } from '@/shared/serviceClient';

export type Sentiment = 'up' | 'down';

interface Props {
  open: boolean;
  sentiment: Sentiment;
  sessionId: string;
  messageId: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const FeedbackDialog: React.FC<Props> = ({ open, sentiment, sessionId, messageId, onClose, onSubmitted }) => {
  const c = useClaudeTokens();
  const [comment, setComment] = useState('');

  const isUp = sentiment === 'up';

  const handleSubmit = () => {
    // Rides the same analytics channel as everything else (batches + offline spools to the cloud). Fire-and-forget, so the dialog closes instantly.
    report('feedback', sentiment, { message_id: messageId, session_id: sessionId, comment: comment.trim() }, { immediate: true });
    setComment('');
    onSubmitted();
  };

  const handleClose = () => {
    setComment('');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      PaperProps={{ sx: { bgcolor: c.bg.elevated, borderRadius: 3, p: 1, minWidth: 420, maxWidth: 480 } }}
    >
      <Box sx={{ p: 2 }}>
        <Typography sx={{ color: c.text.primary, fontSize: '1.125rem', fontWeight: 600, mb: 2 }}>
          {isUp ? 'Give positive feedback' : 'Give negative feedback'}
        </Typography>

        <Typography sx={{ color: c.text.secondary, fontSize: '0.875rem', mb: 1 }}>
          Please provide details: (optional)
        </Typography>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={isUp ? 'What was good about this response?' : 'What went wrong with this response?'}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: c.bg.page,
              color: c.text.primary,
              fontSize: '0.875rem',
              '& fieldset': { borderColor: c.border.medium },
              '&:hover fieldset': { borderColor: c.border.strong },
              '&.Mui-focused fieldset': { borderColor: c.accent.primary },
            },
            '& textarea::placeholder': { color: c.text.tertiary, opacity: 1 },
          }}
        />

        <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem', fontStyle: 'italic', mt: 1.5 }}>
          Shared with OpenSwarm to help improve your agents. We send your rating and note, not your conversation.
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>
          <Button onClick={handleClose} sx={{ color: c.text.secondary, textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            variant="contained"
            sx={{
              bgcolor: c.text.primary,
              color: c.bg.page,
              textTransform: 'none',
              fontWeight: 600,
              '&:hover': { bgcolor: c.text.secondary },
            }}
          >
            Submit
          </Button>
        </Box>
      </Box>
    </Dialog>
  );
};

export default FeedbackDialog;
