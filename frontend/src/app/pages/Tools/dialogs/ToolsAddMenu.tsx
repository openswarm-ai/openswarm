import React, { useState } from 'react';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import StorefrontIcon from '@mui/icons-material/Storefront';
import AddLinkIcon from '@mui/icons-material/AddLink';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import AddCustomConnectorDialog from '../../Directory/dialogs/AddCustomConnectorDialog';

interface Props {
  devMode: boolean;
  onBrowseConnectors?: () => void;
  onOpenCreate: () => void;
  onOpenRegistry: () => void;
  onSnackbar: (message: string, severity: 'success' | 'error') => void;
}

// The Tools page's Add button (claude.ai's Connectors-page grammar) plus the custom-connector dialog it opens.
const ToolsAddMenu: React.FC<Props> = ({ devMode, onBrowseConnectors, onOpenCreate, onOpenRegistry, onSnackbar }) => {
  const c = useClaudeTokens();
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [customConnectorOpen, setCustomConnectorOpen] = useState(false);
  const closeMenu = () => setMenuAnchor(null);

  return (
    <>
      <Button
        size="small"
        variant="contained"
        startIcon={<AddIcon sx={{ fontSize: 16 }} />}
        endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
        onClick={(e: React.MouseEvent<HTMLElement>) => setMenuAnchor(e.currentTarget)}
        sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', borderRadius: 2, fontSize: '0.8125rem' }}
      >
        Add
      </Button>
      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={closeMenu}
        PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 2, mt: 0.5, minWidth: 200 } }}
      >
        <MenuItem onClick={() => { closeMenu(); onBrowseConnectors?.(); }} sx={{ color: c.text.primary, fontSize: '0.875rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
          <StorefrontIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
          Browse connectors
        </MenuItem>
        <MenuItem onClick={() => { closeMenu(); setCustomConnectorOpen(true); }} sx={{ color: c.text.primary, fontSize: '0.875rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
          <AddLinkIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
          Add custom connector
        </MenuItem>
        <MenuItem onClick={() => { closeMenu(); onOpenCreate(); }} sx={{ color: c.text.primary, fontSize: '0.875rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
          <BuildIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
          Create Custom
        </MenuItem>
        {devMode && (
          <MenuItem onClick={() => { closeMenu(); onOpenRegistry(); }} sx={{ color: c.text.primary, fontSize: '0.875rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
            <StorefrontIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
            Browse MCP Registry
          </MenuItem>
        )}
      </Menu>

      <AddCustomConnectorDialog
        open={customConnectorOpen}
        onClose={() => setCustomConnectorOpen(false)}
        onBrowsePrebuilt={() => { setCustomConnectorOpen(false); onBrowseConnectors?.(); }}
        onAdded={onSnackbar}
      />
    </>
  );
};

export default ToolsAddMenu;
