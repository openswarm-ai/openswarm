import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { parseTags, KIND_LABELS, type Listing } from './catalog';
import PackageTagRow from './detail/PackageTagRow';
import InstallPill from './InstallPill';
import type { PillState } from './installs';

interface Props {
  listing: Listing;
  state: PillState;
  onOpen: () => void;
  onGet: () => void;
  onOpenInstalled: () => void;
  onTag: (tag: string) => void;
}

export default function PackageCard({ listing, state, onOpen, onGet, onOpenInstalled, onTag }: Props) {
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
        border: `${c.border.width} solid ${c.border.subtle}`,
        borderRadius: `${c.radius.lg}px`,
        p: 2,
        transition: c.transition,
        // No lift on hover: every other surface in this app answers with the border and a hairline shadow, and a card that jumps reads cheap next to them.
        '&:hover': { borderColor: c.border.strong, boxShadow: c.shadow.sm },
      }}
    >
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1.25 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: `${c.radius.md}px`,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: c.bg.secondary,
            overflow: 'hidden',
          }}
        >
          {listing.icon_url ? (
            <Box component="img" src={listing.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <ExtensionIcon sx={{ fontSize: 20, color: c.text.tertiary }} />
          )}
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: '0.9375rem',
              fontWeight: 650,
              color: c.text.primary,
              letterSpacing: '-0.006em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {listing.title}
          </Typography>
          <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mt: 0.1 }}>
            {KIND_LABELS[listing.kind] || listing.kind || 'Package'}
            {listing.version ? ` · v${listing.version}` : ''}
            {listing.author ? ` · ${listing.author}` : ''}
          </Typography>
        </Box>
        <InstallPill state={state} disabled={!listing.download_url} onGet={onGet} onOpen={onOpenInstalled} size="sm" />
      </Stack>

      <Typography
        sx={{
          fontSize: '0.8438rem',
          color: c.text.tertiary,
          lineHeight: 1.55,
          mb: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          // Fixed two lines so every card in a row ends its body at the same baseline.
          minHeight: '2.6em',
        }}
      >
        {listing.description || 'No description provided.'}
      </Typography>

      <PackageTagRow tags={tags} onTag={onTag} sx={{ mt: 'auto' }} />
    </Box>
  );
}
