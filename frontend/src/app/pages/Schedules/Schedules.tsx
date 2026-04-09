import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchSchedules,
  deleteSchedule,
  toggleSchedule,
  clearUnread,
  Schedule,
} from '@/shared/state/schedulesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ScheduleEditor from './ScheduleEditor';

function formatTrigger(s: Schedule): string {
  if (s.trigger_type === 'cron' && s.cron_expression) return `Cron: ${s.cron_expression}`;
  if (s.trigger_type === 'interval' && s.interval_seconds) {
    if (s.interval_seconds >= 3600) return `Every ${Math.round(s.interval_seconds / 3600)}h`;
    if (s.interval_seconds >= 60) return `Every ${Math.round(s.interval_seconds / 60)}m`;
    return `Every ${s.interval_seconds}s`;
  }
  if (s.trigger_type === 'once' && s.run_at) return `Once: ${new Date(s.run_at).toLocaleString()}`;
  return s.trigger_type;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

const Schedules: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.schedules.items);
  const dashboards = useAppSelector((s) => s.dashboards.items);
  const loading = useAppSelector((s) => s.schedules.loading);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const scheduleList = Object.values(items).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  const location = useLocation();

  useEffect(() => {
    dispatch(fetchSchedules());
    dispatch(clearUnread());
  }, [dispatch]);

  // Auto-open editor when navigated with ?edit=<schedule_id>
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const editId = params.get('edit');
    if (editId) {
      setEditingId(editId);
      setEditorOpen(true);
    }
  }, [location.search]);

  const handleEdit = (id: string) => {
    setEditingId(id);
    setEditorOpen(true);
  };

  const handleCreate = () => {
    setEditingId(null);
    setEditorOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await dispatch(deleteSchedule(id)).unwrap();
    } catch (e: any) {
      setDeleteError(e.message || 'Failed to delete schedule');
    }
  };

  const handleToggle = (id: string) => {
    dispatch(toggleSchedule(id));
  };

  return (
    <Box sx={{ width: '100%', height: '100%', bgcolor: c.bg.page, color: c.text.primary, p: 3, overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>Schedules</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreate} sx={{ bgcolor: c.accent.primary }}>
          New Schedule
        </Button>
      </Box>

      {scheduleList.length === 0 && !loading ? (
        <Typography sx={{ color: c.text.muted }}>No schedules yet. Create one to get started.</Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Trigger</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Dashboard</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Status</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Next Run</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Last Run</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Runs</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }} align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {scheduleList.map((s) => (
                <TableRow key={s.id} hover>
                  <TableCell sx={{ color: c.text.primary }}>{s.name}</TableCell>
                  <TableCell sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{formatTrigger(s)}</TableCell>
                  <TableCell sx={{ color: c.text.muted }}>
                    {dashboards[s.dashboard_id]?.name || s.dashboard_id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {s.last_error ? (
                      <Tooltip title={s.last_error}>
                        <Chip label="Error" size="small" sx={{ bgcolor: c.status.errorBg, color: c.status.error, fontWeight: 600 }} />
                      </Tooltip>
                    ) : s.enabled ? (
                      <Chip label="Active" size="small" sx={{ bgcolor: c.status.successBg, color: c.status.success, fontWeight: 600 }} />
                    ) : (
                      <Chip label="Paused" size="small" sx={{ bgcolor: c.status.warningBg, color: c.status.warning, fontWeight: 600 }} />
                    )}
                  </TableCell>
                  <TableCell sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{formatDate(s.next_run_at)}</TableCell>
                  <TableCell sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{formatDate(s.last_run_at)}</TableCell>
                  <TableCell sx={{ color: c.text.muted }}>{s.run_count}</TableCell>
                  <TableCell align="right">
                    <Tooltip title={s.enabled ? 'Pause' : 'Resume'}>
                      <IconButton size="small" onClick={() => handleToggle(s.id)} sx={{ color: c.text.muted }}>
                        {s.enabled ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => handleEdit(s.id)} sx={{ color: c.text.muted }}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={() => handleDelete(s.id)} sx={{ color: c.text.muted }}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ScheduleEditor
        open={editorOpen}
        scheduleId={editingId}
        onClose={() => { setEditorOpen(false); setEditingId(null); }}
      />

      <Snackbar open={!!deleteError} autoHideDuration={4000} onClose={() => setDeleteError(null)}>
        <Alert severity="error" onClose={() => setDeleteError(null)}>{deleteError}</Alert>
      </Snackbar>
    </Box>
  );
};

export default Schedules;
