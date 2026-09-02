import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { KIND_LABELS, parseTags, type Listing } from '../catalog';
import { detailsForListing } from '../notionDetails';
import PackageDetails from './PackageDetails';
import PackageVideoSection from './PackageVideoSection';

interface Props {
  listing: Listing | null;
  onClose: () => void;
  onInstall: () => void;
  installing: boolean;
  installed?: boolean;
}

export default function PackageDialog({ listing, onClose, onInstall, installing, installed }: Props) {
  const c = useClaudeTokens();
  if (!listing) return null;

  const details = detailsForListing(listing);
  const tags = parseTags(listing.tags);

  const subMeta = [
    KIND_LABELS[listing.kind] || listing.kind || 'Package',
    listing.version ? `v${listing.version}` : '',
    listing.author || '',
    listing.size || '',
    listing.updated_at ? `Updated ${listing.updated_at}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="md"
      scroll="paper"
      slotProps={{
        paper: {
          sx: {
            borderRadius: { xs: 0, sm: 4 },
            m: { xs: 0, sm: 3 },
            maxHeight: { xs: '100%', sm: 'calc(100% - 48px)' },
            bgcolor: c.bg.surface,
            backgroundImage: 'none',
            boxShadow: c.shadow.lg,
          },
        },
        backdrop: { sx: { bgcolor: 'rgba(29, 29, 31, 0.42)', backdropFilter: 'blur(6px)' } },
      }}
    >
      <DialogContent sx={{ p: 0 }}>
        <Box sx={{ position: 'sticky', top: 0, zIndex: 1, bgcolor: c.bg.surface, px: { xs: 2.5, sm: 4 }, py: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.muted }}>
              Marketplace package
            </Typography>
            <IconButton onClick={onClose} aria-label="Close package details" sx={{ color: c.text.tertiary }}>
              <CloseIcon />
            </IconButton>
          </Stack>
        </Box>

        <Box sx={{ px: { xs: 2.5, sm: 5 }, pb: { xs: 4, sm: 5 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ mb: 2.5 }}>
            <Box sx={{ width: 76, height: 76, borderRadius: 3, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: `${c.accent.primary}14`, overflow: 'hidden' }}>
              {listing.icon_url ? (
                <Box component="img" src={listing.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <ExtensionIcon sx={{ fontSize: 34, color: c.accent.primary }} />
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: { xs: '1.65rem', sm: '2rem' }, lineHeight: 1.15, fontWeight: 700, letterSpacing: '-0.03em', color: c.text.primary }}>
                {listing.title}
              </Typography>
              <Typography sx={{ mt: 0.75, color: c.text.tertiary, fontSize: '0.9rem' }}>{subMeta}</Typography>
              {tags.length > 0 && (
                <Stack direction="row" sx={{ mt: 1.25, flexWrap: 'wrap', gap: 0.75 }}>
                  {tags.map((tag) => (
                    <Chip key={tag} label={`#${tag}`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.tertiary }} />
                  ))}
                </Stack>
              )}
            </Box>
            <Stack spacing={0.75} alignItems={{ xs: 'flex-start', sm: 'flex-end' }} sx={{ flexShrink: 0 }}>
              <Button
                onClick={onInstall}
                variant="contained"
                disableElevation
                disabled={installing || !!installed || !listing.download_url}
                startIcon={
                  installing ? (
                    <CircularProgress size={16} thickness={5} sx={{ color: 'inherit' }} />
                  ) : installed ? (
                    <CheckRoundedIcon />
                  ) : (
                    <DownloadIcon />
                  )
                }
                sx={{
                  borderRadius: 999,
                  px: 3,
                  py: 1.15,
                  whiteSpace: 'nowrap',
                  textTransform: 'none',
                  fontWeight: 600,
                  bgcolor: c.accent.primary,
                  '&:hover': { bgcolor: c.accent.hover },
                }}
              >
                {installed ? 'Installed' : 'Install'}
              </Button>
              {listing.download_url && (
                <Link
                  href={listing.download_url}
                  download
                  rel="noopener"
                  sx={{ fontSize: '0.78rem', color: c.text.muted, textDecorationColor: c.border.medium, '&:hover': { color: c.text.primary } }}
                >
                  Download .swarm file
                </Link>
              )}
            </Stack>
          </Stack>

          {listing.description && (
            <Typography sx={{ fontSize: '0.98rem', color: c.text.secondary, lineHeight: 1.7, whiteSpace: 'pre-wrap', mb: 3 }}>
              {listing.description}
            </Typography>
          )}

          <PackageVideoSection key={listing.id} raw={listing.video_url} />

          {details && (
            <Box sx={{ mt: 4 }}>
              <PackageDetails doc={details} />
            </Box>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
