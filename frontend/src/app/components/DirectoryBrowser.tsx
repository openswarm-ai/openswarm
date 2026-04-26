import React, { useState, useEffect, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Link from '@mui/material/Link';
import FolderIcon from '@mui/icons-material/Folder';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { BrowseResult } from '@/shared/state/settingsSlice';
import { API_BASE } from '@/shared/config';

const SETTINGS_API = `${API_BASE}/settings`;

export interface ContextPath {
  path: string;
  type: 'file' | 'directory';
}

interface DirectoryBrowserProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: ContextPath) => void;
  initialPath?: string;
}

const DirectoryBrowser: React.FC<DirectoryBrowserProps> = ({ open, onClose, onSelect, initialPath }) => {
  const c = useClaudeTokens();
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [selected, setSelected] = useState<{ name: string; type: 'file' | 'directory' } | null>(null);

  const browse = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const res = await fetch(`${SETTINGS_API}/browse-directories?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'Failed to browse');
      }
      const data: BrowseResult = await res.json();
      setBrowseData(data);
      setManualPath(data.current);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSelected(null);
      browse(initialPath || '');
    }
  }, [open, initialPath, browse]);

  const handleNavigate = (dir: string) => {
    if (browseData) browse(`${browseData.current}/${dir}`);
  };

  const handleGoUp = () => {
    if (browseData?.parent) browse(browseData.parent);
  };

  const handleManualGo = () => {
    if (manualPath.trim()) browse(manualPath.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleManualGo();
  };

  const handleConfirm = () => {
    if (!browseData) return;
    if (selected) {
      const fullPath = `${browseData.current}/${selected.name}`;
      onSelect({ path: fullPath, type: selected.type });
    } else {
      onSelect({ path: browseData.current, type: 'directory' });
    }
    onClose();
  };

  const pathSegments = browseData?.current.split('/').filter(Boolean) ?? [];
  const hasEntries = (browseData?.directories.length ?? 0) + (browseData?.files.length ?? 0) > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: c.bg.surface,
          backgroundImage: 'none',
          borderRadius: 4,
          border: `1px solid ${c.border.subtle}`,
          height: 520,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, pb: 1 }}>
        Browse Files &amp; Folders
      </DialogTitle>
      <DialogContent sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        overflow: 'hidden',
        '&::-webkit-scrollbar': { width: 5 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': {
          background: c.border.medium,
          borderRadius: 3,
          '&:hover': { background: c.border.strong },
        },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            placeholder="Type a path..."
            sx={{
              '& .MuiOutlinedInput-root': {
                bgcolor: c.bg.page,
                fontSize: '0.85rem',
                fontFamily: c.font.mono,
              },
            }}
          />
          <Button
            onClick={handleManualGo}
            variant="outlined"
            size="small"
            sx={{
              color: c.accent.primary,
              borderColor: c.border.medium,
              textTransform: 'none',
              minWidth: 'auto',
              px: 2,
            }}
          >
            Go
          </Button>
        </Box>

        {browseData && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <IconButton
              size="small"
              onClick={handleGoUp}
              disabled={!browseData.parent}
              sx={{ color: c.text.tertiary, '&:hover': { color: c.accent.primary } }}
            >
              <ArrowUpwardIcon sx={{ fontSize: 18 }} />
            </IconButton>
            <Breadcrumbs
              separator="/"
              sx={{
                '& .MuiBreadcrumbs-separator': { color: c.text.ghost, mx: 0.25 },
                flex: 1,
                overflow: 'hidden',
              }}
            >
              <Link
                component="button"
                underline="hover"
                onClick={() => browse('/')}
                sx={{ color: c.text.tertiary, fontSize: '0.78rem' }}
              >
                /
              </Link>
              {pathSegments.map((seg, i) => {
                const fullPath = '/' + pathSegments.slice(0, i + 1).join('/');
                const isLast = i === pathSegments.length - 1;
                return isLast ? (
                  <Typography key={fullPath} sx={{ color: c.text.primary, fontSize: '0.78rem', fontWeight: 500 }}>
                    {seg}
                  </Typography>
                ) : (
                  <Link
                    key={fullPath}
                    component="button"
                    underline="hover"
                    onClick={() => browse(fullPath)}
                    sx={{ color: c.text.tertiary, fontSize: '0.78rem' }}
                  >
                    {seg}
                  </Link>
                );
              })}
            </Breadcrumbs>
          </Box>
        )}

        {error && (
          <Typography sx={{ color: c.status.error, fontSize: '0.82rem', px: 1 }}>
            {error}
          </Typography>
        )}

        <Box sx={{
          flex: 1,
          overflow: 'auto',
          border: `1px solid ${c.border.subtle}`,
          borderRadius: 2,
          bgcolor: c.bg.page,
          '&::-webkit-scrollbar': { width: 5 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: c.border.medium,
            borderRadius: 3,
            '&:hover': { background: c.border.strong },
          },
          scrollbarWidth: 'thin',
          scrollbarColor: `${c.border.medium} transparent`,
        }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={24} sx={{ color: c.accent.primary }} />
            </Box>
          ) : !hasEntries ? (
            <Box sx={{ py: 4, textAlign: 'center' }}>
              <Typography sx={{ color: c.text.ghost, fontSize: '0.85rem' }}>
                Empty directory
              </Typography>
            </Box>
          ) : (
            <List dense disablePadding>
              {browseData?.directories.map((dir) => (
                <ListItemButton
                  key={`d-${dir}`}
                  selected={selected?.name === dir && selected.type === 'directory'}
                  onDoubleClick={() => handleNavigate(dir)}
                  onClick={() =>
                    setSelected((prev) =>
                      prev?.name === dir && prev.type === 'directory' ? null : { name: dir, type: 'directory' },
                    )
                  }
                  sx={{
                    py: 0.75,
                    '&.Mui-selected': { bgcolor: `${c.accent.primary}0c` },
                    '&:hover': { bgcolor: `${c.accent.primary}08` },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 32, color: c.accent.primary }}>
                    <FolderIcon sx={{ fontSize: 18 }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={dir}
                    primaryTypographyProps={{ sx: { fontSize: '0.84rem', color: c.text.primary } }}
                  />
                </ListItemButton>
              ))}
              {browseData?.files.map((file) => (
                <ListItemButton
                  key={`f-${file}`}
                  selected={selected?.name === file && selected.type === 'file'}
                  onClick={() =>
                    setSelected((prev) =>
                      prev?.name === file && prev.type === 'file' ? null : { name: file, type: 'file' },
                    )
                  }
                  sx={{
                    py: 0.75,
                    '&.Mui-selected': { bgcolor: `${c.accent.primary}0c` },
                    '&:hover': { bgcolor: `${c.accent.primary}08` },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 32, color: c.text.muted }}>
                    <InsertDriveFileOutlinedIcon sx={{ fontSize: 17 }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={file}
                    primaryTypographyProps={{ sx: { fontSize: '0.84rem', color: c.text.secondary } }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between' }}>
        <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem', pl: 1 }}>
          {selected
            ? `Selected: ${selected.name}`
            : 'Click to select, double-click folders to open'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} sx={{ color: c.text.tertiary, textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleConfirm}
            disabled={!browseData}
            sx={{
              bgcolor: c.accent.primary,
              '&:hover': { bgcolor: c.accent.pressed },
              textTransform: 'none',
              borderRadius: 2,
            }}
          >
            {selected ? `Attach ${selected.type === 'file' ? 'File' : 'Folder'}` : 'Attach This Folder'}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};

export default DirectoryBrowser;
