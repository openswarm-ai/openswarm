import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExtensionIcon from '@mui/icons-material/Extension';
import Inventory2Icon from '@mui/icons-material/Inventory2Outlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { type Listing } from './catalog';

interface Props {
  bundle: Listing;
  members: Listing[];
  onOpen: () => void;
}

// A collection is one wide row, not a card in the package grid: it groups the things below it, and a
// half-width card with empty space beside it reads as a layout that broke rather than a section.
export default function PackageBundleCard({ bundle, members, onOpen }: Props) {
  const c = useClaudeTokens();
  const preview = members.slice(0, 4);
  const names = members.map((m) => m.title).filter(Boolean);

  return (
    <Box
      onClick={onOpen}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        cursor: 'pointer',
        bgcolor: c.bg.surface,
        border: `${c.border.width} solid ${c.border.subtle}`,
        borderRadius: `${c.radius.lg}px`,
        px: 2,
        py: 1.75,
        transition: c.transition,
        '&:hover': { borderColor: c.border.strong, boxShadow: c.shadow.sm },
      }}
    >
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
        {bundle.icon_url ? (
          <Box component="img" src={bundle.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Inventory2Icon sx={{ fontSize: 20, color: c.text.tertiary }} />
        )}
      </Box>

      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
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
            {bundle.title}
          </Typography>
          <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, flexShrink: 0 }}>
            {members.length} {members.length === 1 ? 'package' : 'packages'}
          </Typography>
        </Stack>
        <Typography
          sx={{
            fontSize: '0.8125rem',
            color: c.text.tertiary,
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {bundle.description || names.join(', ') || 'A curated collection of packages.'}
        </Typography>
      </Box>

      <Stack direction="row" sx={{ alignItems: 'center', flexShrink: 0 }}>
        {preview.map((m, i) => (
          <Box
            key={m.id}
            title={m.title}
            sx={{
              width: 28,
              height: 28,
              borderRadius: `${c.radius.sm}px`,
              flexShrink: 0,
              ml: i === 0 ? 0 : '-7px',
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
              <ExtensionIcon sx={{ fontSize: 14, color: c.text.muted }} />
            )}
          </Box>
        ))}
        {members.length > preview.length && (
          <Typography sx={{ ml: 1, fontSize: '0.75rem', color: c.text.muted }}>
            +{members.length - preview.length}
          </Typography>
        )}
      </Stack>

      <ChevronRightIcon sx={{ fontSize: 18, color: c.text.ghost, flexShrink: 0 }} />
    </Box>
  );
}
