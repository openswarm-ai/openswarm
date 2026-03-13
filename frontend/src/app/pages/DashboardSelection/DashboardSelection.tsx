import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import AddIcon from '@mui/icons-material/Add';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchDashboards,
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  renameDashboard,
  Dashboard,
} from '@/shared/state/dashboardsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const DashboardSelection: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const items = useAppSelector((state) => state.dashboards.items);
  const loading = useAppSelector((state) => state.dashboards.loading);

  const [search, setSearch] = useState('');
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [menuDashboard, setMenuDashboard] = useState<Dashboard | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    dispatch(fetchDashboards());
  }, [dispatch]);

  const dashboards = useMemo(() => {
    const all = Object.values(items).sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter((d) => d.name.toLowerCase().includes(q));
  }, [items, search]);

  const handleCreate = async () => {
    const result = await dispatch(createDashboard('Untitled Dashboard'));
    if (createDashboard.fulfilled.match(result)) {
      navigate(`/dashboard/${result.payload.id}`);
    }
  };

  const handleOpenMenu = (e: React.MouseEvent<HTMLElement>, d: Dashboard) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
    setMenuDashboard(d);
  };

  const handleCloseMenu = () => {
    setMenuAnchor(null);
    setMenuDashboard(null);
  };

  const handleDelete = () => {
    if (menuDashboard) dispatch(deleteDashboard(menuDashboard.id));
    handleCloseMenu();
  };

  const handleDuplicate = () => {
    if (menuDashboard) dispatch(duplicateDashboard(menuDashboard.id));
    handleCloseMenu();
  };

  const handleStartRename = () => {
    const target = menuDashboard;
    handleCloseMenu();
    if (target) {
      setTimeout(() => {
        setRenamingId(target.id);
        setRenameValue(target.name);
      }, 150);
    }
  };

  const handleRenameSubmit = (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== items[id]?.name) {
      dispatch(renameDashboard({ id, name: trimmed }));
    }
    setRenamingId(null);
  };

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 4 }}>
      <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 3,
          }}
        >
          <Typography variant="h4" sx={{ fontWeight: 700, color: c.text.primary }}>
            Dashboards
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleCreate}
            sx={{
              bgcolor: c.accent.primary,
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 500,
              px: 2.5,
              '&:hover': { bgcolor: c.accent.hover },
            }}
          >
            New dashboard
          </Button>
        </Box>

        <Box sx={{ mb: 3 }}>
          <TextField
            placeholder="Search dashboards..."
            size="small"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            InputProps={{
              startAdornment: (
                <SearchIcon sx={{ color: c.text.ghost, mr: 1, fontSize: 20 }} />
              ),
            }}
            sx={{
              width: 320,
              '& .MuiOutlinedInput-root': {
                bgcolor: c.bg.surface,
                borderRadius: 2,
                fontSize: '0.875rem',
                '& fieldset': { borderColor: c.border.subtle },
                '&:hover fieldset': { borderColor: c.border.medium },
              },
            }}
          />
        </Box>

        {loading ? (
          <Typography sx={{ color: c.text.muted, textAlign: 'center', py: 8 }}>
            Loading...
          </Typography>
        ) : dashboards.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 10, color: c.text.muted }}>
            <Typography sx={{ fontSize: '1.1rem', mb: 1 }}>
              {search ? 'No dashboards match your search' : 'No dashboards yet'}
            </Typography>
            <Typography sx={{ fontSize: '0.85rem', color: c.text.tertiary }}>
              {search ? 'Try a different search term' : 'Create your first dashboard to get started'}
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 2.5,
            }}
          >
            {dashboards.map((d) => (
              <Box
                key={d.id}
                onClick={() => {
                  if (renamingId === d.id) return;
                  navigate(`/dashboard/${d.id}`);
                }}
                sx={{
                  cursor: renamingId === d.id ? 'default' : 'pointer',
                  borderRadius: 3,
                  border: `1px solid ${c.border.subtle}`,
                  bgcolor: c.bg.surface,
                  overflow: 'hidden',
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    borderColor: c.border.strong,
                    boxShadow: c.shadow.md,
                    transform: 'translateY(-2px)',
                  },
                  '&:hover .card-actions': { opacity: 1 },
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <Box
                  sx={{
                    height: 120,
                    bgcolor: c.accent.primary + '12',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                  }}
                >
                  <DashboardIcon
                    sx={{ fontSize: 48, color: c.accent.primary, opacity: 0.5 }}
                  />
                  <Box
                    className="card-actions"
                    sx={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      display: 'flex',
                      gap: 0.5,
                      opacity: 0,
                      transition: 'opacity 0.15s',
                    }}
                  >
                    <Tooltip title="More actions">
                      <IconButton
                        size="small"
                        onClick={(e) => handleOpenMenu(e, d)}
                        sx={{
                          bgcolor: c.bg.surface,
                          color: c.text.muted,
                          boxShadow: c.shadow.sm,
                          '&:hover': { bgcolor: c.bg.elevated },
                        }}
                      >
                        <MoreVertIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>

                <Box sx={{ p: 2, flex: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {renamingId === d.id ? (
                    <TextField
                      autoFocus
                      size="small"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRenameSubmit(d.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit(d.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      sx={{
                        '& .MuiOutlinedInput-root': {
                          fontSize: '0.95rem',
                          fontWeight: 600,
                        },
                      }}
                    />
                  ) : (
                    <Typography
                      sx={{
                        fontSize: '0.95rem',
                        fontWeight: 600,
                        color: c.text.primary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d.name}
                    </Typography>
                  )}
                  <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>
                    Updated {formatRelativeTime(d.updated_at)}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleCloseMenu}
        slotProps={{
          paper: {
            sx: {
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.subtle}`,
              boxShadow: c.shadow.lg,
              minWidth: 160,
            },
          },
        }}
      >
        <MenuItem onClick={handleStartRename}>
          <ListItemIcon><EditIcon sx={{ fontSize: 18 }} /></ListItemIcon>
          <ListItemText>Rename</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleDuplicate}>
          <ListItemIcon><ContentCopyIcon sx={{ fontSize: 18 }} /></ListItemIcon>
          <ListItemText>Duplicate</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleDelete} sx={{ color: c.status.error }}>
          <ListItemIcon><DeleteOutlineIcon sx={{ fontSize: 18, color: c.status.error }} /></ListItemIcon>
          <ListItemText>Delete</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default DashboardSelection;
