import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import { CommandsContent } from '@/app/pages/Commands/Commands';
import { useSettings } from './hooks/useSettings';
import GeneralTab from './GeneralTab';
import ModelsTab from './ModelsTab';

const Settings: React.FC = () => {
  const s = useSettings();
  const { c, open, activeTab, setActiveTab, hasChanges, handleSave, handleRequestClose,
          confirmDiscard, setConfirmDiscard, handleConfirmDiscard, handleSaveAndClose,
          saved, setSaved } = s;
  return (
    <>
    <Dialog
      open={open}
      onClose={handleRequestClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 780,
          height: '85vh',
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          transition: 'none',
        },
      }}
    >
      <DialogTitle
        sx={{
          px: 3,
          py: 0,
          borderBottom: `1px solid ${c.border.subtle}`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pt: 1.5, pb: 0.5 }}>
          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
            Settings
          </Typography>
          <IconButton onClick={handleRequestClose} size="small" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
        <Tabs
          value={activeTab}
          onChange={(_, v) => setActiveTab(v)}
          sx={{
            minHeight: 36,
            '& .MuiTab-root': {
              minHeight: 36,
              textTransform: 'none',
              fontSize: '0.85rem',
              fontWeight: 500,
              color: c.text.muted,
              px: 1.5,
              '&.Mui-selected': { color: c.accent.primary, fontWeight: 600 },
            },
            '& .MuiTabs-indicator': { backgroundColor: c.accent.primary, height: 2 },
          }}
        >
          <Tab label="General" value="general" disableRipple />
          <Tab label="Models" value="models" disableRipple />
          <Tab label="Commands" value="commands" disableRipple />
        </Tabs>
      </DialogTitle>
      <DialogContent sx={{
        px: 3,
        py: 0,
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}>
      {activeTab === 'general' ? (
        <GeneralTab s={s} />
      ) : activeTab === 'models' ? (
        <ModelsTab s={s} />
      ) : (
      <Box sx={{ pt: 2.5, pb: 1, animation: 'fadeIn 0.2s ease', '@keyframes fadeIn': { from: { opacity: 0 }, to: { opacity: 1 } } }}>
        <CommandsContent />
      </Box>
      )}
      </DialogContent>
      {(activeTab === 'general' || activeTab === 'models') && (
      <DialogActions sx={{ borderTop: `1px solid ${c.border.subtle}`, px: 3, py: 1.5, justifyContent: 'flex-end' }}>
        <Button
          onClick={handleRequestClose}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon sx={{ fontSize: 16 }} />}
          onClick={handleSave}
          disabled={!hasChanges}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
            textTransform: 'none',
            borderRadius: 1.5,
            px: 2.5,
            fontSize: '0.85rem',
          }}
        >
          Save
        </Button>
      </DialogActions>
      )}
      <Snackbar
        open={saved}
        autoHideDuration={3000}
        onClose={() => setSaved(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSaved(false)} severity="success" sx={{ bgcolor: c.bg.surface, color: c.text.primary, border: `1px solid ${c.status.success}` }}>
          Settings saved
        </Alert>
      </Snackbar>
    </Dialog>
    <Dialog
      open={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      PaperProps={{
        sx: {
          bgcolor: c.bg.page,
          borderRadius: 2,
          border: `1px solid ${c.border.subtle}`,
          boxShadow: c.shadow.md,
          maxWidth: 380,
        },
      }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem', pb: 0.5, px: 3, pt: 2.5 }}>
        Unsaved changes
      </DialogTitle>
      <DialogContent sx={{ px: 3 }}>
        <Typography sx={{ color: c.text.muted, fontSize: '0.85rem' }}>
          You have unsaved changes. Would you like to save them before closing?
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          onClick={handleConfirmDiscard}
          sx={{ color: c.status.error, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Discard
        </Button>
        <Button
          onClick={() => setConfirmDiscard(false)}
          sx={{ color: c.text.muted, textTransform: 'none', fontSize: '0.85rem' }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSaveAndClose}
          sx={{
            bgcolor: c.accent.primary,
            '&:hover': { bgcolor: c.accent.pressed },
            textTransform: 'none',
            borderRadius: 1.5,
            fontSize: '0.85rem',
          }}
        >
          Save & Close
        </Button>
      </DialogActions>
    </Dialog>
    </>
  );
};

export default Settings;
