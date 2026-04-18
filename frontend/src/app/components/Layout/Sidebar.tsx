import React, { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { openSettingsModal } from '@/shared/state/settingsSlice';
import Box from '@mui/material/Box';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import InputBase from '@mui/material/InputBase';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PsychologyIcon from '@mui/icons-material/Psychology';
import BuildIcon from '@mui/icons-material/Build';
import TuneIcon from '@mui/icons-material/Tune';
import ViewQuiltIcon from '@mui/icons-material/ViewQuilt';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { CREATE_DASHBOARD, UPDATE_DASHBOARD } from '@/shared/backend-bridge/apps/dashboards';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const CUSTOMIZATION_ITEMS = [
  { label: 'Skills', path: '/skills', icon: <PsychologyIcon /> },
  { label: 'Actions', path: '/actions', icon: <BuildIcon /> },
  { label: 'Modes', path: '/modes', icon: <TuneIcon /> },
];
const CUSTOMIZATION_PATHS = new Set(CUSTOMIZATION_ITEMS.map((i) => i.path));

interface SidebarProps { showUpdateDot: boolean }

const Sidebar: React.FC<SidebarProps> = ({ showUpdateDot }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const [dashExpanded, setDashExpanded] = useState(true);
  const [appsExpanded, setAppsExpanded] = useState(true);
  const [customExpanded, setCustomExpanded] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const dashboardItems = useAppSelector((s) => s.dashboards.items);
  const dashboardList = Object.values(dashboardItems).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );
  const appsList = Object.values(useAppSelector((s) => s.apps.items)).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  const isDashRoute = location.pathname === '/' || location.pathname.startsWith('/dashboard/');
  const isAppsRoute = location.pathname === '/apps' || location.pathname.startsWith('/apps/');
  const isCustomRoute = location.pathname === '/customization' || CUSTOMIZATION_PATHS.has(location.pathname);
  const activeDashId = location.pathname.startsWith('/dashboard/') ? location.pathname.split('/dashboard/')[1] : null;
  const activeAppId = location.pathname.startsWith('/apps/') ? location.pathname.split('/apps/')[1] : null;

  const handleDashClick = () => {
    if (isDashRoute && location.pathname === '/') setDashExpanded((p) => !p);
    else { navigate('/'); setDashExpanded(true); }
  };
  const handleDashItemClick = (id: string) => { if (renamingId !== id) navigate(`/dashboard/${id}`); };
  const handleStartRename = (id: string, name: string) => { setRenamingId(id); setRenameValue(name); };
  const handleRenameSubmit = (id: string) => {
    const t = renameValue.trim();
    if (t && t !== dashboardItems[id]?.name) dispatch(UPDATE_DASHBOARD({ dashboardId: id, name: t }));
    setRenamingId(null);
  };
  const handleCreateDash = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = await dispatch(CREATE_DASHBOARD('Untitled Dashboard'));
    if (CREATE_DASHBOARD.fulfilled.match(r)) navigate(`/dashboard/${r.payload.id}`);
  };
  const handleAppsClick = () => {
    if (isAppsRoute && location.pathname === '/apps') setAppsExpanded((p) => !p);
    else { navigate('/apps'); setAppsExpanded(true); }
  };
  const handleCreateApp = (e: React.MouseEvent) => { e.stopPropagation(); navigate('/apps/new'); };

  const sectionSx = (a: boolean) => ({ borderRadius: 1.5, py: 0.6, px: 1.25,
    bgcolor: a ? `${c.accent.primary}12` : 'transparent',
    '&:hover': { bgcolor: a ? `${c.accent.primary}18` : `${c.text.tertiary}0A` }, transition: 'background-color 0.15s' });
  const sectionTextSx = (a: boolean) => ({ '& .MuiListItemText-primary': {
    color: a ? c.text.primary : c.text.muted, fontSize: '0.82rem', fontWeight: a ? 600 : 400 } });
  const subItemSx = (a: boolean) => ({ display: 'flex', alignItems: 'center', gap: 0.75, pl: 1.25, pr: 1, py: 0.5,
    ml: '-0.5px', cursor: 'pointer', borderLeft: a ? `1.5px solid ${c.accent.primary}` : '1.5px solid transparent',
    bgcolor: a ? `${c.accent.primary}0C` : 'transparent',
    '&:hover': { bgcolor: `${c.text.tertiary}0A` }, transition: 'background-color 0.12s, border-color 0.12s' });
  const subTextSx = (a: boolean) => ({ color: a ? c.text.secondary : c.text.ghost, fontSize: '0.78rem',
    fontWeight: a ? 500 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 });
  const scrollSx = { ml: 2, mt: 0.25, mb: 0.5, borderLeft: `1px solid ${c.border.medium}`, maxHeight: 240, overflow: 'auto',
    '&::-webkit-scrollbar': { width: 3 }, '&::-webkit-scrollbar-track': { background: 'transparent' },
    '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 4 },
    scrollbarWidth: 'thin' as const, scrollbarColor: `${c.border.medium} transparent` };
  const chevronSx = (exp: boolean) => ({ color: c.text.ghost, fontSize: 16, transition: 'transform 0.2s',
    transform: exp ? 'rotate(180deg)' : 'rotate(0deg)' });
  const addBtnSx = { color: c.text.ghost, p: 0.25, mr: 0.25, borderRadius: 1,
    '&:hover': { color: c.accent.primary, bgcolor: `${c.accent.primary}14` } };

  return (
    <>
      <Box sx={{ flex: 1, overflow: 'auto', pt: 0.5, '&::-webkit-scrollbar': { width: 0 } }}>
        <Box sx={{ px: 1, mb: 0.25 }}>
          <ListItemButton onClick={handleDashClick} sx={sectionSx(isDashRoute)}>
            <ListItemIcon sx={{ color: isDashRoute ? c.accent.primary : c.text.tertiary, minWidth: 32 }}>
              <DashboardIcon sx={{ fontSize: 20 }} />
            </ListItemIcon>
            <ListItemText primary="Dashboards" sx={sectionTextSx(isDashRoute)} />
            <Tooltip title="New dashboard" placement="right">
              <IconButton size="small" onClick={handleCreateDash} sx={addBtnSx}>
                <AddIcon sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
            {dashboardList.length > 0 && <ExpandMoreIcon sx={chevronSx(dashExpanded)} />}
          </ListItemButton>
          <Collapse in={dashExpanded && dashboardList.length > 0} timeout={200}>
            <Box sx={scrollSx}>
              {dashboardList.map((entry) => {
                const isActive = activeDashId === entry.id;
                const isRen = renamingId === entry.id;
                return (
                  <Box key={entry.id} onClick={() => handleDashItemClick(entry.id)}
                    sx={{ ...subItemSx(isActive), py: isRen ? 0.25 : 0.5, cursor: isRen ? 'default' : 'pointer' }}>
                    {isRen ? (
                      <InputBase autoFocus value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameSubmit(entry.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(entry.id); if (e.key === 'Escape') setRenamingId(null); }}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => e.target.select()}
                        sx={{ flex: 1, minWidth: 0, fontSize: '0.78rem', fontWeight: isActive ? 500 : 400,
                          color: isActive ? c.text.secondary : c.text.ghost, py: 0, px: 0.5,
                          borderRadius: 0.75, border: `1px solid ${c.accent.primary}80`, bgcolor: c.bg.page,
                          '& input': { padding: '1px 0' } }}
                      />
                    ) : (
                      <Typography onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(entry.id, entry.name); }}
                        sx={subTextSx(isActive)}>
                        {entry.name}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Collapse>
        </Box>
        <Box sx={{ mx: 1.5, my: 0.5, borderTop: `0.5px solid ${c.border.subtle}` }} />
        <Box sx={{ px: 1, mb: 0.25 }}>
          <ListItemButton onClick={() => {
            if (isCustomRoute) setCustomExpanded((p) => !p);
            else { navigate('/customization'); setCustomExpanded(true); }
          }} sx={sectionSx(isCustomRoute)}>
            <ListItemIcon sx={{ color: isCustomRoute ? c.accent.primary : c.text.tertiary, minWidth: 32 }}>
              <ExtensionIcon sx={{ fontSize: 20 }} />
            </ListItemIcon>
            <ListItemText primary="Customization" sx={sectionTextSx(isCustomRoute)} />
            <ExpandMoreIcon sx={chevronSx(customExpanded)} />
          </ListItemButton>
          <Collapse in={customExpanded} timeout={200}>
            <Box sx={{ ml: 2, mt: 0.25, mb: 0.5, borderLeft: `1px solid ${c.border.medium}` }}>
              {CUSTOMIZATION_ITEMS.map((item) => (
                <NavLink key={item.path} to={item.path} style={{ textDecoration: 'none', color: 'inherit' }}>
                  {({ isActive }) => (
                    <Box sx={subItemSx(isActive)}>
                      <Typography sx={subTextSx(isActive)}>{item.label}</Typography>
                    </Box>
                  )}
                </NavLink>
              ))}
            </Box>
          </Collapse>
        </Box>
        <Box sx={{ mx: 1.5, my: 0.5, borderTop: `0.5px solid ${c.border.subtle}` }} />
        <Box sx={{ px: 1, mb: 0.25 }}>
          <ListItemButton onClick={handleAppsClick} sx={sectionSx(isAppsRoute)}>
            <ListItemIcon sx={{ color: isAppsRoute ? c.accent.primary : c.text.tertiary, minWidth: 32 }}>
              <ViewQuiltIcon sx={{ fontSize: 20 }} />
            </ListItemIcon>
            <ListItemText primary="Apps" sx={sectionTextSx(isAppsRoute)} />
            <Tooltip title="New app" placement="right">
              <IconButton size="small" onClick={handleCreateApp} sx={addBtnSx}>
                <AddIcon sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
            {appsList.length > 0 && <ExpandMoreIcon sx={chevronSx(appsExpanded)} />}
          </ListItemButton>
          <Collapse in={appsExpanded && appsList.length > 0} timeout={200}>
            <Box sx={scrollSx}>
              {appsList.map((app) => {
                const isActive = activeAppId === app.id;
                return (
                  <Box key={app.id} onClick={() => navigate(`/apps/${app.id}`)} sx={subItemSx(isActive)}>
                    <Typography sx={subTextSx(isActive)}>{app.name}</Typography>
                  </Box>
                );
              })}
            </Box>
          </Collapse>
        </Box>
      </Box>
      <Box sx={{ px: 1, py: 1, borderTop: `0.5px solid ${c.border.subtle}` }}>
        <ListItemButton onClick={() => dispatch(openSettingsModal())} sx={{
          borderRadius: 1.5, py: 0.6, px: 1.25,
          '&:hover': { bgcolor: `${c.text.tertiary}0A` }, transition: 'background-color 0.15s',
        }}>
          <ListItemIcon sx={{ color: c.text.tertiary, minWidth: 32, position: 'relative' }}>
            <SettingsIcon sx={{ fontSize: 20 }} />
            {showUpdateDot && (
              <Box sx={{ position: 'absolute', top: 2, right: 10, width: 7, height: 7,
                borderRadius: '50%', bgcolor: c.accent.primary, border: `1.5px solid ${c.bg.secondary}` }} />
            )}
          </ListItemIcon>
          <ListItemText primary="Settings" sx={{
            '& .MuiListItemText-primary': { color: c.text.muted, fontSize: '0.82rem', fontWeight: 400 },
          }} />
        </ListItemButton>
      </Box>
    </>
  );
};

export default Sidebar;
