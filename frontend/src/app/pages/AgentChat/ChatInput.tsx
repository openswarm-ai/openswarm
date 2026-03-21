import React, { useState, useRef, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import StopIcon from '@mui/icons-material/Stop';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import CloseIcon from '@mui/icons-material/Close';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import Modal from '@mui/material/Modal';
import CircularProgress from '@mui/material/CircularProgress';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import CommandPicker, { CommandPickerItem, getToolGroupIcon } from '@/app/components/CommandPicker';
import { useElementSelection, SelectedElement } from '@/app/components/ElementSelectionContext';
import { getClipboardCards, clearClipboard } from '@/shared/dashboardClipboard';
import { getWebview } from '@/shared/browserRegistry';
import { API_BASE } from '@/shared/config';
import { ContextPath } from '@/app/components/DirectoryBrowser';
import {
  SKILL_PILL_ATTR,
  AttachedSkill,
  createSkillPillElement,
  serializeEditorContent,
  detectEditorTrigger,
  TriggerState,
  EMPTY_TRIGGER,
} from '@/app/components/richEditorUtils';
import TemplateInvokeModal from './TemplateInvokeModal';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchModes } from '@/shared/state/modesSlice';
import { PromptTemplate } from '@/shared/state/templatesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface AttachedImage {
  data: string;
  media_type: string;
  preview: string;
}

export interface ForcedToolGroup {
  label: string;
  tools: string[];
  icon?: React.ReactNode;
  iconKey?: string;
}

export type { AttachedSkill } from '@/app/components/richEditorUtils';

interface Props {
  onSend: (message: string, images?: Array<{ data: string; media_type: string }>, contextPaths?: ContextPath[], forcedTools?: string[], attachedSkills?: Array<{ id: string; name: string; content: string }>, selectedBrowserIds?: string[]) => void;
  disabled?: boolean;
  mode: string;
  onModeChange: (mode: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  provider?: string;
  onProviderChange?: (provider: string) => void;
  isRunning?: boolean;
  onStop?: () => void;
  autoRunMode?: boolean;
  contextEstimate?: { used: number; limit: number };
  embedded?: boolean;
  autoFocus?: boolean;
  sessionId?: string;
  queueLength?: number;
}

export interface ChatInputHandle {
  getConfig: () => { prompt: string; contextPaths: ContextPath[]; forcedTools: ForcedToolGroup[] };
  setContent: (prompt: string, contextPaths?: ContextPath[], forcedTools?: ForcedToolGroup[]) => void;
}

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

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ContextRing: React.FC<{ used: number; limit: number; accentColor: string; trackColor: string }> = ({ used, limit, accentColor, trackColor }) => {
  if (used === 0) return null;
  const pct = Math.min((used / limit) * 100, 100);
  const size = 20;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);
  const tooltip = `${pct.toFixed(1)}% \u00B7 ${formatTokenCount(used)} / ${formatTokenCount(limit)} context used`;

  return (
    <Tooltip title={tooltip}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', p: 0.5 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={accentColor} strokeWidth={strokeWidth}
            strokeDasharray={circumference} strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </Box>
    </Tooltip>
  );
};

const ChatInput = forwardRef<ChatInputHandle, Props>(({ onSend, disabled, mode, onModeChange, model, onModelChange, provider, onProviderChange, isRunning, onStop, autoRunMode, contextEstimate, embedded, autoFocus, sessionId, queueLength = 0 }, ref) => {
  const c = useClaudeTokens();
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const generalFileInputRef = useRef<HTMLInputElement>(null);
  const dispatch = useAppDispatch();
  const elementSelection = useElementSelection();

  const fallbackOwnerIdRef = useRef(`input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const ownerId = sessionId || fallbackOwnerIdRef.current;

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  const [hasContent, setHasContent] = useState(false);
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const attachedSkillsRef = useRef(attachedSkills);
  attachedSkillsRef.current = attachedSkills;

  const [picker, setPicker] = useState<TriggerState>(EMPTY_TRIGGER);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);
  const templates = useAppSelector((state) => state.templates.items);
  const skills = useAppSelector((state) => state.skills.items);
  const modesMap = useAppSelector((state) => state.modes.items);
  const modesArr = useMemo(() => Object.values(modesMap), [modesMap]);
  const modelsByProvider = useAppSelector((state) => state.models.byProvider);
  const modelsLoaded = useAppSelector((state) => state.models.loaded);

  // Build flat model list with provider grouping
  const allModelOptions = useMemo(() => {
    if (!modelsLoaded || Object.keys(modelsByProvider).length === 0) {
      return { flat: FALLBACK_MODELS.map(m => ({ ...m, provider: 'Anthropic' })), grouped: { Anthropic: FALLBACK_MODELS } };
    }
    const flat: Array<{ value: string; label: string; context_window: number; provider: string }> = [];
    const grouped: Record<string, Array<{ value: string; label: string; context_window: number }>> = {};
    for (const [prov, models] of Object.entries(modelsByProvider)) {
      grouped[prov] = models.map(m => ({ value: m.value, label: m.label, context_window: m.context_window ?? 200_000 }));
      for (const m of models) {
        flat.push({ value: m.value, label: m.label, context_window: m.context_window ?? 200_000, provider: prov });
      }
    }
    return { flat, grouped };
  }, [modelsByProvider, modelsLoaded]);

  useEffect(() => {
    if (modesArr.length === 0) dispatch(fetchModes());
  }, [dispatch, modesArr.length]);

  const [images, setImages] = useState<AttachedImage[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [contextPaths, setContextPaths] = useState<ContextPath[]>([]);
  const [forcedTools, setForcedTools] = useState<ForcedToolGroup[]>([]);
  const [copiedPathIdx, setCopiedPathIdx] = useState<number | null>(null);

  useImperativeHandle(ref, () => ({
    getConfig: () => {
      const editor = editorRef.current;
      const prompt = editor ? serializeEditorContent(editor, attachedSkillsRef.current).trim() : '';
      return { prompt, contextPaths, forcedTools };
    },
    setContent: (prompt: string, newContextPaths?: ContextPath[], newForcedTools?: ForcedToolGroup[]) => {
      const editor = editorRef.current;
      if (editor) {
        editor.textContent = prompt;
        setHasContent(!!prompt);
      }
      if (newContextPaths) setContextPaths(newContextPaths);
      if (newForcedTools) setForcedTools(newForcedTools);
    },
  }), [contextPaths, forcedTools]);

  const [modeAnchor, setModeAnchor] = useState<HTMLElement | null>(null);
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);

  const currentMode = modesMap[mode];
  const FALLBACK_MODE = { ...FALLBACK_MODE_BASE, color: c.accent.primary };
  const modeConf = currentMode
    ? { label: currentMode.name, icon: ICON_MAP[currentMode.icon] || ICON_MAP.smart_toy, color: currentMode.color }
    : FALLBACK_MODE;

  const updateHasContent = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    const hasPills = editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null;
    setHasContent(text.trim().length > 0 || hasPills);
  }, []);

  const syncAttachedSkills = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const pillIds = new Set(
      Array.from(editor.querySelectorAll(`[${SKILL_PILL_ATTR}]`))
        .map((el) => el.getAttribute(SKILL_PILL_ATTR))
        .filter(Boolean) as string[],
    );
    setAttachedSkills((prev) => {
      const prevKeys = Object.keys(prev);
      if (prevKeys.length === pillIds.size && prevKeys.every((k) => pillIds.has(k))) return prev;
      const next: Record<string, AttachedSkill> = {};
      for (const [id, skill] of Object.entries(prev)) {
        if (pillIds.has(id)) next[id] = skill;
      }
      return next;
    });
  }, []);

  const removeSkillPill = useCallback((skillId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const pill = editor.querySelector(`[${SKILL_PILL_ATTR}="${skillId}"]`);
    if (pill) pill.remove();
    setAttachedSkills((prev) => {
      const { [skillId]: _, ...rest } = prev;
      return rest;
    });
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    const hasPills = editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null;
    setHasContent(text.trim().length > 0 || hasPills);
    editor.focus();
  }, []);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        setImages((prev) => [
          ...prev,
          { data: base64, media_type: file.type, preview: result },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const uploadAndAttachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));
      const resp = await fetch(`${API_BASE}/settings/upload-files`, {
        method: 'POST',
        body: formData,
      });
      if (!resp.ok) throw new Error('Upload failed');
      const data = await resp.json();
      const newPaths: ContextPath[] = (data.files || []).map((f: { path: string }) => ({
        path: f.path,
        type: 'file' as const,
      }));
      setContextPaths((prev) => [...prev, ...newPaths]);
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setIsUploading(false);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    const serialized = serializeEditorContent(editor, attachedSkillsRef.current);
    let trimmed = serialized.trim();
    if (!trimmed) return;

    const selectedEls = elementSelection?.elementsByOwner?.[ownerId] ?? [];
    let allImages = images.length > 0
      ? images.map(({ data, media_type }) => ({ data, media_type }))
      : [];

    if (selectedEls.length > 0) {
      const lines: string[] = ['\n\n---\nSelected UI Elements:\n'];
      for (let i = 0; i < selectedEls.length; i++) {
        const el = selectedEls[i];

        if (el.semanticType === 'browser-card' && el.semanticData?.selectId) {
          const wv = getWebview(el.semanticData.selectId as string);
          const url = wv ? (el.semanticData.url || wv.getURL()) : (el.semanticData.url || '');
          const title = wv ? (el.semanticData.name || wv.getTitle()) : (el.semanticLabel || '');
          lines.push(`${i + 1}. [Browser Card] ${title}`);
          lines.push(`   browser_id: ${el.semanticData.selectId}`);
          if (url) lines.push(`   URL: ${url}`);
          lines.push(`   (Use BrowserAgent with this browser_id to interact with it, or CreateBrowserAgent for a new browser)`);
        } else if (el.semanticType && el.semanticData) {
          const typeLabel = {
            'agent-card': 'Agent Card',
            'message': 'Message',
            'tool-call': 'Tool Call',
            'tool-group': 'Tool Group',
            'view-card': 'App Card',
            'browser-card': 'Browser Card',
            'dom-element': 'Element',
          }[el.semanticType] || el.semanticType;
          lines.push(`${i + 1}. [${typeLabel}] ${el.semanticLabel || ''}`);
          const { selectId, ...rest } = el.semanticData;
          if (selectId) lines.push(`   ID: ${selectId}`);
          const metaStr = Object.entries(rest)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(', ');
          if (metaStr) lines.push(`   ${metaStr}`);
          if (el.semanticType === 'agent-card' && selectId) {
            lines.push(`   (Use InvokeAgent with session_id "${selectId}" to query this agent with full conversation context)`);
          }
        } else {
          const styleStr = Object.entries(el.computedStyles)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ');
          lines.push(`${i + 1}. \`${el.selectorPath}\` (${el.tagName.toLowerCase()})`);
          lines.push(`   Selector: ${el.selectorPath}`);
          lines.push(`   HTML: ${el.outerHTML.length > 500 ? el.outerHTML.slice(0, 500) + '...' : el.outerHTML}`);
          if (styleStr) lines.push(`   Key styles: ${styleStr}`);
        }
        lines.push('');

        if (el.screenshot) {
          const base64 = el.screenshot.replace(/^data:image\/\w+;base64,/, '');
          allImages.push({ data: base64, media_type: 'image/png' });
        }
      }
      trimmed += lines.join('\n');
    }

    const sendImages = allImages.length > 0 ? allImages : undefined;
    const allForcedToolNames = forcedTools.flatMap((ft) => ft.tools);
    const currentSkills = Object.values(attachedSkillsRef.current);
    const sendSkills = currentSkills.length > 0
      ? currentSkills.map((s) => ({ id: s.id, name: s.name, content: s.content }))
      : undefined;
    const browserIds = selectedEls
      .filter((el) => el.semanticType === 'browser-card' && el.semanticData?.selectId)
      .map((el) => el.semanticData!.selectId as string);
    onSend(
      trimmed,
      sendImages,
      contextPaths.length > 0 ? contextPaths : undefined,
      allForcedToolNames.length > 0 ? allForcedToolNames : undefined,
      sendSkills,
      browserIds.length > 0 ? browserIds : undefined,
    );
    editor.innerHTML = '';
    setImages([]);
    setContextPaths([]);
    setForcedTools([]);
    setAttachedSkills({});
    setHasContent(false);
    elementSelection?.clearOwnerElements(ownerId);
  }, [disabled, images, contextPaths, forcedTools, onSend, elementSelection, ownerId]);

  const detectTrigger = useCallback(() => {
    const result = detectEditorTrigger();
    if (result) {
      setPicker(result);
    } else {
      setPicker((p) => ({ ...p, visible: false }));
    }
  }, []);

  const handleInput = useCallback(() => {
    updateHasContent();
    detectTrigger();
    syncAttachedSkills();
  }, [updateHasContent, detectTrigger, syncAttachedSkills]);

  const handleEditorClick = useCallback(() => {
    detectTrigger();
  }, [detectTrigger]);

  const handlePickerSelect = (item: CommandPickerItem) => {
    setPicker((p) => ({ ...p, visible: false }));
    const editor = editorRef.current;
    if (!editor) return;

    editor.focus();

    const { triggerNode, triggerOffset, filter } = picker;
    if (triggerNode && triggerNode.parentNode && editor.contains(triggerNode)) {
      const endOffset = Math.min(triggerOffset + 1 + filter.length, triggerNode.length);
      const range = document.createRange();
      range.setStart(triggerNode, triggerOffset);
      range.setEnd(triggerNode, endOffset);
      range.deleteContents();
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }

    if (item.type === 'template') {
      const tmpl = templates[item.id];
      if (!tmpl) return;
      if (tmpl.fields.length === 0) {
        document.execCommand('insertText', false, tmpl.template);
      } else {
        setSelectedTemplate(tmpl);
      }
    } else if (item.type === 'skill') {
      const skill = skills[item.id];
      if (!skill) return;
      if (editor.querySelector(`[${SKILL_PILL_ATTR}="${skill.id}"]`)) return;

      const pill = createSkillPillElement(
        { id: skill.id, name: skill.name, content: skill.content },
        removeSkillPill,
        c.font.mono,
        c.status.error,
      );

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode(pill);
        const spacer = document.createTextNode('\u200B');
        pill.after(spacer);
        const newRange = document.createRange();
        newRange.setStartAfter(spacer);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }

      setAttachedSkills((prev) => ({
        ...prev,
        [skill.id]: { id: skill.id, name: skill.name, content: skill.content },
      }));
    } else if (item.type === 'mode') {
      onModeChange(item.id);
    } else if (item.type === 'context') {
      if (item.command === 'file') {
        generalFileInputRef.current?.click();
      } else if (item.toolNames && item.toolNames.length > 0) {
        setForcedTools((prev) => [...prev, { label: item.name, tools: item.toolNames!, icon: item.icon, iconKey: item.iconKey }]);
      } else {
        document.execCommand('insertText', false, `@${item.command} `);
      }
    }

    updateHasContent();
    setTimeout(() => editor.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (picker.visible && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !autoRunMode) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const copied = getClipboardCards();
    if (copied.length > 0 && elementSelection) {
      e.preventDefault();
      for (const card of copied) {
        const semanticTypeMap: Record<string, SelectedElement['semanticType']> = {
          agent: 'agent-card',
          view: 'view-card',
          browser: 'browser-card',
        };
        const semanticType = semanticTypeMap[card.type];
        if (!semanticType) continue;
        const labelMap: Record<string, string> = {
          'agent-card': 'Agent',
          'view-card': 'View',
          'browser-card': 'Browser',
        };
        const semanticLabel = (labelMap[semanticType] || semanticType) + ': ' + card.name;
        const el: SelectedElement = {
          id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          selectorPath: `[data-select-type="${semanticType}"][data-select-id="${card.id}"]`,
          tagName: 'DIV',
          className: '',
          outerHTML: '',
          computedStyles: {},
          boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          semanticType,
          semanticLabel,
          semanticData: { ...card.meta, selectId: card.id },
        };
        elementSelection.addElementForOwner(ownerId, el);
      }
      clearClipboard();
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImageFiles(imageFiles);
      return;
    }
    e.preventDefault();
    const plain = e.clipboardData.getData('text/plain');
    if (plain) document.execCommand('insertText', false, plain);
  }, [addImageFiles, elementSelection, ownerId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files.length === 0) return;
    const allFiles = Array.from(e.dataTransfer.files);
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const otherFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0) addImageFiles(imageFiles);
    if (otherFiles.length > 0) uploadAndAttachFiles(otherFiles);
  }, [addImageFiles, uploadAndAttachFiles]);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const menuPaperProps = {
    sx: {
      bgcolor: c.bg.surface,
      border: `1px solid ${c.border.subtle}`,
      borderRadius: '10px',
      minWidth: 180,
      maxHeight: 400,
      boxShadow: c.shadow.lg,
      '& .MuiMenuItem-root': {
        fontSize: '0.8rem',
        color: c.text.secondary,
        py: 0.75,
        px: 1.5,
        '&:hover': { bgcolor: c.bg.secondary },
      },
    },
  };

  const selectedElements = elementSelection?.elementsByOwner?.[ownerId] ?? [];
  const hasAttachments = images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0 || selectedElements.length > 0;

  return (
    <Box
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        position: 'relative',
        ...(embedded
          ? {}
          : {
              mx: 1.5,
              mb: 1.5,
              borderRadius: '16px',
              border: isDragOver ? `1px solid ${c.accent.primary}` : `1px solid ${c.border.subtle}`,
              bgcolor: c.bg.surface,
              boxShadow: c.shadow.md,
              transition: 'border-color 0.15s',
            }),
      }}
    >
      {isDragOver && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(174,86,48,0.04)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            pointerEvents: 'none',
          }}
        >
          <AttachFileIcon sx={{ fontSize: 16, color: c.accent.primary, mr: 0.5 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>
            Drop files here
          </Typography>
        </Box>
      )}

      {isUploading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(174,86,48,0.04)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            pointerEvents: 'none',
          }}
        >
          <CircularProgress size={14} sx={{ color: c.accent.primary, mr: 1 }} />
          <Typography sx={{ color: c.accent.primary, fontSize: '0.85rem', fontWeight: 500 }}>
            Attaching files…
          </Typography>
        </Box>
      )}

      <CommandPicker
        trigger={picker.trigger}
        filter={picker.filter}
        onSelect={handlePickerSelect}
        onClose={() => setPicker((p) => ({ ...p, visible: false }))}
        visible={picker.visible}
      />

      {images.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            gap: 0.75,
            px: 1.5,
            pt: 1,
            pb: 0.5,
            overflowX: 'auto',
            '&::-webkit-scrollbar': { height: 4 },
            '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          }}
        >
          {images.map((img, idx) => (
            <Box
              key={idx}
              sx={{
                position: 'relative',
                width: 56,
                height: 56,
                flexShrink: 0,
                borderRadius: '8px',
                overflow: 'hidden',
                border: `1px solid ${c.border.subtle}`,
                cursor: 'pointer',
                transition: 'opacity 0.15s, transform 0.15s',
                '&:hover': { opacity: 0.85, transform: 'scale(1.04)' },
              }}
              onClick={() => setLightboxSrc(img.preview)}
            >
              <img
                src={img.preview}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                sx={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  width: 18,
                  height: 18,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  color: c.text.tertiary,
                  '&:hover': { bgcolor: c.bg.secondary, color: c.text.primary },
                }}
              >
                <CloseIcon sx={{ fontSize: 10 }} />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}

      {contextPaths.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: images.length > 0 ? 0.25 : 1, pb: 0 }}>
          {contextPaths.map((cp, idx) => {
            const label = cp.path.split('/').filter(Boolean).slice(-2).join('/');
            return (
              <Tooltip
                key={`${cp.path}-${idx}`}
                title={copiedPathIdx === idx ? 'Copied!' : cp.path}
                arrow
                placement="top"
                slotProps={{
                  tooltip: {
                    sx: {
                      fontFamily: c.font.mono,
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              >
                <Chip
                  icon={
                    cp.type === 'directory'
                      ? <FolderOpenIcon sx={{ fontSize: 14 }} />
                      : <InsertDriveFileOutlinedIcon sx={{ fontSize: 14 }} />
                  }
                  label={label}
                  size="small"
                  onClick={() => {
                    navigator.clipboard.writeText(cp.path);
                    setCopiedPathIdx(idx);
                    setTimeout(() => setCopiedPathIdx((cur) => cur === idx ? null : cur), 1200);
                  }}
                  onDelete={() => setContextPaths((prev) => prev.filter((_, i) => i !== idx))}
                  sx={{
                    bgcolor: `${c.accent.primary}12`,
                    color: c.accent.primary,
                    fontSize: '0.72rem',
                    fontFamily: c.font.mono,
                    height: 26,
                    maxWidth: 220,
                    cursor: 'pointer',
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    '& .MuiChip-deleteIcon': {
                      color: c.accent.primary,
                      fontSize: 16,
                      '&:hover': { color: c.status.error },
                    },
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}

      {forcedTools.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (images.length > 0 || contextPaths.length > 0) ? 0.25 : 1, pb: 0 }}>
          {forcedTools.map((ft, idx) => (
            <Chip
              key={`ft-${ft.label}-${idx}`}
              icon={<>{ft.icon || getToolGroupIcon(ft.iconKey || ft.label, 14)}</>}
              label={`@${ft.label.toLowerCase()}`}
              size="small"
              onDelete={() => setForcedTools((prev) => prev.filter((_, i) => i !== idx))}
              sx={{
                bgcolor: `${c.status.info}15`,
                color: c.status.info,
                fontSize: '0.72rem',
                fontFamily: c.font.mono,
                height: 26,
                maxWidth: 220,
                '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                '& .MuiChip-deleteIcon': {
                  color: c.status.info,
                  fontSize: 16,
                  '&:hover': { color: c.status.error },
                },
              }}
            />
          ))}
        </Box>
      )}

      {selectedElements.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0) ? 0.25 : 1, pb: 0 }}>
          {selectedElements.map((el) => {
            const chipLabel = el.semanticLabel
              ? el.semanticLabel
              : el.className
                ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}`
                : el.tagName.toLowerCase();
            const tooltipText = el.semanticType
              ? `${el.semanticType}: ${el.semanticLabel || el.selectorPath}`
              : el.selectorPath;
            return (
              <Tooltip
                key={el.id}
                title={tooltipText}
                arrow
                placement="top"
                slotProps={{
                  tooltip: {
                    sx: {
                      fontFamily: c.font.mono,
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              >
                <Chip
                  icon={<AdsClickIcon sx={{ fontSize: 14 }} />}
                  label={chipLabel}
                  size="small"
                  onDelete={() => elementSelection?.removeOwnerElement(ownerId, el.id)}
                  sx={{
                    bgcolor: 'rgba(59, 130, 246, 0.1)',
                    color: '#3b82f6',
                    fontSize: '0.72rem',
                    fontFamily: c.font.mono,
                    height: 26,
                    maxWidth: 220,
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    '& .MuiChip-deleteIcon': {
                      color: '#3b82f6',
                      fontSize: 16,
                      '&:hover': { color: c.status.error },
                    },
                    '& .MuiChip-icon': {
                      color: '#3b82f6',
                    },
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}

      <Box sx={{ px: 1.5, pt: hasAttachments ? 0.5 : 1.25, pb: 0.25, position: 'relative' }}>
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={handleInput}
          onClick={handleEditorClick}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          style={{
            width: '100%',
            minHeight: '1.5em',
            maxHeight: 200,
            overflowY: 'auto',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: c.text.primary,
            fontSize: '0.875rem',
            lineHeight: '1.5',
            fontFamily: 'inherit',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        />
        {!hasContent && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              padding: `${hasAttachments ? 4 : 10}px 12px`,
              color: c.text.tertiary,
              fontSize: '0.875rem',
              lineHeight: '1.5',
              fontFamily: 'inherit',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          >
            {disabled ? 'Agent is working...' : autoRunMode ? 'Describe what data to generate…' : isRunning ? (queueLength > 0 ? `${queueLength} queued — type another or wait…` : 'Agent is working — messages will queue…') : `${modeConf.label}, @ for context, / for commands`}
          </div>
        )}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 1,
          pb: 0.75,
          pt: 0,
        }}
      >
        <Box
          onClick={(e) => setModeAnchor(e.currentTarget)}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            py: 0.375,
            borderRadius: '999px',
            cursor: 'pointer',
            userSelect: 'none',
            color: modeConf.color,
            bgcolor: `${modeConf.color}14`,
            '&:hover': { bgcolor: `${modeConf.color}22` },
            transition: 'background 0.15s',
          }}
        >
          {modeConf.icon}
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 600, color: 'inherit', lineHeight: 1 }}>
            {modeConf.label}
          </Typography>
          <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
        </Box>

        <Menu
          anchorEl={modeAnchor}
          open={Boolean(modeAnchor)}
          onClose={() => setModeAnchor(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: menuPaperProps }}
        >
          {modesArr.map((m) => {
            const icon = ICON_MAP[m.icon] || ICON_MAP.smart_toy;
            return (
              <MenuItem
                key={m.id}
                selected={mode === m.id}
                onClick={() => {
                  onModeChange(m.id);
                  setModeAnchor(null);
                }}
              >
                <ListItemIcon sx={{ color: m.color, minWidth: 28 }}>
                  {icon}
                </ListItemIcon>
                <ListItemText
                  primary={m.name}
                  slotProps={{ primary: { sx: { fontSize: '0.8rem', color: mode === m.id ? m.color : c.text.secondary } } }}
                />
              </MenuItem>
            );
          })}
        </Menu>

        <Box
          onClick={(e) => setModelAnchor(e.currentTarget)}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.25,
            px: 0.75,
            py: 0.25,
            borderRadius: '6px',
            cursor: 'pointer',
            userSelect: 'none',
            color: c.text.muted,
            '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
            transition: 'background 0.15s',
          }}
        >
          <Typography sx={{ fontSize: '0.75rem', fontWeight: 500, color: 'inherit', lineHeight: 1 }}>
            {(() => { const m = allModelOptions.flat.find((m) => m.value === model); return m ? m.label : model; })()}
          </Typography>
          <KeyboardArrowDownIcon sx={{ fontSize: 14, color: 'inherit', opacity: 0.7 }} />
        </Box>

        <Menu
          anchorEl={modelAnchor}
          open={Boolean(modelAnchor)}
          onClose={() => setModelAnchor(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: menuPaperProps }}
        >
          {Object.entries(allModelOptions.grouped).map(([prov, models]) => [
            <MenuItem key={`header-${prov}`} disabled sx={{ opacity: '0.7 !important', py: 0.5, px: 1.5, minHeight: 'auto' }}>
              <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: c.text.tertiary }}>
                {prov}
              </Typography>
            </MenuItem>,
            ...models.map((opt) => (
              <MenuItem
                key={opt.value}
                selected={model === opt.value}
                onClick={() => {
                  onModelChange(opt.value);
                  if (onProviderChange) {
                    // Derive API-level provider key from the display group name
                    const provLower = prov.toLowerCase();
                    const providerMap: Record<string, string> = {
                      anthropic: 'anthropic',
                      openai: 'openai',
                      google: 'gemini',
                      // OpenRouter-backed providers
                      xai: 'openrouter',
                      meta: 'openrouter',
                      deepseek: 'openrouter',
                      mistral: 'openrouter',
                      qwen: 'openrouter',
                      cohere: 'openrouter',
                    };
                    onProviderChange(providerMap[provLower] || provLower);
                  }
                  setModelAnchor(null);
                }}
              >
                <ListItemText
                  primary={opt.label}
                  slotProps={{ primary: { sx: { fontSize: '0.8rem', color: model === opt.value ? c.text.primary : c.text.muted } } }}
                />
              </MenuItem>
            )),
          ]).flat()}
        </Menu>

        <Box sx={{ flex: 1 }} />

        {contextEstimate && (
          <ContextRing
            used={contextEstimate.used}
            limit={contextEstimate.limit}
            accentColor={c.accent.primary}
            trackColor={c.border.subtle}
          />
        )}

        {elementSelection && !autoRunMode && (() => {
          const isMySelectMode = elementSelection.selectMode && elementSelection.activeOwnerId === ownerId;
          return (
            <Tooltip title={isMySelectMode ? 'Exit select mode' : 'Select UI element'}>
              <IconButton
                size="small"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (isMySelectMode) {
                    elementSelection.setSelectMode(false);
                  } else {
                    if (elementSelection.activeOwnerId !== ownerId) {
                      elementSelection.clearOwnerElements(ownerId);
                    }
                    elementSelection.setActiveOwnerId(ownerId);
                    if (sessionId) {
                      elementSelection.setExcludeSelectId(sessionId);
                    } else {
                      elementSelection.setExcludeSelectId(null);
                    }
                    elementSelection.setSelectMode(true);
                  }
                }}
                sx={{
                  p: 0.5,
                  ...(isMySelectMode
                    ? {
                        bgcolor: '#3b82f6',
                        color: '#fff',
                        '&:hover': { bgcolor: '#2563eb' },
                        animation: 'selectBtnPulse 2s ease-in-out infinite',
                        '@keyframes selectBtnPulse': {
                          '0%, 100%': { boxShadow: '0 0 0 0 rgba(59,130,246,0.4)' },
                          '50%': { boxShadow: '0 0 0 4px rgba(59,130,246,0.1)' },
                        },
                      }
                    : {
                        color: c.text.tertiary,
                        '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
                      }),
                  transition: 'background-color 0.15s, color 0.15s',
                }}
              >
                <AdsClickIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          );
        })()}

        <input
          ref={generalFileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (!e.target.files) return;
            const all = Array.from(e.target.files);
            const imgs = all.filter((f) => f.type.startsWith('image/'));
            const rest = all.filter((f) => !f.type.startsWith('image/'));
            if (imgs.length > 0) addImageFiles(imgs);
            if (rest.length > 0) uploadAndAttachFiles(rest);
            e.target.value = '';
          }}
        />
        <Tooltip title="Attach file">
          <IconButton
            size="small"
            onClick={() => generalFileInputRef.current?.click()}
            sx={{
              color: c.text.tertiary,
              p: 0.5,
              '&:hover': { color: c.text.secondary, bgcolor: 'rgba(0,0,0,0.04)' },
            }}
          >
            <AttachFileIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        {!autoRunMode && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {hasContent && (
              <Tooltip title={isRunning ? 'Queue message' : 'Send message'}>
                <IconButton
                  size="small"
                  onClick={handleSend}
                  disabled={disabled}
                  sx={{
                    bgcolor: c.accent.primary,
                    color: c.text.inverse,
                    p: 0.5,
                    width: 26,
                    height: 26,
                    '&:hover': { bgcolor: c.accent.hover },
                    '&.Mui-disabled': { bgcolor: c.bg.secondary, color: c.text.ghost },
                    transition: c.transition,
                  }}
                >
                  <ArrowUpwardIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {isRunning ? (
              <Tooltip title="Stop agent">
                <IconButton
                  size="small"
                  onClick={onStop}
                  sx={{
                    bgcolor: c.status.error,
                    color: c.text.inverse,
                    p: 0.5,
                    width: 26,
                    height: 26,
                    '&:hover': { bgcolor: c.status.error, opacity: 0.85 },
                    transition: c.transition,
                  }}
                >
                  <StopIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            ) : !hasContent ? (
              <Tooltip title="Voice input (coming soon)">
                <span>
                  <IconButton
                    size="small"
                    disabled
                    sx={{
                      color: c.text.tertiary,
                      p: 0.5,
                      '&.Mui-disabled': { color: c.text.ghost },
                    }}
                  >
                    <MicNoneOutlinedIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Box>
        )}
      </Box>

      {selectedTemplate && (
        <TemplateInvokeModal
          template={selectedTemplate}
          open={!!selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onApply={(rendered) => {
            const editor = editorRef.current;
            if (editor) {
              editor.innerHTML = '';
              editor.textContent = rendered;
              const range = document.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              const sel = window.getSelection();
              if (sel) { sel.removeAllRanges(); sel.addRange(range); }
            }
            setSelectedTemplate(null);
            setAttachedSkills({});
            setHasContent(!!rendered);
          }}
        />
      )}

      <Modal
        open={!!lightboxSrc}
        onClose={() => setLightboxSrc(null)}
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Box
          onClick={() => setLightboxSrc(null)}
          sx={{ position: 'relative', outline: 'none', maxWidth: '90vw', maxHeight: '90vh' }}
        >
          <IconButton
            onClick={() => setLightboxSrc(null)}
            sx={{
              position: 'absolute',
              top: -16,
              right: -16,
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.medium}`,
              color: c.text.secondary,
              width: 32,
              height: 32,
              zIndex: 1,
              '&:hover': { bgcolor: c.bg.secondary },
              boxShadow: c.shadow.md,
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
          <img
            src={lightboxSrc || ''}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              borderRadius: 8,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              display: 'block',
            }}
          />
        </Box>
      </Modal>

    </Box>
  );
});

ChatInput.displayName = 'ChatInput';

export default ChatInput;
