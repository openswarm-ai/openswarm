import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { parseTags, KIND_LABELS, type Listing } from './catalog';

interface Props {
  listing: Listing;
  onOpen: () => void;
  onTag: (tag: string) => void;
}

export default function PackageCard({ listing, onOpen, onTag }: Props) {
  const c = useClaudeTokens();
  const tags = parseTags(listing.tags).slice(0, 3);

  return (
    <Box
      onClick={onOpen}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: 3,
        p: 2.5,
        transition: c.transition,
        '&:hover': {
          borderColor: c.border.medium,
          boxShadow: c.shadow.md,
          transform: 'translateY(-2px)',
        },
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
        <Box
          sx={{
            width: 44,
            height: 44,
            borderRadius: 2,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: `${c.accent.primary}14`,
            overflow: 'hidden',
          }}
        >
          {listing.icon_url ? (
            <Box component="img" src={listing.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <ExtensionIcon sx={{ fontSize: 22, color: c.accent.primary }} />
          )}
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: '1rem',
              fontWeight: 620,
              color: c.text.primary,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {listing.title}
          </Typography>
          <Typography sx={{ fontSize: '0.78rem', color: c.text.muted }}>
            {KIND_LABELS[listing.kind] || listing.kind || 'Package'}
            {listing.version ? ` · v${listing.version}` : ''}
          </Typography>
        </Box>
      </Stack>

      <Typography
        sx={{
          fontSize: '0.875rem',
          color: c.text.secondary,
          lineHeight: 1.5,
          mb: 1.75,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: '2.6em',
        }}
      >
        {listing.description || 'No description provided.'}
      </Typography>

      <Stack direction="row" spacing={0.75} sx={{ mt: 'auto', flexWrap: 'wrap', gap: 0.75 }}>
        {tags.map((t) => (
          <Chip
            key={t}
            label={`#${t}`}
            size="small"
            onClick={(e: React.MouseEvent<HTMLDivElement>) => {
              e.stopPropagation();
              onTag(t);
            }}
            sx={{
              height: 22,
              fontSize: '0.72rem',
              bgcolor: c.bg.secondary,
              color: c.text.tertiary,
              '&:hover': { color: c.text.primary },
            }}
          />
        ))}
      </Stack>
    </Box>
  );
}
