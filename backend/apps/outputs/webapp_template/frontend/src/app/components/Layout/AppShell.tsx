import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Sidebar from './Sidebar';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface AppShellProps {
  children: React.ReactNode;
}

const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const c = useClaudeTokens();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((prev) => !prev)} />
      <Box
        component="main"
        sx={{
          flex: 1,
          overflow: 'auto',
          bgcolor: c.bg.page,
          transition: c.transition,
          '&::-webkit-scrollbar': { width: 4 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          scrollbarWidth: 'thin',
          scrollbarColor: `${c.border.medium} transparent`,
        }}
      >
        {children}
      </Box>
    </Box>
  );
};

export default AppShell;
