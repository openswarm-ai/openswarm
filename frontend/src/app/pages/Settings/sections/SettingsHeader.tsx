import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import DialogTitle from '@mui/material/DialogTitle';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const SettingsHeader: React.FC<{
  activeTab: string;
  onTabChange: (v: any) => void;
  onClose: () => void;
}> = ({ activeTab, onTabChange, onClose }) => {
  const c = useClaudeTokens();
  return (
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
        <IconButton onClick={onClose} size="small" data-onboarding="settings-close-button" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>
      <Tabs
        value={activeTab}
        onChange={(_, v) => onTabChange(v)}
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
        <Tab label="Models" value="models" disableRipple data-onboarding="settings-models-tab" />
        <Tab label="Usage" value="usage" disableRipple />
        <Tab label="Commands" value="commands" disableRipple />
      </Tabs>
    </DialogTitle>
  );
};

export default SettingsHeader;
