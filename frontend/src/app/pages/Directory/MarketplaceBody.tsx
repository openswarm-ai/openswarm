import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import FolderSpecialOutlinedIcon from '@mui/icons-material/FolderSpecialOutlined';
import PowerOutlinedIcon from '@mui/icons-material/PowerOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { clearMarketplaceRequestedTab } from '@/shared/state/dashboardLayoutSlice';
import DirectorySkillsTab from './DirectorySkillsTab';
import DirectoryConnectorsTab from './DirectoryConnectorsTab';

// Lazy: the manage views pull the full Skills/Tools pages (markdown, MCP cards) and the marketplace opens from the dock.
const SkillsManage = React.lazy(() => import('../Skills/Skills'));
const ToolsManage = React.lazy(() => import('../Tools/Tools'));

export type DirectoryTab = 'skills' | 'connectors' | 'my-skills' | 'my-connectors';

const VALID_TABS: DirectoryTab[] = ['skills', 'connectors', 'my-skills', 'my-connectors'];

// The Marketplace window body: claude.ai's Directory grids land first (the store), with the
// installed-item manage pages as their own rail rows below the divider.
const MarketplaceBody: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const requestedTab = useAppSelector((s) => s.dashboardLayout.marketplaceRequestedTab);
  const [view, setView] = useState<DirectoryTab>('skills');
  const [focusSkillId, setFocusSkillId] = useState<string | null>(null);
  const [focusToolId, setFocusToolId] = useState<string | null>(null);

  useEffect(() => {
    if (requestedTab && VALID_TABS.includes(requestedTab as DirectoryTab)) {
      setView(requestedTab as DirectoryTab);
      dispatch(clearMarketplaceRequestedTab());
    }
  }, [requestedTab, dispatch]);

  const railRow = (value: DirectoryTab, label: string, icon: React.ReactNode) => {
    const selected = view === value;
    return (
      <Box
        role="button"
        onClick={() => setView(value)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1,
          borderRadius: `${c.radius.md}px`, cursor: 'pointer', userSelect: 'none',
          bgcolor: selected ? c.bg.secondary : 'transparent',
          transition: 'background 0.12s',
          '&:hover': { bgcolor: selected ? c.bg.secondary : c.bg.elevated },
        }}
      >
        {icon}
        <Typography sx={{ fontSize: '0.9375rem', fontWeight: 600, color: c.text.primary }}>{label}</Typography>
      </Box>
    );
  };

  const spinner = (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress size={24} sx={{ color: c.accent.primary }} />
    </Box>
  );

  const content = (): React.ReactElement => {
    switch (view) {
      case 'skills':
        return <DirectorySkillsTab onOpenInstalled={(id) => { setFocusSkillId(id); setView('my-skills'); }} />;
      case 'connectors':
        return <DirectoryConnectorsTab onOpenInstalled={(id) => { setFocusToolId(id); setView('my-connectors'); }} />;
      case 'my-skills':
        return <SkillsManage onBrowseDirectory={() => setView('skills')} focusSkillId={focusSkillId} />;
      case 'my-connectors':
        return <ToolsManage onBrowseConnectors={() => setView('connectors')} expandToolId={focusToolId} />;
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, bgcolor: c.bg.surface }}>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, pt: 1.5 }}>
        <Box sx={{ width: 210, minWidth: 210, px: 2, pt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {railRow('skills', 'Skills', <DescriptionOutlinedIcon sx={{ fontSize: 19, color: c.text.secondary }} />)}
          {railRow('connectors', 'Connectors', <GridViewOutlinedIcon sx={{ fontSize: 19, color: c.text.secondary }} />)}
          <Box sx={{ height: '1px', bgcolor: c.border.subtle, mx: 1.5, my: 1 }} />
          {railRow('my-skills', 'My skills', <FolderSpecialOutlinedIcon sx={{ fontSize: 19, color: c.text.secondary }} />)}
          {railRow('my-connectors', 'My connectors', <PowerOutlinedIcon sx={{ fontSize: 19, color: c.text.secondary }} />)}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', pr: 3.5, pl: 1, pb: 3 }}>
          <React.Suspense fallback={spinner}>
            {content()}
          </React.Suspense>
        </Box>
      </Box>
    </Box>
  );
};

export default MarketplaceBody;
