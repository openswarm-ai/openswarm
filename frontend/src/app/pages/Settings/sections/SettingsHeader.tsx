import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import DialogTitle from '@mui/material/DialogTitle';
import { X } from 'lucide-react';
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
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pt: 1.5, pb: 0.5 }}>
        <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
          Settings
        </Typography>
        <IconButton onClick={onClose} size="small" data-onboarding="settings-close-button" sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
          <X size={18} />
        </IconButton>
      </Box>
      <Tabs
        value={activeTab}
        onChange={(_, v) => onTabChange(v)}
        sx={{
          minHeight: 34,
          pb: 1,
          // Pill segmented control: filled active pill, no underline indicator.
          '& .MuiTabs-indicator': { display: 'none' },
          '& .MuiTab-root': {
            minHeight: 30,
            textTransform: 'none',
            fontSize: '0.85rem',
            fontWeight: 500,
            color: c.text.muted,
            px: 1.75,
            mr: 0.5,
            borderRadius: '999px',
            transition: 'background-color 0.12s, color 0.12s',
            '&:hover': { color: c.text.secondary, bgcolor: `${c.text.tertiary}0A` },
            '&.Mui-selected': { color: c.text.primary, fontWeight: 600, bgcolor: `${c.accent.primary}26` },
          },
        }}
      >
        <Tab label="General" value="general" disableRipple />
        <Tab label="Models" value="models" disableRipple data-onboarding="settings-models-tab" />
        <Tab label="Skills" value="skills" disableRipple />
        <Tab label="Tools" value="tools" disableRipple />
        <Tab label="Commands" value="commands" disableRipple />
        <Tab label="Usage" value="usage" disableRipple />
      </Tabs>
    </DialogTitle>
  );
};

export default SettingsHeader;
