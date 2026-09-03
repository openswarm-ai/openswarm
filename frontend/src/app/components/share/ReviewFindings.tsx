import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ReviewSummary } from './shareTypes';

// The review's first line is the one that matters ("this app runs code on your computer"); the rest is one entry per flagged import, 94 of them on an ordinary FastAPI app, and used to land as a single 10,000-character paragraph.
const ReviewFindings: React.FC<{ review: ReviewSummary }> = ({ review }) => {
  const c = useClaudeTokens();
  const [open, setOpen] = useState(false);
  const [lead, ...rest] = review.findings;
  if (!lead) return null;
  const tone = review.verdict === 'block' ? c.status.error : c.status.warning;
  return (
    <Box sx={{ mt: 1.75 }}>
      <Box sx={{ display: 'flex', gap: 0.85, alignItems: 'flex-start' }}>
        <ShieldOutlinedIcon sx={{ fontSize: 15, color: tone, flexShrink: 0, mt: '1px' }} />
        <Typography sx={{ fontSize: '0.8125rem', color: c.text.secondary, lineHeight: 1.45 }}>{lead}</Typography>
      </Box>
      {rest.length > 0 && (
        <>
          <Box
            onClick={() => setOpen((v) => !v)}
            sx={{ mt: 0.75, ml: 3, display: 'inline-flex', alignItems: 'center', gap: 0.25, color: c.text.tertiary, cursor: 'pointer', '&:hover': { color: c.accent.primary } }}
          >
            <Typography sx={{ fontSize: '0.75rem' }}>{open ? 'Hide details' : `Details (${rest.length})`}</Typography>
            <KeyboardArrowDownIcon sx={{ fontSize: 14, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.18s' }} />
          </Box>
          {open && (
            <Box sx={{ mt: 0.5, ml: 3, maxHeight: 200, overflowY: 'auto', pr: 0.5 }}>
              {rest.map((f, i) => (
                <Typography key={i} sx={{ fontSize: '0.75rem', color: c.text.muted, lineHeight: 1.5, py: 0.15, fontFamily: c.font.mono, wordBreak: 'break-word' }}>
                  {f}
                </Typography>
              ))}
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

export default ReviewFindings;
