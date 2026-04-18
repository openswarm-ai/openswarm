import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  LIST_DASHBOARDS,
  CREATE_DASHBOARD,
  DELETE_DASHBOARD,
  DUPLICATE_DASHBOARD,
  UPDATE_DASHBOARD,
} from '@/shared/backend-bridge/apps/dashboards';
import type { Dashboard } from '@/shared/state/dashboardsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import DashboardCard from './DashboardCard';

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
    dispatch(LIST_DASHBOARDS());
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
    const result = await dispatch(CREATE_DASHBOARD('Untitled Dashboard'));
    if (CREATE_DASHBOARD.fulfilled.match(result)) {
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
    if (menuDashboard) dispatch(DELETE_DASHBOARD(menuDashboard.id));
    handleCloseMenu();
  };

  const handleDuplicate = () => {
    if (menuDashboard) dispatch(DUPLICATE_DASHBOARD(menuDashboard.id));
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
      dispatch(UPDATE_DASHBOARD({ dashboardId: id, name: trimmed }));
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
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 700, color: c.text.primary }}>
              Dashboards
            </Typography>
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem', mt: 0.5 }}>
              Monitor and manage your agents from a single workspace.
            </Typography>
          </Box>
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
              <DashboardCard
                key={d.id}
                dashboard={d}
                isRenaming={renamingId === d.id}
                renameValue={renameValue}
                onRenameValueChange={setRenameValue}
                onRenameSubmit={() => handleRenameSubmit(d.id)}
                onCancelRename={() => setRenamingId(null)}
                onOpenMenu={(e) => handleOpenMenu(e, d)}
                onClick={() => navigate(`/dashboard/${d.id}`)}
              />
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
