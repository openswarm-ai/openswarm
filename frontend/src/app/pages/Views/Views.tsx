import React, { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchOutputs, deleteOutput, Output } from '@/shared/state/outputsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewCard from './ViewCard';
import ViewEditor from './ViewEditor';
import ViewRunDialog from './ViewRunDialog';

const Views: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.outputs.items);
  const loading = useAppSelector((state) => state.outputs.loading);
  const outputs = useMemo(() => Object.values(items), [items]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingOutput, setEditingOutput] = useState<Output | null>(null);
  const [runOutput, setRunOutput] = useState<Output | null>(null);

  useEffect(() => {
    dispatch(fetchOutputs());
  }, [dispatch]);

  const handleNewView = () => {
    setEditingOutput(null);
    setEditorOpen(true);
  };

  const handleEditView = (output: Output) => {
    setEditingOutput(output);
    setEditorOpen(true);
  };

  const handleDeleteView = (id: string) => {
    dispatch(deleteOutput(id));
  };

  const handleEditorClose = () => {
    setEditorOpen(false);
    setEditingOutput(null);
    dispatch(fetchOutputs());
  };

  if (editorOpen) {
    return <ViewEditor output={editingOutput} onClose={handleEditorClose} />;
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 4 }}>
      <Box
        sx={{
          maxWidth: 1200,
          mx: 'auto',
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 3,
          }}
        >
          <Typography
            variant="h4"
            sx={{ fontWeight: 700, color: c.text.primary }}
          >
            Views
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleNewView}
            sx={{
              bgcolor: c.accent.primary,
              borderRadius: 2,
              textTransform: 'none',
              fontWeight: 500,
              px: 2.5,
              '&:hover': { bgcolor: c.accent.hover },
            }}
          >
            New view
          </Button>
        </Box>

        {/* Card grid */}
        {loading ? (
          <Typography sx={{ color: c.text.muted, textAlign: 'center', py: 8 }}>
            Loading...
          </Typography>
        ) : outputs.length === 0 ? (
          <Box
            sx={{
              textAlign: 'center',
              py: 10,
              color: c.text.muted,
            }}
          >
            <Typography sx={{ fontSize: '1.1rem', mb: 1 }}>
              No views yet
            </Typography>
            <Typography sx={{ fontSize: '0.85rem', color: c.text.tertiary }}>
              Create your first reusable view
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
            {outputs.map((output) => (
              <ViewCard
                key={output.id}
                output={output}
                onClick={() => handleEditView(output)}
                onDelete={() => handleDeleteView(output.id)}
                onRun={() => setRunOutput(output)}
              />
            ))}
          </Box>
        )}
      </Box>

      {runOutput && (
        <ViewRunDialog
          output={runOutput}
          onClose={() => setRunOutput(null)}
        />
      )}
    </Box>
  );
};

export default Views;
