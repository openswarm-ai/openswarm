import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const items = useAppSelector((state) => state.outputs.items);
  const loading = useAppSelector((state) => state.outputs.loading);
  const loaded = useAppSelector((state) => state.outputs.loaded);
  const outputs = useMemo(() => Object.values(items), [items]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingOutput, setEditingOutput] = useState<Output | null>(null);
  const [runOutput, setRunOutput] = useState<Output | null>(null);

  useEffect(() => {
    dispatch(fetchOutputs());
  }, [dispatch]);

  useEffect(() => {
    if (!loaded) return;
    if (routeId === 'new') {
      setEditingOutput(null);
      setEditorOpen(true);
    } else if (routeId && items[routeId]) {
      setEditingOutput(items[routeId]);
      setEditorOpen(true);
    } else if (routeId && routeId !== 'new') {
      navigate('/apps', { replace: true });
    } else if (!routeId) {
      setEditorOpen(false);
      setEditingOutput(null);
    }
  }, [routeId, loaded, items, navigate]);

  const handleNewView = () => {
    navigate('/apps/new');
  };

  const handleEditView = (output: Output) => {
    navigate(`/apps/${output.id}`);
  };

  const handleDeleteView = (id: string) => {
    dispatch(deleteOutput(id));
  };

  const handleEditorClose = () => {
    setEditorOpen(false);
    setEditingOutput(null);
    dispatch(fetchOutputs());
    navigate('/apps');
  };

  if (editorOpen) {
    return <ViewEditor key={editingOutput?.id ?? 'new'} output={editingOutput} onClose={handleEditorClose} />;
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
          <Box>
            <Typography
              variant="h4"
              sx={{ fontWeight: 700, color: c.text.primary }}
            >
              Apps
            </Typography>
            <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem', mt: 0.5 }}>
              In the past, we used to have to pay for expensive applications. Now, you can prompt them into existence.
            </Typography>
          </Box>
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
            New app
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
              No apps yet
            </Typography>
            <Typography sx={{ fontSize: '0.85rem', color: c.text.tertiary }}>
              Create your first reusable app
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
