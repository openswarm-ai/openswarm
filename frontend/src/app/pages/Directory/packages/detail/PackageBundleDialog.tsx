import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import ExtensionIcon from '@mui/icons-material/Extension';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { KIND_LABELS, parseTags, type Listing } from '../catalog';

interface Props {
  bundle: Listing | null;
  members: Listing[];
  onClose: () => void;
  onOpenMember: (member: Listing) => void;
  onInstallAll: () => void;
  onInstallMember: (id: string) => void;
  installing: boolean;
}

// A bundle has no .swarm of its own, so the dialog installs every member at once and lists each one with its own install button and a click-through to its full detail.
export default function PackageBundleDialog({
  bundle,
  members,
  onClose,
  onOpenMember,
  onInstallAll,
  onInstallMember,
  installing,
}: Props) {
  const c = useClaudeTokens();
  if (!bundle) return null;

  const installable = members.filter((m) => m.download_url);
  const tags = parseTags(bundle.tags);

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
            <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.accent.primary }}>
              Marketplace bundle
            </Typography>
            <IconButton onClick={onClose} aria-label="Close bundle details" sx={{ color: c.text.tertiary }}>
              <CloseIcon />
            </IconButton>
          </Stack>
        </Box>

        <Box sx={{ px: { xs: 2.5, sm: 5 }, pb: { xs: 4, sm: 5 } }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} alignItems={{ xs: 'flex-start', sm: 'center' }} sx={{ mb: 3 }}>
            <Box sx={{ width: 76, height: 76, borderRadius: 3, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: `${c.accent.primary}1A`, overflow: 'hidden' }}>
              {bundle.icon_url ? (
                <Box component="img" src={bundle.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <Inventory2Icon sx={{ fontSize: 34, color: c.accent.primary }} />
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: { xs: '1.65rem', sm: '2rem' }, lineHeight: 1.15, fontWeight: 700, letterSpacing: '-0.03em', color: c.text.primary }}>
                {bundle.title}
              </Typography>
              <Typography sx={{ mt: 0.75, color: c.accent.primary, fontWeight: 600 }}>
                Bundle · {members.length} {members.length === 1 ? 'package' : 'packages'}
                {bundle.author ? (
                  <Box component="span" sx={{ color: c.text.tertiary, fontWeight: 400 }}>{` · ${bundle.author}`}</Box>
                ) : null}
              </Typography>
            </Box>
          </Stack>

          <Typography sx={{ fontSize: '0.98rem', color: c.text.secondary, lineHeight: 1.7, whiteSpace: 'pre-wrap', mb: 3 }}>
            {bundle.description || 'A curated collection of packages.'}
          </Typography>

          {tags.length > 0 && (
            <Stack direction="row" sx={{ mb: 3, flexWrap: 'wrap', gap: 0.75 }}>
              {tags.map((tag) => (
                <Chip key={tag} label={`#${tag}`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.tertiary }} />
              ))}
            </Stack>
          )}

          <Divider sx={{ borderColor: c.border.subtle, mb: 2.5 }} />

          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5, gap: 1.5, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: c.text.muted }}>
              In this bundle
            </Typography>
            <Button
              onClick={onInstallAll}
              disabled={installing || installable.length === 0}
              variant="contained"
              size="small"
              disableElevation
              startIcon={
                installing ? (
                  <CircularProgress size={15} thickness={5} sx={{ color: 'inherit' }} />
                ) : (
                  <DownloadIcon sx={{ fontSize: 17 }} />
                )
              }
              sx={{
                borderRadius: 999,
                textTransform: 'none',
                fontWeight: 600,
                bgcolor: c.accent.primary,
                color: '#fff',
                px: 2,
                '&:hover': { bgcolor: c.accent.primary, filter: 'brightness(0.94)' },
              }}
            >
              Install all ({installable.length})
            </Button>
          </Stack>

          {members.length === 0 ? (
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem' }}>
              The packages in this bundle are no longer available.
            </Typography>
          ) : (
            <Stack spacing={1.25}>
              {members.map((m) => (
                <Box
                  key={m.id}
                  onClick={() => onOpenMember(m)}
                  role="button"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.75,
                    cursor: 'pointer',
                    bgcolor: c.bg.elevated,
                    border: `1px solid ${c.border.subtle}`,
                    borderRadius: 2.5,
                    p: 1.75,
                    transition: c.transition,
                    '&:hover': { borderColor: c.border.medium, boxShadow: c.shadow.sm },
                  }}
                >
                  <Box sx={{ width: 44, height: 44, borderRadius: 2, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: `${c.accent.primary}14`, overflow: 'hidden' }}>
                    {m.icon_url ? (
                      <Box component="img" src={m.icon_url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <ExtensionIcon sx={{ fontSize: 22, color: c.accent.primary }} />
                    )}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: c.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.title}
                    </Typography>
                    <Typography sx={{ fontSize: '0.78rem', color: c.text.muted }}>
                      {KIND_LABELS[m.kind] || m.kind || 'Package'}
                      {m.version ? ` · v${m.version}` : ''}
                    </Typography>
                  </Box>
                  <Stack spacing={0.5} alignItems="flex-end" sx={{ flexShrink: 0 }}>
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        onInstallMember(m.id);
                      }}
                      disabled={installing || !m.download_url}
                      variant="outlined"
                      size="small"
                      sx={{
                        borderRadius: 999,
                        textTransform: 'none',
                        borderColor: c.border.medium,
                        color: c.text.primary,
                        '&:hover': { borderColor: c.accent.primary, bgcolor: `${c.accent.primary}0D` },
                      }}
                    >
                      Install
                    </Button>
                    {m.download_url && (
                      <Link
                        href={m.download_url}
                        download
                        rel="noopener"
                        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                        sx={{ fontSize: '0.72rem', color: c.text.muted, textDecorationColor: c.border.medium, '&:hover': { color: c.text.primary } }}
                      >
                        Download .swarm file
                      </Link>
                    )}
                  </Stack>
                </Box>
              ))}
            </Stack>
          )}

          <Typography sx={{ mt: 3, fontSize: '0.8rem', color: c.text.ghost }}>
            Install all adds every package in this bundle at once, or install them one at a time. The raw .swarm files stay linked if you would rather keep a copy.
          </Typography>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
