import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import type { SxProps, Theme } from '@mui/material/styles';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  tags: string[];
  onTag?: (tag: string) => void;
  sx?: SxProps<Theme>;
}

// One tag treatment for the card, the package sheet and the bundle sheet, so the three cannot drift apart.
export default function PackageTagRow({ tags, onTag, sx }: Props) {
  const c = useClaudeTokens();
  if (tags.length === 0) return null;
  return (
    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, ...(sx as object) }}>
      {tags.map((t) => (
        <Box
          key={t}
          role={onTag ? 'button' : undefined}
          onClick={onTag ? (e: React.MouseEvent) => { e.stopPropagation(); onTag(t); } : undefined}
          sx={{
            px: 0.9,
            py: 0.2,
            borderRadius: `${c.radius.sm}px`,
            border: `${c.border.width} solid ${c.border.subtle}`,
            fontSize: '0.7188rem',
            color: c.text.muted,
            transition: c.transition,
            ...(onTag ? { cursor: 'pointer', '&:hover': { color: c.text.secondary, borderColor: c.border.medium } } : {}),
          }}
        >
          {t}
        </Box>
      ))}
    </Stack>
  );
}
