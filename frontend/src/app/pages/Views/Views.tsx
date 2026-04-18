import React, { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import AddIcon from '@mui/icons-material/Add';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { LIST_APPS, DELETE_APP, App } from '@/shared/backend-bridge/apps/app_builder';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewCard from './ViewCard';
import ViewEditor from './ViewEditor';
import ViewRunDialog from './ViewRunDialog';

const Views: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const items = useAppSelector((state) => state.apps.items);
  const loading = useAppSelector((state) => state.apps.loading);
  const loaded = useAppSelector((state) => state.apps.loaded);
  const apps = useMemo(() => Object.values(items), [items]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<App | null>(null);
  const [runApp, setRunApp] = useState<App | null>(null);

  useEffect(() => {
    dispatch(LIST_APPS());
  }, [dispatch]);

  useEffect(() => {
    if (!loaded) return;
    if (routeId === 'new') {
      setEditingApp(null);
      setEditorOpen(true);
    } else if (routeId && items[routeId]) {
      setEditingApp(items[routeId]);
      setEditorOpen(true);
    } else if (routeId && routeId !== 'new') {
      navigate('/apps', { replace: true });
    } else if (!routeId) {
      setEditorOpen(false);
      setEditingApp(null);
    }
  }, [routeId, loaded, items, navigate]);

  const handleNewView = () => {
    navigate('/apps/new');
  };

  const handleEditView = (app: App) => {
    navigate(`/apps/${app.id}`);
  };

  const handleDeleteView = (id: string) => {
    dispatch(DELETE_APP(id));
  };

  const handleEditorClose = () => {
    setEditorOpen(false);
    setEditingApp(null);
    dispatch(LIST_APPS());
    navigate('/apps');
  };

  if (editorOpen) {
    return <ViewEditor key={editingApp?.id ?? 'new'} output={editingApp} onClose={handleEditorClose} />;
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
        ) : apps.length === 0 ? (
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
            {apps.map((app) => (
              <ViewCard
                key={app.id}
                output={app}
                onClick={() => handleEditView(app)}
                onDelete={() => handleDeleteView(app.id)}
                onRun={() => setRunApp(app)}
              />
            ))}
          </Box>
        )}
      </Box>

      {runApp && (
        <ViewRunDialog
          output={runApp}
          onClose={() => setRunApp(null)}
        />
      )}
    </Box>
  );
};

export default Views;
