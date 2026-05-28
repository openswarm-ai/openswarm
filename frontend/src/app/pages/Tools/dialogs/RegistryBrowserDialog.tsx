import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import StorefrontIcon from '@mui/icons-material/Storefront';
import StarIcon from '@mui/icons-material/Star';
import SortIcon from '@mui/icons-material/Sort';
import CloudIcon from '@mui/icons-material/Cloud';
import PublicIcon from '@mui/icons-material/Public';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { McpServer, McpServerDetail } from '@/shared/state/mcpRegistrySlice';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { Skeleton } from '@/app/components/feedback/Loading';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { cleanServerName } from '../toolsHelpers';
import RegistryServerRow from './RegistryServerRow';

interface RegistryBrowserDialogProps {
  open: boolean;
  onClose: () => void;
  regStats: { total: number; google: number; community: number; lastUpdated: number } | null;
  regSource: '' | 'community' | 'google' | 'curated';
  devMode: boolean;
  regQuery: string;
  onRegSearch: (q: string) => void;
  regSort: 'name' | 'stars';
  onRegSort: (sort: 'name' | 'stars') => void;
  onRegSourceFilter: (e: React.MouseEvent<HTMLElement>, val: '' | 'community' | 'google' | 'curated') => void;
  regLoading: boolean;
  regServers: McpServer[];
  regTotal: number;
  allTools: ToolDefinition[];
  expandedServer: string | null;
  onExpandServer: (srv: McpServer, next: string | null) => void;
  regDetail: McpServerDetail | null;
  regDetailLoading: boolean;
  onInstall: (srv: McpServer) => void;
  onEditInstall: (srv: McpServer) => void;
  onLoadMore: () => void;
}

const RegistryBrowserDialog: React.FC<RegistryBrowserDialogProps> = ({
  open: registryOpen,
  onClose: setRegistryClose,
  regStats,
  regSource,
  devMode,
  regQuery,
  onRegSearch: handleRegSearch,
  regSort,
  onRegSort: handleRegSort,
  onRegSourceFilter: handleRegSourceFilter,
  regLoading,
  regServers,
  regTotal,
  allTools,
  expandedServer,
  onExpandServer,
  regDetail,
  regDetailLoading,
  onInstall: handleInstall,
  onEditInstall: handleEditInstall,
  onLoadMore: handleLoadMore,
}) => {
  const c = useClaudeTokens();
  return (
      <Dialog
        open={registryOpen}
        onClose={() => setRegistryClose()}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.page, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}`, height: '80vh' } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1.5, pb: 1 }}>
          <StorefrontIcon sx={{ color: c.accent.primary }} />
          MCP Registry
          {regStats && (
            <>
              <Chip
                label={
                  regSource === 'google'
                    ? `${regStats.google.toLocaleString()} Google servers`
                    : regSource === 'community'
                      ? `${regStats.community.toLocaleString()} Community servers`
                      : `${regStats.total.toLocaleString()} servers`
                }
                size="small"
                sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 20, ml: 'auto' }}
              />
              {devMode && regStats.lastUpdated > 0 && (
                <Typography sx={{ color: c.text.ghost, fontSize: '0.68rem', flexShrink: 0 }}>
                  Synced {Math.round((Date.now() / 1000 - regStats.lastUpdated) / 60)}m ago
                </Typography>
              )}
            </>
          )}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 0, px: 3, pb: 0, overflow: 'hidden',
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
          scrollbarWidth: 'thin', scrollbarColor: `${c.border.medium} transparent`,
        }}>
          <Box sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'center' }}>
            <TextField
              placeholder="Search MCP servers..."
              value={regQuery}
              onChange={(e) => handleRegSearch(e.target.value)}
              fullWidth
              size="small"
              autoFocus
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ color: c.text.ghost, fontSize: 20 }} />
                  </InputAdornment>
                ),
              }}
              sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.surface, borderRadius: 2 } }}
            />
            <ToggleButtonGroup
              value={regSource}
              exclusive
              onChange={handleRegSourceFilter}
              size="small"
              sx={{
                flexShrink: 0,
                '& .MuiToggleButton-root': {
                  color: c.text.ghost, border: `1px solid ${c.border.medium}`, textTransform: 'none',
                  fontSize: '0.72rem', py: 0.5, px: 1.2, lineHeight: 1.4,
                  '&.Mui-selected': { bgcolor: c.bg.secondary, color: c.text.primary, borderColor: c.border.strong },
                  '&:hover': { bgcolor: c.bg.secondary },
                },
              }}
            >
              <ToggleButton value="curated">Curated</ToggleButton>
              <ToggleButton value="">All</ToggleButton>
              <ToggleButton value="community"><PublicIcon sx={{ fontSize: 14, mr: 0.5 }} />Community</ToggleButton>
              <ToggleButton value="google"><CloudIcon sx={{ fontSize: 14, mr: 0.5 }} />Google</ToggleButton>
            </ToggleButtonGroup>
            <Tooltip title={regSort === 'name' ? 'Sort by stars' : 'Sort by name'}>
              <IconButton
                size="small"
                onClick={() => handleRegSort(regSort === 'name' ? 'stars' : 'name')}
                sx={{
                  color: regSort === 'stars' ? '#c89c00' : c.text.ghost,
                  border: '1px solid',
                  borderColor: regSort === 'stars' ? '#c89c0040' : c.border.medium,
                  borderRadius: 1.5,
                  px: 1,
                  flexShrink: 0,
                  transition: 'all 0.15s',
                  '&:hover': { borderColor: '#c89c00', color: '#c89c00' },
                }}
              >
                <StarIcon sx={{ fontSize: 16 }} />
                <SortIcon sx={{ fontSize: 14, ml: 0.25 }} />
              </IconButton>
            </Tooltip>
          </Box>

          {regLoading && regServers.length === 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, flex: 1, py: 1 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} variant="card" height={56} />
              ))}
            </Box>
          ) : regServers.length === 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: c.text.ghost, gap: 1.5 }}>
              <SearchIcon sx={{ fontSize: 40, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.9rem' }}>No servers found matching "{regQuery}"</Typography>
            </Box>
          ) : (
            <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 0.5,
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
              '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
              scrollbarWidth: 'thin', scrollbarColor: `${c.border.medium} transparent`,
            }}>
              <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mb: 0.5 }}>
                Showing {regServers.length} of {regTotal.toLocaleString()} results
              </Typography>
              {regServers.map((srv) => (
                <RegistryServerRow
                  key={srv.name}
                  srv={srv}
                  isExpanded={expandedServer === srv.name}
                  isInstalled={allTools.some((t) => t.name === (srv.title || cleanServerName(srv.name)))}
                  devMode={devMode}
                  regDetail={regDetail}
                  regDetailLoading={regDetailLoading}
                  expandedServer={expandedServer}
                  onExpand={onExpandServer}
                  onInstall={handleInstall}
                  onEditInstall={handleEditInstall}
                />
              ))}

              {regServers.length < regTotal && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <Button
                    onClick={handleLoadMore}
                    disabled={regLoading}
                    sx={{ color: c.accent.primary, textTransform: 'none', fontSize: '0.85rem' }}
                  >
                    {regLoading ? <CircularProgress size={16} sx={{ color: c.accent.primary, mr: 1 }} /> : null}
                    Load More
                  </Button>
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRegistryClose()} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Close</Button>
        </DialogActions>
      </Dialog>
  );
};

export default RegistryBrowserDialog;
