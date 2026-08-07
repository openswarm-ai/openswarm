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
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ShareIcon from '@mui/icons-material/Share';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import TerminalIcon from '@mui/icons-material/Terminal';
import DescriptionIcon from '@mui/icons-material/Description';
import SearchIcon from '@mui/icons-material/Search';
import DownloadIcon from '@mui/icons-material/Download';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
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
import { fetchSkillUpdates, updateInstalledSkill } from '@/shared/state/skillRegistrySlice';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { requestShare } from '@/app/components/share/ShareRequestHost';
import { API_BASE } from '@/shared/config';
import { IMPORT_OPEN_EVENT } from '@/app/components/share/ImportEntryPoint';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import SkillBuilderChat, { SkillPreviewData } from './SkillBuilderChat';
import UploadSkillDialog from '../Directory/dialogs/UploadSkillDialog';
import DriveFolderUploadOutlinedIcon from '@mui/icons-material/DriveFolderUploadOutlined';

interface SkillForm {
  name: string;
  description: string;
  content: string;
  command: string;
}

type Selection =
  | { type: 'local'; id: string }
  | { type: 'builder-preview' }
  | null;

const emptyForm: SkillForm = { name: '', description: '', content: '', command: '' };

// One naming grammar everywhere: skills read as kebab slugs (the Directory grid's /slug style), whatever casing they were authored with.
const skillSlug = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-');

interface SkillsProps {
  /** Provided when hosted inside the Marketplace: Browse switches the view in place instead of opening a nested dialog. */
  onBrowseDirectory?: () => void;
  /** Skill to land on when returning from the Marketplace browse grid. */
  focusSkillId?: string | null;
}

const Skills: React.FC<SkillsProps> = ({ onBrowseDirectory, focusSkillId }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { items, loading } = useAppSelector((s) => s.skills);
  const regOutdated = useAppSelector((s) => s.skillRegistry.outdated);
  const localSkills = Object.values(items);

  const [selection, setSelection] = useState<Selection>(null);
  const [searchFilter, setSearchFilter] = useState('');

  const [contentView, setContentView] = useState<'preview' | 'raw'>('preview');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SkillForm>(emptyForm);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string }>({ open: false, message: '' });
  const [builderPreview, setBuilderPreview] = useState<SkillPreviewData | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addMenuAnchor, setAddMenuAnchor] = useState<null | HTMLElement>(null);
  const [detailMenuAnchor, setDetailMenuAnchor] = useState<null | HTMLElement>(null);

  useEffect(() => {
    if (focusSkillId) setSelection({ type: 'local', id: focusSkillId });
  }, [focusSkillId]);

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
    dispatch(fetchSkillUpdates());
  }, [dispatch]);

  const filteredLocal = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return localSkills;
    return localSkills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [localSkills, searchFilter]);

  const selectLocal = (id: string) => {
    setSelection({ type: 'local', id });
  };

  const selectedLocal: Skill | null =
    selection?.type === 'local' ? items[selection.id] ?? null : null;

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

  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const handleUpdate = async (skill: Skill) => {
    setUpdatingId(skill.id);
    let result: { secret_findings: string[] } | null = null;
    try {
      result = await dispatch(updateInstalledSkill(skill.id)).unwrap();
    } catch (e) {
      const msg = (e as { message?: string })?.message || 'unknown error';
      setSnackbar({ open: true, message: `Update failed: ${msg}` });
      setUpdatingId(null);
      return;
    }
    await Promise.all([dispatch(fetchSkills()), dispatch(fetchSkillUpdates())]);
    setUpdatingId(null);
    const flagged = result?.secret_findings?.length
      ? ` (heads up: the update ships ${result.secret_findings.length} file(s) with secret-shaped content)`
      : '';
    setSnackbar({ open: true, message: `Updated "${skillSlug(skill.name)}" to the latest version${flagged}` });
  };

  // claude.ai's content card header: [SKILL.md v] file picker + "N files" + eye/code toggles. Single-file skills hide the picker.
  const ContentPreview: React.FC<{ content: string; skillId?: string; multiFile?: boolean }> = ({ content, skillId, multiFile }) => {
    const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
    const [selectedPath, setSelectedPath] = useState('SKILL.md');
    const [fileMenuAnchor, setFileMenuAnchor] = useState<null | HTMLElement>(null);
    useEffect(() => {
      setFiles([]);
      setSelectedPath('SKILL.md');
      if (!skillId || !multiFile) return;
      let stale = false;
      void fetch(`${API_BASE}/skills/${skillId}/files`)
        .then((res) => (res.ok ? res.json() : { files: [] }))
        .then((data: { files?: { path: string; content: string }[] }) => { if (!stale) setFiles(data.files ?? []); })
        .catch(() => { /* picker quietly falls back to SKILL.md */ });
      return () => { stale = true; };
    }, [skillId, multiFile]);
    const selected = files.find((f) => f.path === selectedPath);
    const shownContent = selected ? selected.content : content;
    const isMarkdown = selectedPath.toLowerCase().endsWith('.md');
    const view = isMarkdown ? contentView : 'raw';
    const iconBtnSx = (active: boolean) => ({
      color: active ? c.text.primary : c.text.tertiary,
      bgcolor: active ? c.bg.secondary : 'transparent',
      borderRadius: `${c.radius.sm}px`,
      '&:hover': { color: c.text.primary },
    });
    return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {files.length > 1 ? (
            <>
              <Button
                size="small"
                endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 15 }} />}
                onClick={(e: React.MouseEvent<HTMLElement>) => setFileMenuAnchor(e.currentTarget)}
                sx={{
                  textTransform: 'none', fontSize: '0.75rem', fontWeight: 600, px: 1.25, py: 0.3,
                  color: c.text.primary, bgcolor: c.bg.secondary, borderRadius: `${c.radius.md}px`,
                  fontFamily: c.font.mono, '&:hover': { bgcolor: c.bg.elevated },
                }}
              >
                {selectedPath}
              </Button>
              <Menu
                anchorEl={fileMenuAnchor}
                open={!!fileMenuAnchor}
                onClose={() => setFileMenuAnchor(null)}
                PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, mt: 0.5, minWidth: 200 } }}
              >
                {files.map((f) => (
                  <MenuItem
                    key={f.path}
                    onClick={() => { setSelectedPath(f.path); setFileMenuAnchor(null); }}
                    sx={{ fontSize: '0.8125rem', fontFamily: c.font.mono, color: f.path === selectedPath ? c.text.primary : c.text.secondary, '&:hover': { bgcolor: c.bg.secondary } }}
                  >
                    {f.path}
                  </MenuItem>
                ))}
              </Menu>
              <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>
                {files.length} files
              </Typography>
            </>
          ) : null}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.25 }}>
          <Tooltip title="Preview">
            <span>
              <IconButton size="small" disabled={!isMarkdown} onClick={() => setContentView('preview')} sx={iconBtnSx(view === 'preview')}>
                <VisibilityIcon sx={{ fontSize: 15 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Raw">
            <IconButton size="small" onClick={() => setContentView('raw')} sx={iconBtnSx(view === 'raw')}>
              <CodeIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {view === 'raw' ? (
        <Box sx={{
          flex: 1, minHeight: 0,
          bgcolor: c.bg.secondary,
          borderRadius: `${c.radius.md}px`, p: 2.5,
          overflow: 'auto',
          '&::-webkit-scrollbar': { width: 5 },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
        }}>
          <Typography component="pre" sx={{
            color: c.text.secondary, fontSize: '0.8125rem', fontFamily: c.font.mono,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', m: 0, lineHeight: 1.65,
          }}>
            {shownContent}
          </Typography>
        </Box>
      ) : (
        <Box sx={{
          flex: 1, minHeight: 0,
          bgcolor: c.bg.elevated,
          borderRadius: `${c.radius.md}px`, p: 3,
          overflow: 'auto',
          '&::-webkit-scrollbar': { width: 5 },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
          '& h1': { fontSize: '1.375rem', fontWeight: 700, color: c.text.primary, mt: 0, mb: 1.5, fontFamily: c.font.sans },
          '& h2': { fontSize: '1.125rem', fontWeight: 600, color: c.text.primary, mt: 2, mb: 1, fontFamily: c.font.sans },
          '& h3': { fontSize: '1rem', fontWeight: 600, color: c.text.primary, mt: 1.5, mb: 0.75, fontFamily: c.font.sans },
          '& p': { fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.7, mb: 1.5 },
          '& ul, & ol': { pl: 2.5, mb: 1.5, '& li': { fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.7, mb: 0.5 } },
          '& code': { fontFamily: c.font.mono, fontSize: '0.8125rem', bgcolor: 'rgba(0,0,0,0.04)', px: 0.5, py: 0.15, borderRadius: `${c.radius.xs}px` },
          '& pre': { bgcolor: c.bg.secondary, borderRadius: `${c.radius.sm}px`, p: 2, mb: 1.5, overflow: 'auto',
            '& code': { bgcolor: 'transparent', color: c.text.secondary, px: 0, py: 0 },
          },
          '& hr': { border: 'none', my: 3 },
          '& a': { color: c.accent.primary, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
          '& strong': { fontWeight: 600, color: c.text.primary },
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{shownContent}</ReactMarkdown>
        </Box>
      )}
    </Box>
    );
  };

  const fmtUpdated = (epoch?: number): string =>
    epoch ? new Date(epoch * 1000).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : '';
  const authorOf = (sk: Skill): string =>
    sk.built_in ? 'OpenSwarm' : /anthropic/i.test(sk.source || '') ? 'Anthropic' : sk.source ? sk.source.split('/')[0] : 'You';
  const detailOpen = (selection?.type === 'builder-preview' && !!builderPreview) || !!selectedLocal;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', bgcolor: c.bg.page }}>
      {!detailOpen ? (
        <>
        {/* claude.ai's Skills header grammar: search icon, Browse, Add menu (Create with Claude / Write skill instructions / Upload a skill), plus our Import .swarm row. */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.75, px: 1.5, pt: 1.5, pb: 1 }}>
          <Tooltip title="Search">
            <IconButton
              size="small"
              onClick={() => setSearchFilter((p) => (p === '' ? ' ' : ''))}
              sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
            >
              <SearchIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Button
            size="small"
            onClick={() => onBrowseDirectory?.()}
            sx={{
              textTransform: 'none', fontSize: '0.8125rem', fontWeight: 600, px: 1.5, py: 0.4,
              color: c.text.primary, bgcolor: c.bg.secondary, borderRadius: `${c.radius.md}px`,
              '&:hover': { bgcolor: c.bg.elevated },
            }}
          >
            Browse
          </Button>
          <Button
            size="small"
            endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
            onClick={(e: React.MouseEvent<HTMLElement>) => setAddMenuAnchor(e.currentTarget)}
            sx={{
              textTransform: 'none', fontSize: '0.8125rem', fontWeight: 600, px: 1.5, py: 0.4,
              color: c.text.primary, bgcolor: c.bg.secondary, borderRadius: `${c.radius.md}px`,
              '&:hover': { bgcolor: c.bg.elevated },
            }}
          >
            Add
          </Button>
          <Menu
            anchorEl={addMenuAnchor}
            open={!!addMenuAnchor}
            onClose={() => setAddMenuAnchor(null)}
            PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, mt: 0.5, minWidth: 220 } }}
          >
            <MenuItem onClick={() => { setAddMenuAnchor(null); setBuilderOpen(true); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <AutoFixHighIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Create with Claude
            </MenuItem>
            <MenuItem onClick={() => { setAddMenuAnchor(null); openCreate(); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <DescriptionIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Write skill instructions
            </MenuItem>
            <MenuItem onClick={() => { setAddMenuAnchor(null); setUploadOpen(true); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <DriveFolderUploadOutlinedIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Upload a skill
            </MenuItem>
            <MenuItem onClick={() => { setAddMenuAnchor(null); window.dispatchEvent(new CustomEvent(IMPORT_OPEN_EVENT)); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <UploadFileIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Import .swarm
            </MenuItem>
          </Menu>
        </Box>

        <Collapse in={searchFilter !== ''} timeout={0} unmountOnExit>
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
                  bgcolor: c.bg.surface, borderRadius: `${c.radius.sm}px`, fontSize: '0.8125rem',
                  '& fieldset': { borderColor: c.border.medium },
                },
              }}
            />
          </Box>
        </Collapse>
        {/* claude.ai's Skills settings body: a clean table of INSTALLED skills; browsing lives in the Directory. */}
        <Box sx={{ flex: 1, overflow: 'auto', px: 3, pb: 3, '&::-webkit-scrollbar': { width: 5 }, '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 } }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px', px: 1, pb: 1, borderBottom: `1px solid ${c.border.medium}` }}>
            <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>Skill</Typography>
            <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>Last updated</Typography>
            <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>Author</Typography>
          </Box>
          {loading && localSkills.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
              <CircularProgress size={22} sx={{ color: c.accent.primary }} />
            </Box>
          ) : filteredLocal.length === 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 8, gap: 1.5, color: c.text.ghost }}>
              <DescriptionIcon sx={{ fontSize: 40, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.875rem' }}>No skills yet. Browse the marketplace or add your own.</Typography>
            </Box>
          ) : filteredLocal.map((sk) => (
            <Box
              key={sk.id}
              onClick={() => selectLocal(sk.id)}
              sx={{
                display: 'grid', gridTemplateColumns: '1fr 120px 120px', alignItems: 'center',
                px: 1, py: 1.4, borderBottom: `1px solid ${c.border.subtle}`, cursor: 'pointer',
                '&:hover': { bgcolor: c.bg.secondary },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: '0.875rem', color: c.text.primary, fontWeight: 500 }}>{skillSlug(sk.name)}</Typography>
                {sk.enabled === false && (
                  <Typography sx={{ fontSize: '0.6875rem', color: c.text.ghost, flexShrink: 0 }}>Disabled</Typography>
                )}
                {regOutdated.includes(sk.id) && (
                  <Tooltip title="Update available"><Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: c.status.warning, flexShrink: 0 }} /></Tooltip>
                )}
              </Box>
              <Typography sx={{ fontSize: '0.8125rem', color: c.text.tertiary }}>{fmtUpdated(sk.updated_at)}</Typography>
              <Typography sx={{ fontSize: '0.8125rem', color: c.text.tertiary }}>{authorOf(sk)}</Typography>
            </Box>
          ))}
        </Box>
        </>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Box sx={{ px: 4, pt: 2, flexShrink: 0 }}>
            <Box
              role="button"
              onClick={() => setSelection(null)}
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, cursor: 'pointer', color: c.text.secondary, '&:hover': { color: c.text.primary } }}
            >
              <ArrowBackIcon sx={{ fontSize: 16 }} />
              <Typography sx={{ fontSize: '0.875rem', fontWeight: 600 }}>Skills</Typography>
            </Box>
          </Box>
          {selection?.type === 'builder-preview' && builderPreview ? (
            <Box sx={{ p: 4, pb: 3, maxWidth: 1100, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5, flexShrink: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Typography sx={{ fontSize: '1.375rem', fontWeight: 700, color: c.text.primary, fontFamily: c.font.sans }}>
                  {builderPreview.name || 'Untitled Skill'}
                </Typography>
                <Chip
                  label="AI Preview"
                  size="small"
                  sx={{
                    bgcolor: `${c.accent.primary}15`,
                    color: c.accent.primary,
                    fontWeight: 600,
                    fontSize: '0.6875rem',
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
                    fontWeight: 500, fontSize: '0.75rem', height: 26,
                  }}
                />
              </Box>
            )}

            <Box sx={{ mb: 1, flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost }}>
                Generated by <strong style={{ color: c.accent.primary, fontWeight: 600 }}>Skill Builder</strong>
              </Typography>
            </Box>

            {builderPreview.description && (
              <Box sx={{ mb: 2, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.6 }}>
                  {builderPreview.description}
                </Typography>
              </Box>
            )}

            <ContentPreview content={builderPreview.content} />
          </Box>
          ) : selectedLocal ? (
            <Box sx={{ p: 4, pb: 3, maxWidth: 1100, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            {/* claude.ai detail chrome: title + info, byline underneath, enable toggle + kebab on the right. */}
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1, flexShrink: 0 }}>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography sx={{ fontSize: '1.375rem', fontWeight: 700, color: c.text.primary, fontFamily: c.font.sans }}>
                    {skillSlug(selectedLocal.name)}
                  </Typography>
                  {selectedLocal.command && (
                    <Tooltip title={`Slash command: /${selectedLocal.command}`}>
                      <InfoOutlinedIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                    </Tooltip>
                  )}
                  {regOutdated.includes(selectedLocal.id) && (
                    <Chip
                      label="Update available"
                      size="small"
                      sx={{ bgcolor: `${c.status.warning}22`, color: c.status.warning, fontWeight: 600, fontSize: '0.6875rem', height: 20 }}
                    />
                  )}
                </Box>
                <Typography sx={{ fontSize: '0.75rem', color: c.text.ghost, mt: 0.25 }}>
                  by {selectedLocal.built_in ? 'OpenSwarm' : /anthropic/i.test(selectedLocal.source || '') ? 'Anthropic' : selectedLocal.source ? selectedLocal.source.split('/')[0] : 'You'}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexShrink: 0 }}>
                <Tooltip title={selectedLocal.enabled === false ? 'Enable skill' : 'Disable skill'}>
                  <Switch
                    size="small"
                    checked={selectedLocal.enabled !== false}
                    onChange={() => { void dispatch(updateSkill({ id: selectedLocal.id, enabled: selectedLocal.enabled === false })); }}
                  />
                </Tooltip>
                <IconButton size="small" onClick={(e: React.MouseEvent<HTMLElement>) => setDetailMenuAnchor(e.currentTarget)} sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
                  <MoreHorizIcon sx={{ fontSize: 18 }} />
                </IconButton>
                <Menu
                  anchorEl={detailMenuAnchor}
                  open={!!detailMenuAnchor}
                  onClose={() => setDetailMenuAnchor(null)}
                  PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: `${c.radius.md}px`, mt: 0.5, minWidth: 180 } }}
                >
                  <MenuItem onClick={() => { setDetailMenuAnchor(null); openEdit(selectedLocal); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
                    <EditIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                    Edit
                  </MenuItem>
                  <MenuItem onClick={() => { setDetailMenuAnchor(null); requestShare({ kind: 'skill', id: selectedLocal.id, name: selectedLocal.name }); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
                    <ShareIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                    Share as .swarm…
                  </MenuItem>
                  {regOutdated.includes(selectedLocal.id) && (
                    <MenuItem disabled={updatingId === selectedLocal.id} onClick={() => { setDetailMenuAnchor(null); void handleUpdate(selectedLocal); }} sx={{ fontSize: '0.875rem', color: c.text.primary, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
                    <DownloadIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                      {updatingId === selectedLocal.id ? 'Updating…' : 'Update to latest'}
                    </MenuItem>
                  )}
                  {!selectedLocal.built_in && (
                    <MenuItem onClick={() => { setDetailMenuAnchor(null); void handleDelete(selectedLocal.id); }} sx={{ fontSize: '0.875rem', color: c.status.error, gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
                      <DeleteIcon sx={{ fontSize: 16, color: c.status.error }} />
                      Delete
                    </MenuItem>
                  )}
                </Menu>
              </Box>
            </Box>

            {selectedLocal.description && (
              <Box sx={{ mb: 2, flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.875rem', color: c.text.secondary, lineHeight: 1.6 }}>
                  {selectedLocal.description}
                </Typography>
              </Box>
            )}

            <ContentPreview content={selectedLocal.content} skillId={selectedLocal.id} multiFile={selectedLocal.has_supporting_files} />
          </Box>
          ) : null}
        </Box>
      )}

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
          {editingId ? 'Edit skill' : 'Write skill instructions'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField
            label="Skill name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            fullWidth
            size="small"
            placeholder="weekly-status-report"
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.secondary } }}
          />
          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            fullWidth
            size="small"
            placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
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
            label="Instructions"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            fullWidth
            multiline
            minRows={12}
            maxRows={24}
            placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff..."
            sx={{
              '& .MuiOutlinedInput-root': {
                bgcolor: c.bg.secondary, fontFamily: c.font.mono, fontSize: '0.875rem',
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
            {editingId ? 'Save Changes' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      <UploadSkillDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={(name) => {
          onboardingBus.emit('skill:installed');
          setSnackbar({ open: true, message: `Uploaded "${name}"` });
        }}
      />

      <SkillBuilderChat
        onSkillPreview={handleBuilderPreview}
        onSkillSaved={handleBuilderSaved}
        expanded={builderOpen}
        onExpandedChange={setBuilderOpen}
      />

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
