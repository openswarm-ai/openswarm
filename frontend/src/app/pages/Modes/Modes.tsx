import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import AddIcon from '@mui/icons-material/Add';
import TuneIcon from '@mui/icons-material/Tune';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useModes } from './hooks/useModes';
import ModeCard from './ModeCard';
import ModeFormDialog from './ModeFormDialog/ModeFormDialog';

const Modes: React.FC = () => {
  const c = useClaudeTokens();
  const {
    modes, items, loading,
    dialogOpen, setDialogOpen, editingId,
    form, setForm, browseFolder,
    openCreate, openEdit, handleSave, handleDelete,
    editingIsBuiltin, hasDiverged, handleReset,
    otherModes, mcpToolNames,
  } = useModes();

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ color: c.text.primary, fontWeight: 700, mb: 0.5 }}>
            Modes
          </Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem' }}>
            Configure agent interaction modes with custom system prompts, actions, and auto-switching.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            textTransform: 'none',
            borderRadius: 2,
          }}
        >
          New Mode
        </Button>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
          <CircularProgress sx={{ color: c.accent.primary }} />
        </Box>
      ) : modes.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            py: 8,
            color: c.text.ghost,
            gap: 2,
          }}
        >
          <TuneIcon sx={{ fontSize: 48, opacity: 0.4 }} />
          <Typography>No modes defined yet. Create one to get started.</Typography>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: 2,
          }}
        >
          {modes.map((mode) => (
            <ModeCard
              key={mode.id}
              mode={mode}
              items={items}
              onEdit={openEdit}
              onDelete={handleDelete}
              c={c}
            />
          ))}
        </Box>
      )}

      <ModeFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        editingId={editingId}
        editingIsBuiltin={editingIsBuiltin}
        hasDiverged={hasDiverged}
        form={form}
        setForm={setForm}
        onSave={handleSave}
        onReset={handleReset}
        otherModes={otherModes}
        mcpToolNames={mcpToolNames}
        browseFolder={browseFolder}
        c={c}
      />
    </Box>
  );
};

export default Modes;
