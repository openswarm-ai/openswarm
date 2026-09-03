import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ExtensionIcon from '@mui/icons-material/Extension';
import Inventory2Icon from '@mui/icons-material/Inventory2Outlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { KIND_LABELS, parseTags, type Listing } from '../catalog';
import PackageTagRow from './PackageTagRow';
import InstallPill from '../InstallPill';
import type { PillState } from '../installs';

interface Props {
  bundle: Listing | null;
  members: Listing[];
  stateOf: (listingId: string) => PillState;
  onOpenInstalled: (listing: Listing) => void;
  onClose: () => void;
  onOpenMember: (member: Listing) => void;
  onInstallAll: () => void;
  onInstallMember: (id: string) => void;
  installing: boolean;
}

// A bundle has no package of its own: the sheet lists it, the dialog installs its members. There is no
// file to download here on purpose; a store page installs, it does not hand out archives.
export default function PackageBundleDialog({ bundle, members, stateOf, onOpenInstalled, onClose, onOpenMember, onInstallAll, onInstallMember, installing }: Props) {
  const c = useClaudeTokens();
  if (!bundle) return null;
  const installable = members.filter((m) => m.download_url);
  const allInstalled = installable.length > 0 && installable.every((m) => stateOf(m.id) !== 'get');
  const pill = { borderRadius: `${c.radius.full}px`, textTransform: 'none' as const, fontWeight: 600, fontSize: '0.8125rem', px: 2, py: 0.6, minWidth: 0, whiteSpace: 'nowrap' as const };

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      scroll="paper"
      slotProps={{
        paper: { sx: { borderRadius: `${c.radius.xl}px`, m: 3, maxHeight: 'calc(100% - 48px)', bgcolor: c.bg.surface, backgroundImage: 'none', border: `${c.border.width} solid ${c.border.subtle}`, boxShadow: c.shadow.lg } },
        backdrop: { sx: { bgcolor: 'rgba(20, 20, 19, 0.35)' } },
      }}
    >
      <DialogContent sx={{ p: 0 }}>
        <IconButton onClick={onClose} aria-label="Close bundle details" size="small" sx={{ position: 'absolute', top: 12, right: 12, color: c.text.tertiary }}>
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
        <Box sx={{ px: 3, pt: 3, pb: 3 }}>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ pr: 4 }}>
            <Box sx={{ width: 56, height: 56, borderRadius: `${c.radius.lg}px`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: c.bg.secondary, overflow: 'hidden' }}>
              {bundle.icon_url ? (
                <Box component="img" src={bundle.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <Inventory2Icon sx={{ fontSize: 26, color: c.text.tertiary }} />
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: '1.25rem', lineHeight: 1.2, fontWeight: 650, letterSpacing: '-0.012em', color: c.text.primary }}>
                {bundle.title}
              </Typography>
              <Typography sx={{ mt: 0.4, fontSize: '0.8125rem', color: c.text.muted }}>
                {members.length} {members.length === 1 ? 'item' : 'items'}{bundle.author ? ` · ${bundle.author}` : ''}
              </Typography>
            </Box>
            <Button
              onClick={onInstallAll}
              disabled={installing || installable.length === 0 || allInstalled}
              variant="contained"
              disableElevation
              sx={{ ...pill, bgcolor: c.accent.primary, color: c.text.inverse, '&:hover': { bgcolor: c.accent.hover }, '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.muted } }}
            >
              {installing ? <CircularProgress size={14} thickness={5} sx={{ color: 'inherit' }} /> : allInstalled ? 'Installed' : 'Install all'}
            </Button>
          </Stack>

          {bundle.description && (
            <Typography sx={{ mt: 2, fontSize: '0.9rem', color: c.text.secondary, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {bundle.description}
            </Typography>
          )}
          <PackageTagRow tags={parseTags(bundle.tags)} sx={{ mt: 1.5 }} />

          <Typography sx={{ mt: 3, mb: 1, fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, letterSpacing: '0.01em' }}>
            Included
          </Typography>
          {members.length === 0 ? (
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.875rem' }}>The items in this bundle are no longer available.</Typography>
          ) : (
            <Stack spacing={0.75}>
              {members.map((m) => {
                return (
                  <Box
                    key={m.id}
                    onClick={() => onOpenMember(m)}
                    role="button"
                    sx={{ display: 'flex', alignItems: 'center', gap: 1.5, cursor: 'pointer', border: `${c.border.width} solid ${c.border.subtle}`, borderRadius: `${c.radius.lg}px`, px: 1.5, py: 1.25, transition: c.transition, '&:hover': { borderColor: c.border.strong, boxShadow: c.shadow.sm } }}
                  >
                    <Box sx={{ width: 40, height: 40, borderRadius: `${c.radius.md}px`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: c.bg.secondary, overflow: 'hidden' }}>
                      {m.icon_url ? (
                        <Box component="img" src={m.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <ExtensionIcon sx={{ fontSize: 20, color: c.text.tertiary }} />
                      )}
                    </Box>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</Typography>
                      <Typography sx={{ fontSize: '0.75rem', color: c.text.muted }}>
                        {KIND_LABELS[m.kind] || m.kind || 'Package'}{m.version ? ` · v${m.version}` : ''}
                      </Typography>
                    </Box>
                    <InstallPill state={stateOf(m.id)} disabled={!m.download_url} onGet={() => onInstallMember(m.id)} onOpen={() => onOpenInstalled(m)} size="sm" />
                  </Box>
                );
              })}
            </Stack>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
