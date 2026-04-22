import React, { useEffect, useState, useMemo, useCallback } from 'react';
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
import Collapse from '@mui/material/Collapse';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import TerminalIcon from '@mui/icons-material/Terminal';
import DescriptionIcon from '@mui/icons-material/Description';
import SearchIcon from '@mui/icons-material/Search';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import FolderIcon from '@mui/icons-material/Folder';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import CodeIcon from '@mui/icons-material/Code';
import VisibilityIcon from '@mui/icons-material/Visibility';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  Skill,
} from '@/shared/state/skillsSlice';
import {
  fetchAllRegistrySkills,
  fetchSkillRegistryStats,
  fetchSkillDetail,
  RegistrySkill,
  RegistrySkillDetail,
} from '@/shared/state/skillRegistrySlice';
import SkillBuilderChat, { SkillPreviewData } from './SkillBuilderChat';

interface SkillForm {
  name: string;
  description: string;
  content: string;
  command: string;
}

type Selection =
  | { type: 'registry'; name: string }
  | { type: 'local'; id: string }
  | { type: 'builder-preview' }
  | null;

const emptyForm: SkillForm = { name: '', description: '', content: '', command: '' };

const SIDEBAR_W = 260;

const Skills: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { items, loading } = useAppSelector((s) => s.skills);
  const {
    skills: regSkills,
    loading: regLoading,
    stats: regStats,
    detail: regDetail,
    detailLoading: regDetailLoading,
  } = useAppSelector((s) => s.skillRegistry);
  const localSkills = Object.values(items);

  const [selection, setSelection] = useState<Selection>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});

  const [contentView, setContentView] = useState<'preview' | 'raw'>('preview');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SkillForm>(emptyForm);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string }>({ open: false, message: '' });
  const [builderPreview, setBuilderPreview] = useState<SkillPreviewData | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const handleBuilderPreview = useCallback((data: SkillPreviewData | null) => {
    setBuilderPreview(data);
    if (data) {
      setSelection({ type: 'builder-preview' });
    } else if (selection?.type === 'builder-preview') {
      setSelection(null);
    }
  }, [selection]);

  const handleBuilderSaved = useCallback((message: string) => {
    setSnackbar({ open: true, message });
    dispatch(fetchSkills());
  }, [dispatch]);

  useEffect(() => {
    dispatch(fetchSkills());
    dispatch(fetchSkillRegistryStats());
    dispatch(fetchAllRegistrySkills());
  }, [dispatch]);

  // Group registry skills by category
  const regGrouped = useMemo(() => {
    const groups: Record<string, RegistrySkill[]> = {};
    const q = searchFilter.toLowerCase();
    for (const sk of regSkills) {
      if (q && !sk.name.toLowerCase().includes(q) && !sk.description.toLowerCase().includes(q)) continue;
      const cat = sk.category || 'General';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(sk);
    }
    return groups;
  }, [regSkills, searchFilter]);

  const filteredLocal = useMemo(() => {
    const q = searchFilter.toLowerCase();
    if (!q) return localSkills;
    return localSkills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [localSkills, searchFilter]);

  const categoryOrder = useMemo(() => Object.keys(regGrouped).sort(), [regGrouped]);

  const toggleCategory = (cat: string) =>
    setCollapsedCats((p) => ({ ...p, [cat]: !p[cat] }));

  // Selection handlers
  const selectRegistry = (name: string) => {
    setSelection({ type: 'registry', name });
    dispatch(fetchSkillDetail(name));
  };

  const selectLocal = (id: string) => {
    setSelection({ type: 'local', id });
  };

  // Get active detail content
  const selectedLocal: Skill | null =
    selection?.type === 'local' ? items[selection.id] ?? null : null;
  const selectedReg: RegistrySkillDetail | null =
    selection?.type === 'registry' && regDetail?.name === selection.name ? regDetail : null;

  // CRUD
  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (skill: Skill) => {
    setEditingId(skill.id);
    setForm({ name: skill.name, description: skill.description, content: skill.content, command: skill.command });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (editingId) {
      await dispatch(updateSkill({ id: editingId, ...form }));
    } else {
      await dispatch(createSkill(form));
    }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => {
    await dispatch(deleteSkill(id));
    if (selection?.type === 'local' && selection.id === id) setSelection(null);
  };

  const handleInstall = async () => {
    if (!selectedReg) return;
    await dispatch(createSkill({
      name: selectedReg.name,
      description: selectedReg.description,
      content: selectedReg.content,
      command: selectedReg.name.toLowerCase().replace(/\s+/g, '-'),
    }));
    setSnackbar({ open: true, message: `Installed "${selectedReg.name}" as a local skill` });
  };

  const handleEditInstall = () => {
    if (!selectedReg) return;
    setEditingId(null);
    setForm({
      name: selectedReg.name,
      description: selectedReg.description,
      content: selectedReg.content,
      command: selectedReg.name.toLowerCase().replace(/\s+/g, '-'),
    });
    setDialogOpen(true);
  };

  const isSelected = (type: 'registry' | 'local', key: string) => {
    if (!selection) return false;
    if (type === 'registry') return selection.type === 'registry' && selection.name === key;
    return selection.type === 'local' && selection.id === key;
  };

  // ─── Content preview with raw/preview toggle ───
  const ContentPreview: React.FC<{ content: string }> = ({ content }) => (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1, flexShrink: 0 }}>
        <ToggleButtonGroup
          value={contentView}
          exclusive
          onChange={(_, v) => { if (v) setContentView(v); }}
          size="small"
          sx={{
            '& .MuiToggleButton-root': {
              color: c.text.tertiary, border: `1px solid ${c.border.medium}`,
              textTransform: 'none', fontSize: '0.74rem', py: 0.25, px: 1.2, lineHeight: 1.4,
              '&.Mui-selected': { bgcolor: c.bg.secondary, color: c.text.primary, borderColor: c.border.strong },
              '&:hover': { bgcolor: 'rgba(0,0,0,0.03)' },
            },
          }}
        >
          <ToggleButton value="preview"><VisibilityIcon sx={{ fontSize: 14, mr: 0.5 }} />Preview</ToggleButton>
          <ToggleButton value="raw"><CodeIcon sx={{ fontSize: 14, mr: 0.5 }} />Raw</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {contentView === 'raw' ? (
        <Box sx={{
          flex: 1, minHeight: 0,
          bgcolor: c.bg.secondary, border: `${c.border.width} solid ${c.border.subtle}`,
          borderRadius: `${c.radius.md}px`, p: 2.5,
          overflow: 'auto',
          '&::-webkit-scrollbar': { width: 5 },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
        }}>
          <Typography component="pre" sx={{
            color: c.text.secondary, fontSize: '0.8rem', fontFamily: c.font.mono,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', m: 0, lineHeight: 1.65,
          }}>
            {content}
          </Typography>
        </Box>
      ) : (
        <Box sx={{
          flex: 1, minHeight: 0,
          bgcolor: c.bg.elevated, border: `${c.border.width} solid ${c.border.subtle}`,
          borderRadius: `${c.radius.md}px`, p: 3,
          overflow: 'auto',
          '&::-webkit-scrollbar': { width: 5 },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
          '& h1': { fontSize: '1.3rem', fontWeight: 700, color: c.text.primary, mt: 0, mb: 1.5, fontFamily: c.font.sans },
          '& h2': { fontSize: '1.1rem', fontWeight: 600, color: c.text.primary, mt: 2, mb: 1, fontFamily: c.font.sans },
          '& h3': { fontSize: '0.95rem', fontWeight: 600, color: c.text.primary, mt: 1.5, mb: 0.75, fontFamily: c.font.sans },
          '& p': { fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.7, mb: 1.5 },
          '& ul, & ol': { pl: 2.5, mb: 1.5, '& li': { fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.7, mb: 0.5 } },
          '& code': { fontFamily: c.font.mono, fontSize: '0.82rem', bgcolor: 'rgba(0,0,0,0.04)', px: 0.5, py: 0.15, borderRadius: `${c.radius.xs}px` },
          '& pre': { bgcolor: c.bg.secondary, border: `${c.border.width} solid ${c.border.subtle}`, borderRadius: `${c.radius.sm}px`, p: 2, mb: 1.5, overflow: 'auto',
            '& code': { bgcolor: 'transparent', color: c.text.secondary, px: 0, py: 0 },
          },
          '& hr': { border: 'none', borderTop: `1px solid ${c.border.subtle}`, my: 2 },
          '& a': { color: c.accent.primary, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
          '& strong': { fontWeight: 600, color: c.text.primary },
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </Box>
      )}
    </Box>
  );

  // ─── Sidebar row component ───
  const SidebarRow: React.FC<{
    label: string;
    selected: boolean;
    onClick: () => void;
    icon?: React.ReactNode;
  }> = ({ label, selected, onClick, icon }) => (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.6,
        borderRadius: `${c.radius.sm}px`, cursor: 'pointer',
        bgcolor: selected ? c.bg.secondary : 'transparent',
        transition: 'background 0.12s',
        '&:hover': { bgcolor: selected ? c.bg.secondary : 'rgba(0,0,0,0.03)' },
      }}
    >
      {icon ?? <DescriptionIcon sx={{ fontSize: 15, color: c.text.tertiary, flexShrink: 0 }} />}
      <Typography
        sx={{
          fontSize: '0.82rem', color: selected ? c.text.primary : c.text.secondary,
          fontWeight: selected ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {label}
      </Typography>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden', bgcolor: c.bg.page, position: 'relative' }}>
      {/* ─── Left Sidebar ─── */}
      <Box
        sx={{
          width: SIDEBAR_W, minWidth: SIDEBAR_W, height: '100%', display: 'flex', flexDirection: 'column',
          borderRight: `${c.border.width} solid ${c.border.subtle}`, bgcolor: 'transparent',
        }}
      >
        {/* Sidebar header */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, pt: 2, pb: 1 }}>
          <Typography sx={{ fontSize: '0.92rem', fontWeight: 700, color: c.text.primary }}>Skills</Typography>
          <Box sx={{ display: 'flex', gap: 0.25 }}>
            <Tooltip title="Search">
              <IconButton
                size="small"
                onClick={() => setSearchFilter((p) => (p === '' ? ' ' : ''))}
                sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
              >
                <SearchIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Create skill">
              <IconButton size="small" onClick={openCreate} sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
                <AddIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        <Box sx={{ px: 1.5, pb: 0.5 }}>
          <Button
            size="small"
            startIcon={<AutoFixHighIcon sx={{ fontSize: 14 }} />}
            onClick={() => setBuilderOpen(true)}
            fullWidth
            sx={{
              textTransform: 'none',
              fontSize: '0.76rem',
              fontWeight: 500,
              color: c.accent.primary,
              justifyContent: 'flex-start',
              py: 0.5,
              px: 1,
              borderRadius: `${c.radius.sm}px`,
              border: `1px dashed ${c.accent.primary}40`,
              '&:hover': { bgcolor: `${c.accent.primary}08`, borderColor: c.accent.primary },
            }}
          >
            Build with AI
          </Button>
        </Box>

        {/* Search input (toggled) */}
        <Collapse in={searchFilter !== ''}>
          <Box sx={{ px: 1.5, pb: 1 }}>
            <TextField
              placeholder="Filter skills..."
              value={searchFilter.trim()}
              onChange={(e) => setSearchFilter(e.target.value)}
              fullWidth
              size="small"
              autoFocus
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 16, color: c.text.ghost }} />
                  </InputAdornment>
                ),
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: c.bg.surface, borderRadius: `${c.radius.sm}px`, fontSize: '0.82rem',
                  '& fieldset': { borderColor: c.border.medium },
                },
              }}
            />
          </Box>
        </Collapse>

        {/* Scrollable tree */}
        <Box
          sx={{
            flex: 1, overflow: 'auto', px: 0.75, pb: 2,
            '&::-webkit-scrollbar': { width: 4 },
            '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          }}
        >
          {/* My Skills (local) */}
          {filteredLocal.length > 0 && (
            <Box sx={{ mb: 1 }}>
              <Box
                onClick={() => toggleCategory('__local')}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5,
                  cursor: 'pointer', userSelect: 'none',
                  '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' }, borderRadius: `${c.radius.sm}px`,
                }}
              >
                {collapsedCats['__local']
                  ? <KeyboardArrowRightIcon sx={{ fontSize: 16, color: c.text.ghost }} />
                  : <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost }} />}
                <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  My Skills
                </Typography>
                <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, ml: 0.5 }}>({filteredLocal.length})</Typography>
              </Box>
              <Collapse in={!collapsedCats['__local']}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mt: 0.25 }}>
                  {filteredLocal.map((sk) => (
                    <SidebarRow
                      key={sk.id}
                      label={sk.name}
                      selected={isSelected('local', sk.id)}
                      onClick={() => selectLocal(sk.id)}
                      icon={<FolderIcon sx={{ fontSize: 15, color: c.text.tertiary, flexShrink: 0 }} />}
                    />
                  ))}
                </Box>
              </Collapse>
            </Box>
          )}

          {/* Registry categories */}
          {(loading || regLoading) && regSkills.length === 0 && localSkills.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
              <CircularProgress size={22} sx={{ color: c.accent.primary }} />
            </Box>
          ) : (
            categoryOrder.map((cat) => {
              const group = regGrouped[cat];
              if (!group || group.length === 0) return null;
              const isCollapsed = !!collapsedCats[cat];
              return (
                <Box key={cat} sx={{ mb: 0.5 }}>
                  <Box
                    onClick={() => toggleCategory(cat)}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5,
                      cursor: 'pointer', userSelect: 'none',
                      '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' }, borderRadius: `${c.radius.sm}px`,
                    }}
                  >
                    {isCollapsed
                      ? <KeyboardArrowRightIcon sx={{ fontSize: 16, color: c.text.ghost }} />
                      : <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost }} />}
                    <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {cat}
                    </Typography>
                    <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, ml: 0.5 }}>({group.length})</Typography>
                  </Box>
                  <Collapse in={!isCollapsed}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mt: 0.25 }}>
                      {group.map((sk) => (
                        <SidebarRow
                          key={sk.name}
                          label={sk.name}
                          selected={isSelected('registry', sk.name)}
                          onClick={() => selectRegistry(sk.name)}
                        />
                      ))}
                    </Box>
                  </Collapse>
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      {/* ─── Right Detail Panel ─── */}
      <Box sx={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', bgcolor: 'transparent' }}>
        {selection?.type === 'builder-preview' && builderPreview ? (
          <Box sx={{ p: 4, pb: 3, maxWidth: 1100, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, flexShrink: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: c.text.primary, fontFamily: c.font.sans }}>
                  {builderPreview.name || 'Untitled Skill'}
                </Typography>
                <Chip
                  label="AI Preview"
                  size="small"
                  sx={{
                    bgcolor: `${c.accent.primary}15`,
                    color: c.accent.primary,
                    fontWeight: 600,
                    fontSize: '0.68rem',
                    height: 22,
                  }}
                />
              </Box>
            </Box>

            {builderPreview.command && (
              <Box sx={{ mb: 1.5, flexShrink: 0 }}>
                <Chip
                  icon={<TerminalIcon sx={{ fontSize: 14 }} />}
                  label={`/${builderPreview.command}`}
                  size="small"
                  sx={{
                    bgcolor: 'rgba(174,86,48,0.08)', color: c.accent.primary,
                    fontWeight: 500, fontSize: '0.78rem', height: 26,
                  }}
                />
              </Box>
            )}

            <Box sx={{ mb: 1, flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost }}>
                Generated by <strong style={{ color: c.accent.primary, fontWeight: 600 }}>Skill Builder</strong>
              </Typography>
            </Box>

            {builderPreview.description && (
              <Box sx={{ mb: 2, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost, mb: 0.5 }}>Description</Typography>
                <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.6 }}>
                  {builderPreview.description}
                </Typography>
              </Box>
            )}

            <ContentPreview content={builderPreview.content} />
          </Box>
        ) : !selection ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: c.text.ghost, gap: 2 }}>
            <DescriptionIcon sx={{ fontSize: 48, opacity: 0.3 }} />
            <Typography sx={{ fontSize: '0.9rem' }}>Select a skill to view its details</Typography>
          </Box>
        ) : selection.type === 'registry' ? (
          regDetailLoading && !selectedReg ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 12 }}>
              <CircularProgress size={24} sx={{ color: c.accent.primary }} />
            </Box>
          ) : selectedReg ? (
            <Box sx={{ p: 4, pb: 3, maxWidth: 1100, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              {/* Header row: name + actions */}
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: c.text.primary, fontFamily: c.font.sans }}>
                  {selectedReg.name}
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<DownloadIcon sx={{ fontSize: 15 }} />}
                    onClick={handleInstall}
                    sx={{
                      bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed },
                      textTransform: 'none', borderRadius: `${c.radius.md}px`, px: 2, py: 0.5,
                      fontSize: '0.8rem', fontWeight: 600, boxShadow: 'none',
                    }}
                  >
                    Install
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<EditIcon sx={{ fontSize: 15 }} />}
                    onClick={handleEditInstall}
                    sx={{
                      borderColor: c.border.strong, color: c.text.secondary,
                      '&:hover': { borderColor: c.accent.primary, color: c.accent.primary, bgcolor: 'rgba(174,86,48,0.04)' },
                      textTransform: 'none', borderRadius: `${c.radius.md}px`, px: 2, py: 0.5,
                      fontSize: '0.8rem', fontWeight: 600,
                    }}
                  >
                    Edit & Install
                  </Button>
                  {selectedReg.repositoryUrl && (
                    <Tooltip title="View on GitHub">
                      <IconButton
                        size="small"
                        component="a"
                        href={selectedReg.repositoryUrl}
                        sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
                      >
                        <OpenInNewIcon sx={{ fontSize: 18 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Box>

              <Box sx={{ mb: 1, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost }}>Added by <strong style={{ color: c.text.secondary, fontWeight: 600 }}>Anthropic</strong></Typography>
              </Box>

              <Box sx={{ mb: 2, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost, mb: 0.5 }}>Description</Typography>
                <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.6 }}>
                  {selectedReg.description}
                </Typography>
              </Box>

              <ContentPreview content={selectedReg.content} />
            </Box>
          ) : null
        ) : selectedLocal ? (
          <Box sx={{ p: 4, pb: 3, maxWidth: 1100, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            {/* Header row: name + actions */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, flexShrink: 0 }}>
              <Typography sx={{ fontSize: '1.4rem', fontWeight: 700, color: c.text.primary, fontFamily: c.font.sans }}>
                {selectedLocal.name}
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                <Tooltip title="Edit">
                  <IconButton size="small" onClick={() => openEdit(selectedLocal)} sx={{ color: c.text.tertiary, '&:hover': { color: c.accent.primary } }}>
                    <EditIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton size="small" onClick={() => handleDelete(selectedLocal.id)} sx={{ color: c.text.tertiary, '&:hover': { color: c.status.error } }}>
                    <DeleteIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>

            {selectedLocal.command && (
              <Box sx={{ mb: 1.5, flexShrink: 0 }}>
                <Chip
                  icon={<TerminalIcon sx={{ fontSize: 14 }} />}
                  label={`/${selectedLocal.command}`}
                  size="small"
                  sx={{
                    bgcolor: 'rgba(174,86,48,0.08)', color: c.accent.primary,
                    fontWeight: 500, fontSize: '0.78rem', height: 26,
                  }}
                />
              </Box>
            )}

            <Box sx={{ mb: 1, flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost }}>Added by <strong style={{ color: c.text.secondary, fontWeight: 600 }}>You</strong></Typography>
            </Box>

            {selectedLocal.description && (
              <Box sx={{ mb: 2, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost, mb: 0.5 }}>Description</Typography>
                <Typography sx={{ fontSize: '0.88rem', color: c.text.secondary, lineHeight: 1.6 }}>
                  {selectedLocal.description}
                </Typography>
              </Box>
            )}

            <ContentPreview content={selectedLocal.content} />
          </Box>
        ) : null}
      </Box>

      {/* ─── Create/Edit Dialog ─── */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: `${c.radius.lg}px`, border: `${c.border.width} solid ${c.border.subtle}`, boxShadow: c.shadow.lg },
        }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, fontFamily: c.font.sans }}>
          {editingId ? 'Edit Skill' : 'New Skill'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            fullWidth
            size="small"
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.secondary } }}
          />
          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            fullWidth
            size="small"
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.secondary } }}
          />
          <TextField
            label="Command (slash command name)"
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            fullWidth
            size="small"
            placeholder="e.g. my-skill"
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.secondary } }}
          />
          <TextField
            label="Content (Markdown)"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            fullWidth
            multiline
            minRows={12}
            maxRows={24}
            sx={{
              '& .MuiOutlinedInput-root': {
                bgcolor: c.bg.secondary, fontFamily: c.font.mono, fontSize: '0.85rem',
              },
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!form.name || !form.content}
            sx={{
              bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed },
              textTransform: 'none', borderRadius: `${c.radius.md}px`,
            }}
          >
            {editingId ? 'Save Changes' : 'Create Skill'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ─── Skill Builder Chat ─── */}
      <SkillBuilderChat
        onSkillPreview={handleBuilderPreview}
        onSkillSaved={handleBuilderSaved}
        expanded={builderOpen}
        onExpandedChange={setBuilderOpen}
      />

      {/* ─── Snackbar ─── */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ open: false, message: '' })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar({ open: false, message: '' })}
          severity="success"
          sx={{ bgcolor: c.status.successBg, color: c.status.success, border: `1px solid rgba(38,91,25,0.25)` }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Skills;
