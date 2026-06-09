import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { SendBlock } from '../hooks/useContextFiles';

interface Props {
  sendBlock: NonNullable<SendBlock>;
  c: ClaudeTokens;
}

/** Only hard-blocks render here. History compaction is shown as normal chat activity. */
export const SendBlockBanner: React.FC<Props> = ({ sendBlock, c }) => {
  if (sendBlock.kind !== 'too_long') return null;
  return (
    <Box sx={{
      mx: 1.5, mt: 1, mb: 0.5, px: 2, py: 1.25,
      borderRadius: '12px',
      bgcolor: c.bg.surface,
      border: `1px solid ${c.border.medium}`,
    }}>
      <Typography sx={{ fontSize: '0.88rem', color: c.text.primary, lineHeight: 1.45 }}>
        That message is too long to send. Try shortening it or splitting it into a few smaller ones.
      </Typography>
    </Box>
  );
};
