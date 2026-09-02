import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { KIND_LABELS, type Listing } from './catalog';

interface Props {
  bundle: Listing;
  members: Listing[];
  onOpen: () => void;
}

// Leads with a stacked-icon motif of its first few members and a count, so a bundle reads as a collection at a glance rather than as another single package.
export default function PackageBundleCard({ bundle, members, onOpen }: Props) {
  const c = useClaudeTokens();
  const preview = members.slice(0, 4);
  const kinds = Array.from(new Set(members.map((m) => KIND_LABELS[m.kind] || m.kind).filter(Boolean)));

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
        position: 'relative',
        overflow: 'hidden',
        '&:hover': {
          borderColor: c.accent.primary,
          boxShadow: c.shadow.md,
          transform: 'translateY(-2px)',
        },
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: 2.5,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: `${c.accent.primary}1A`,
            overflow: 'hidden',
          }}
        >
          {bundle.icon_url ? (
            <Box component="img" src={bundle.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Inventory2Icon sx={{ fontSize: 24, color: c.accent.primary }} />
          )}
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            sx={{
              fontSize: '1.05rem',
              fontWeight: 660,
              color: c.text.primary,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {bundle.title}
          </Typography>
          <Typography sx={{ fontSize: '0.78rem', color: c.accent.primary, fontWeight: 600 }}>
            Bundle · {members.length} {members.length === 1 ? 'package' : 'packages'}
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
        {bundle.description || 'A curated collection of packages.'}
      </Typography>

      <Stack direction="row" spacing={-0.75} sx={{ mt: 'auto', alignItems: 'center' }}>
        {preview.map((m, i) => (
          <Box
            key={m.id}
            sx={{
              width: 30,
              height: 30,
              borderRadius: 1.5,
              flexShrink: 0,
              ml: i === 0 ? 0 : '-8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: c.bg.secondary,
              border: `2px solid ${c.bg.surface}`,
              overflow: 'hidden',
              zIndex: preview.length - i,
            }}
          >
            {m.icon_url ? (
              <Box component="img" src={m.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <ExtensionIcon sx={{ fontSize: 15, color: c.text.muted }} />
            )}
          </Box>
        ))}
        {members.length > preview.length && (
          <Typography sx={{ ml: 1, fontSize: '0.78rem', color: c.text.muted }}>
            +{members.length - preview.length} more
          </Typography>
        )}
        {kinds.length > 0 && (
          <Chip
            label={kinds.slice(0, 2).join(' · ')}
            size="small"
            sx={{
              ml: 'auto',
              height: 22,
              fontSize: '0.72rem',
              bgcolor: c.bg.secondary,
              color: c.text.tertiary,
            }}
          />
        )}
      </Stack>
    </Box>
  );
}
