import React, { useState, useMemo, useEffect } from 'react';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import StopIcon from '@mui/icons-material/Stop';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import { useElementSelection } from '@/app/components/ElementSelectionContext';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { LIST_MODES } from '@/shared/state/modesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ContextRing from './ContextRing';

const ICON_MAP: Record<string, React.ReactNode> = {
  smart_toy: <SmartToyOutlinedIcon sx={{ fontSize: 14 }} />,
  question_answer: <QuestionAnswerOutlinedIcon sx={{ fontSize: 14 }} />,
  map: <MapOutlinedIcon sx={{ fontSize: 14 }} />,
  category: <CategoryOutlinedIcon sx={{ fontSize: 14 }} />,
  tune: <TuneOutlinedIcon sx={{ fontSize: 14 }} />,
};
const FALLBACK_MODE_BASE = { label: 'Agent', icon: ICON_MAP.smart_toy };
const FALLBACK_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet 4.6', context_window: 1_000_000 },
  { value: 'opus', label: 'Claude Opus 4.6', context_window: 1_000_000 },
  { value: 'haiku', label: 'Claude Haiku 4.5', context_window: 200_000 },
];

interface Props {
  mode: string; onModeChange: (mode: string) => void;
  model: string; onModelChange: (model: string) => void;
  provider?: string; onProviderChange?: (provider: string) => void;
  contextEstimate?: { used: number; limit: number };
  ownerId: string; sessionId?: string;
  autoRunMode?: boolean; hasContent: boolean;
  isRunning?: boolean; disabled?: boolean;
  onSend: () => void; onStop?: () => void;
  addImageFiles: (files: FileList | File[]) => void;
  uploadAndAttachFiles: (files: File[]) => void;
  generalFileInputRef: React.RefObject<HTMLInputElement | null>;
  queueLength?: number;
}

const ModelModeSelector: React.FC<Props> = ({
  mode, onModeChange, model, onModelChange, provider, onProviderChange,
  contextEstimate, ownerId, sessionId,
  autoRunMode, hasContent, isRunning, disabled, onSend, onStop,
  addImageFiles, uploadAndAttachFiles, generalFileInputRef, queueLength = 0,
}) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const elementSelection = useElementSelection();
  const modesMap = useAppSelector((s) => s.modes.items);
  const modelsByProvider = useAppSelector((s) => s.models.byProvider);
  const modelsLoaded = useAppSelector((s) => s.models.loaded);
  const modesArr = useMemo(() => Object.values(modesMap), [modesMap]);
  const [modeAnchor, setModeAnchor] = useState<HTMLElement | null>(null);
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => { if (modesArr.length === 0) dispatch(LIST_MODES()); }, [dispatch, modesArr.length]);

  const allModelOptions = useMemo(() => {
    if (!modelsLoaded || Object.keys(modelsByProvider).length === 0) {
      return { flat: FALLBACK_MODELS.map(m => ({ ...m, provider: 'Anthropic' })), grouped: { Anthropic: FALLBACK_MODELS } };
    }
    const flat: Array<{ value: string; label: string; context_window: number; provider: string }> = [];
    const grouped: Record<string, Array<{ value: string; label: string; context_window: number }>> = {};
    for (const [prov, models] of Object.entries(modelsByProvider)) {
      grouped[prov] = models.map(m => ({ value: m.value, label: m.label, context_window: m.context_window ?? 200_000 }));
      for (const m of models) flat.push({ value: m.value, label: m.label, context_window: m.context_window ?? 200_000, provider: prov });
    }
    return { flat, grouped };
  }, [modelsByProvider, modelsLoaded]);

  const currentMode = modesMap[mode];
  const FALLBACK_MODE = { ...FALLBACK_MODE_BASE, color: c.accent.primary };
  const modeConf = currentMode
    ? { label: currentMode.name, icon: ICON_MAP[currentMode.icon] || ICON_MAP.smart_toy, color: currentMode.color }
    : FALLBACK_MODE;

  const menuPaperProps = { sx: {
    bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: '10px',
    minWidth: 180, maxHeight: 400, boxShadow: c.shadow.lg,
    '& .MuiMenuItem-root': { fontSize: '0.8rem', color: c.text.secondary, py: 0.75, px: 1.5, '&:hover': { bgcolor: c.bg.secondary } },
  }};

  const isMySelectMode = elementSelection?.selectMode && elementSelection.activeOwnerId === ownerId;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 1, pb: 0.75, pt: 0 }}>
      <Box onClick={(e) => setModeAnchor(e.currentTarget)} sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.375,
        borderRadius: '999px', cursor: 'pointer', userSelect: 'none',
        color: modeConf.color, bgcolor: `${modeConf.color}14`,
        '&:hover': { bgcolor: `${modeConf.color}22` }, transition: 'background 0.15s',
      }}>
        {modeConf.icon}
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: 'inherit', lineHeight: 1 }}>{modeConf.label}</Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
      </Box>

      <Menu anchorEl={modeAnchor} open={Boolean(modeAnchor)} onClose={() => setModeAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: menuPaperProps }}>
        {modesArr.map((m) => (
          <MenuItem key={m.id} selected={mode === m.id} onClick={() => { onModeChange(m.id); setModeAnchor(null); }}>
            <ListItemIcon sx={{ color: m.color, minWidth: 28 }}>{ICON_MAP[m.icon] || ICON_MAP.smart_toy}</ListItemIcon>
            <ListItemText primary={m.name}
              slotProps={{ primary: { sx: { fontSize: '0.8rem', color: mode === m.id ? m.color : c.text.secondary } } }} />
          </MenuItem>
        ))}
      </Menu>

      <Box onClick={(e) => setModelAnchor(e.currentTarget)} sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.25, px: 0.75, py: 0.25,
        borderRadius: '6px', cursor: 'pointer', userSelect: 'none', color: c.text.muted,
        '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' }, transition: 'background 0.15s',
      }}>
        <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: 'inherit', lineHeight: 1 }}>
          {(() => { const m = allModelOptions.flat.find((m) => m.value === model); return m ? m.label : model; })()}
        </Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
      </Box>

      <Menu anchorEl={modelAnchor} open={Boolean(modelAnchor)} onClose={() => setModelAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: menuPaperProps }}>
        {Object.entries(allModelOptions.grouped).map(([prov, models]) => [
          <MenuItem key={`header-${prov}`} disabled sx={{ opacity: '0.7 !important', py: 0.5, px: 1.5, minHeight: 'auto' }}>
            <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: c.text.tertiary }}>{prov}</Typography>
          </MenuItem>,
          ...models.map((opt) => (
            <MenuItem key={opt.value} selected={model === opt.value} onClick={() => {
              onModelChange(opt.value);
              if (onProviderChange) {
                const provLower = prov.toLowerCase();
                const providerMap: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', google: 'gemini', xai: 'openrouter', meta: 'openrouter', deepseek: 'openrouter', mistral: 'openrouter', qwen: 'openrouter', cohere: 'openrouter' };
                onProviderChange(providerMap[provLower] || provLower);
              }
              setModelAnchor(null);
            }}>
              <ListItemText primary={opt.label}
                slotProps={{ primary: { sx: { fontSize: '0.8rem', color: model === opt.value ? c.text.primary : c.text.muted } } }} />
            </MenuItem>
          )),
        ]).flat()}
      </Menu>

      <Box sx={{ flex: 1 }} />

      {contextEstimate && (
        <ContextRing used={contextEstimate.used} limit={contextEstimate.limit}
          accentColor={c.accent.primary} trackColor={c.border.subtle} />
      )}

      {elementSelection && !autoRunMode && (
        <Tooltip title={isMySelectMode ? 'Exit select mode' : 'Select UI element'}>
          <IconButton size="small" onMouseDown={(e) => e.preventDefault()} onClick={() => {
            if (isMySelectMode) { elementSelection.setSelectMode(false); return; }
            if (elementSelection.activeOwnerId !== ownerId) elementSelection.clearOwnerElements(ownerId);
            elementSelection.setActiveOwnerId(ownerId);
            elementSelection.setExcludeSelectId(sessionId || null);
            elementSelection.setSelectMode(true);
          }} sx={{
            p: 0.5,
            ...(isMySelectMode
              ? { bgcolor: '#3b82f6', color: '#fff', '&:hover': { bgcolor: '#2563eb' },
                  animation: 'selectBtnPulse 2s ease-in-out infinite',
                  '@keyframes selectBtnPulse': { '0%, 100%': { boxShadow: '0 0 0 0 rgba(59,130,246,0.4)' }, '50%': { boxShadow: '0 0 0 4px rgba(59,130,246,0.1)' } } }
              : { color: c.text.tertiary, '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' } }),
            transition: 'background-color 0.15s, color 0.15s',
          }}>
            <AdsClickIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}

      <input ref={generalFileInputRef as React.RefObject<HTMLInputElement>} type="file" multiple hidden onChange={(e) => {
        if (!e.target.files) return;
        const all = Array.from(e.target.files);
        const imgs = all.filter((f) => f.type.startsWith('image/'));
        const rest = all.filter((f) => !f.type.startsWith('image/'));
        if (imgs.length > 0) addImageFiles(imgs);
        if (rest.length > 0) uploadAndAttachFiles(rest);
        e.target.value = '';
      }} />
      <Tooltip title="Attach file">
        <IconButton size="small" onClick={() => generalFileInputRef.current?.click()}
          sx={{ color: c.text.tertiary, p: 0.5, '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' } }}>
          <AttachFileIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>

      {!autoRunMode && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {hasContent && (
            <Tooltip title={isRunning ? 'Queue message' : 'Send message'}>
              <IconButton size="small" onClick={onSend} disabled={disabled}
                sx={{ bgcolor: c.accent.primary, color: c.text.inverse, p: 0.5, width: 26, height: 26,
                  '&:hover': { bgcolor: c.accent.hover }, '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
                  transition: c.transition }}>
                <ArrowUpwardIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          {isRunning ? (
            <Tooltip title="Stop agent">
              <IconButton size="small" onClick={onStop}
                sx={{ bgcolor: c.status.error, color: c.text.inverse, p: 0.5, width: 26, height: 26,
                  '&:hover': { bgcolor: c.status.error, opacity: 0.85 }, transition: c.transition }}>
                <StopIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          ) : !hasContent ? (
            <Tooltip title="Voice input (coming soon)">
              <span><IconButton size="small" disabled
                sx={{ color: c.text.tertiary, p: 0.5, '&.Mui-disabled': { color: c.text.ghost } }}>
                <MicNoneOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton></span>
            </Tooltip>
          ) : null}
        </Box>
      )}
    </Box>
  );
};

export default ModelModeSelector;
