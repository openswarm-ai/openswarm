import React from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { KIND_LABELS, parseTags, type Listing } from '../catalog';
import { detailsForListing } from '../notionDetails';
import PackageDetails from './PackageDetails';
import PackageTagRow from './PackageTagRow';
import InstallPill from '../InstallPill';
import type { PillState } from '../installs';
import PackageVideoSection from './PackageVideoSection';

interface Props {
  listing: Listing | null;
  onClose: () => void;
  state: PillState;
  progress?: number | null;
  onInstall: () => void;
  onOpen: () => void;
}

// The package sheet: one Install action, no file to download. The bundle is fetched and reviewed by the
// same import path a dropped .swarm takes, so the raw archive has no job on a store page.
export default function PackageDialog({ listing, onClose, state, progress, onInstall, onOpen }: Props) {
  const c = useClaudeTokens();
  if (!listing) return null;
  const details = detailsForListing(listing);
  const meta = [
    KIND_LABELS[listing.kind] || listing.kind || 'Package',
    listing.version ? `v${listing.version}` : '',
    listing.author || '',
    listing.size || '',
    listing.updated_at ? `Updated ${listing.updated_at}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="md"
      scroll="paper"
      slotProps={{
        paper: { sx: { borderRadius: `${c.radius.xl}px`, m: 3, maxHeight: 'calc(100% - 48px)', bgcolor: c.bg.surface, backgroundImage: 'none', border: `${c.border.width} solid ${c.border.subtle}`, boxShadow: c.shadow.lg } },
        backdrop: { sx: { bgcolor: 'rgba(20, 20, 19, 0.35)' } },
      }}
    >
      <DialogContent sx={{ p: 0 }}>
        <IconButton onClick={onClose} aria-label="Close package details" size="small" sx={{ position: 'absolute', top: 12, right: 12, zIndex: 1, color: c.text.tertiary, bgcolor: c.bg.surface }}>
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
        <Box sx={{ px: 3, pt: 3, pb: 4 }}>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ pr: 4 }}>
            <Box sx={{ width: 56, height: 56, borderRadius: `${c.radius.lg}px`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: c.bg.secondary, overflow: 'hidden' }}>
              {listing.icon_url ? (
                <Box component="img" src={listing.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <ExtensionIcon sx={{ fontSize: 26, color: c.text.tertiary }} />
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: '1.25rem', lineHeight: 1.2, fontWeight: 650, letterSpacing: '-0.012em', color: c.text.primary }}>
                {listing.title}
              </Typography>
              <Typography sx={{ mt: 0.4, fontSize: '0.8125rem', color: c.text.muted }}>{meta}</Typography>
            </Box>
            <InstallPill state={state} progress={progress} disabled={!listing.download_url} onGet={onInstall} onOpen={onOpen} />
          </Stack>

          {listing.description && (
            <Typography sx={{ mt: 2, fontSize: '0.9rem', color: c.text.secondary, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {listing.description}
            </Typography>
          )}
          <PackageTagRow tags={parseTags(listing.tags)} sx={{ mt: 1.5 }} />

          <Box sx={{ mt: 3 }}>
            <PackageVideoSection key={listing.id} raw={listing.video_url} />
          </Box>
          {details && (
            <Box sx={{ mt: 3 }}>
              <PackageDetails doc={details} />
            </Box>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
