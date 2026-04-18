import React, { useCallback } from 'react';
import type { CommandPickerItem } from '@/app/components/CommandPicker';
import { useElementSelection, type SelectedElement } from '@/app/components/ElementSelectionContext';
import { getClipboardCards, clearClipboard } from '@/shared/dashboardClipboard';
import { getWebview } from '@/shared/browserRegistry';
import { API_BASE } from '@/shared/config';
import type { ContextPath } from '@/shared/state/agentsTypes';
import {
  SKILL_PILL_ATTR, type AttachedSkill, createSkillPillElement,
  serializeEditorContent, type TriggerState, detectEditorTrigger,
} from '@/app/components/richEditorUtils';
import type { AttachedImage } from '../ImageAttachments';
import type { ForcedToolGroup } from '../AttachmentChips';

interface ChatSubmitParams {
  editorRef: React.RefObject<HTMLDivElement | null>; attachedSkillsRef: React.MutableRefObject<Record<string, AttachedSkill>>;
  generalFileInputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean; autoRunMode?: boolean; images: AttachedImage[]; contextPaths: ContextPath[];
  forcedTools: ForcedToolGroup[]; picker: TriggerState;
  skills: Record<string, { id: string; name: string; content: string }>; ownerId: string;
  elementSelection: ReturnType<typeof useElementSelection>;
  onSend: (msg: string, imgs?: Array<{ data: string; media_type: string }>, ctx?: ContextPath[], tools?: string[], skills?: Array<{ id: string; name: string; content: string }>, browserIds?: string[]) => void;
  onModeChange: (mode: string) => void;
  setImages: React.Dispatch<React.SetStateAction<AttachedImage[]>>; setContextPaths: React.Dispatch<React.SetStateAction<ContextPath[]>>;
  setForcedTools: React.Dispatch<React.SetStateAction<ForcedToolGroup[]>>; setPicker: React.Dispatch<React.SetStateAction<TriggerState>>;
  setHasContent: React.Dispatch<React.SetStateAction<boolean>>; setAttachedSkills: React.Dispatch<React.SetStateAction<Record<string, AttachedSkill>>>;
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>; setIsDragOver: React.Dispatch<React.SetStateAction<boolean>>;
  c: { font: { mono: string }; status: { error: string } };
}

export function useChatSubmit(p: ChatSubmitParams) {
  const {
    editorRef, attachedSkillsRef, generalFileInputRef, disabled, autoRunMode,
    images, contextPaths, forcedTools, picker, skills, ownerId,
    elementSelection, onSend, onModeChange, setImages, setContextPaths,
    setForcedTools, setPicker, setHasContent, setAttachedSkills,
    setIsUploading, setIsDragOver, c,
  } = p;
  const updateHasContent = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    setHasContent(text.trim().length > 0 || editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null);
  }, []);
  const syncAttachedSkills = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const pillIds = new Set(
      Array.from(editor.querySelectorAll(`[${SKILL_PILL_ATTR}]`))
        .map((el) => el.getAttribute(SKILL_PILL_ATTR)).filter(Boolean) as string[],
    );
    setAttachedSkills((prev) => {
      const prevKeys = Object.keys(prev);
      if (prevKeys.length === pillIds.size && prevKeys.every((k) => pillIds.has(k))) return prev;
      const next: Record<string, AttachedSkill> = {};
      for (const [id, skill] of Object.entries(prev)) { if (pillIds.has(id)) next[id] = skill; }
      return next;
    });
  }, []);
  const removeSkillPill = useCallback((skillId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const pill = editor.querySelector(`[${SKILL_PILL_ATTR}="${skillId}"]`);
    if (pill) pill.remove();
    setAttachedSkills((prev) => { const { [skillId]: _, ...rest } = prev; return rest; });
    const text = (editor.textContent || '').replace(/\u200B/g, '');
    setHasContent(text.trim().length > 0 || editor.querySelector(`[${SKILL_PILL_ATTR}]`) !== null);
    editor.focus();
  }, []);
  const detectTrigger = useCallback(() => { const r = detectEditorTrigger(); r ? setPicker(r) : setPicker((prev) => ({ ...prev, visible: false })); }, []);
  const handleInput = useCallback(() => { updateHasContent(); detectTrigger(); syncAttachedSkills(); }, [updateHasContent, detectTrigger, syncAttachedSkills]);
  const handleEditorClick = useCallback(() => { detectTrigger(); }, [detectTrigger]);
  const addImageFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setImages((prev) => [...prev, { data: result.split(',')[1], media_type: file.type, preview: result }]);
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
      const resp = await fetch(`${API_BASE}/settings/upload-files`, { method: 'POST', body: formData });
      if (!resp.ok) throw new Error('Upload failed');
      const data = await resp.json();
      const newPaths: ContextPath[] = (data.files || []).map((f: { path: string }) => ({ path: f.path, type: 'file' as const }));
      setContextPaths((prev) => [...prev, ...newPaths]);
    } catch (err) { console.error('File upload failed:', err); }
    finally { setIsUploading(false); }
  }, []);
  const handleSend = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    let trimmed = serializeEditorContent(editor, attachedSkillsRef.current).trim();
    if (!trimmed) return;
    const selectedEls = elementSelection?.elementsByOwner?.[ownerId] ?? [];
    let allImages = images.length > 0 ? images.map(({ data, media_type }) => ({ data, media_type })) : [];
    if (selectedEls.length > 0) {
      const lines: string[] = ['\n\n---\nSelected UI Elements:\n'];
      for (let i = 0; i < selectedEls.length; i++) {
        const el = selectedEls[i];
        if (el.semanticType === 'browser-card' && el.semanticData?.selectId) {
          const wv = getWebview(el.semanticData.selectId as string);
          const url = wv ? (el.semanticData.url || wv.getURL()) : (el.semanticData.url || '');
          const title = wv ? (el.semanticData.name || wv.getTitle()) : (el.semanticLabel || '');
          lines.push(`${i + 1}. [Browser Card] ${title}`, `   browser_id: ${el.semanticData.selectId}`);
          if (url) lines.push(`   URL: ${url}`);
          lines.push('   (Use BrowserAgent with this browser_id to interact with it, or CreateBrowserAgent for a new browser)');
        } else if (el.semanticType && el.semanticData) {
          const typeLabel = { 'agent-card': 'Agent Card', message: 'Message', 'tool-call': 'Tool Call', 'tool-group': 'Tool Group', 'view-card': 'App Card', 'browser-card': 'Browser Card', 'dom-element': 'Element' }[el.semanticType] || el.semanticType;
          lines.push(`${i + 1}. [${typeLabel}] ${el.semanticLabel || ''}`);
          const { selectId, ...rest } = el.semanticData;
          if (selectId) lines.push(`   ID: ${selectId}`);
          const metaStr = Object.entries(rest).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
          if (metaStr) lines.push(`   ${metaStr}`);
          if (el.semanticType === 'agent-card' && selectId) lines.push(`   (Use InvokeAgent with session_id "${selectId}" to query this agent with full conversation context)`);
        } else {
          const styleStr = Object.entries(el.computedStyles).map(([k, v]) => `${k}: ${v}`).join('; ');
          lines.push(`${i + 1}. \`${el.selectorPath}\` (${el.tagName.toLowerCase()})`, `   Selector: ${el.selectorPath}`);
          lines.push(`   HTML: ${el.outerHTML.length > 500 ? el.outerHTML.slice(0, 500) + '...' : el.outerHTML}`);
          if (styleStr) lines.push(`   Key styles: ${styleStr}`);
        }
        lines.push('');
        if (el.screenshot) allImages.push({ data: el.screenshot.replace(/^data:image\/\w+;base64,/, ''), media_type: 'image/png' });
      }
      trimmed += lines.join('\n');
    }
    const allForcedToolNames = forcedTools.flatMap((ft) => ft.tools);
    const currentSkills = Object.values(attachedSkillsRef.current);
    const sendSkills = currentSkills.length > 0 ? currentSkills.map((s) => ({ id: s.id, name: s.name, content: s.content })) : undefined;
    const browserIds = selectedEls.filter((el) => el.semanticType === 'browser-card' && el.semanticData?.selectId).map((el) => el.semanticData!.selectId as string);
    onSend(trimmed, allImages.length > 0 ? allImages : undefined, contextPaths.length > 0 ? contextPaths : undefined,
      allForcedToolNames.length > 0 ? allForcedToolNames : undefined, sendSkills, browserIds.length > 0 ? browserIds : undefined);
    editor.innerHTML = '';
    setImages([]); setContextPaths([]); setForcedTools([]); setAttachedSkills({}); setHasContent(false);
    elementSelection?.clearOwnerElements(ownerId);
  }, [disabled, images, contextPaths, forcedTools, onSend, elementSelection, ownerId]);
  const handlePickerSelect = (item: CommandPickerItem) => {
    setPicker((prev) => ({ ...prev, visible: false }));
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
    if (item.type === 'skill') {
      const skill = skills[item.id];
      if (!skill || editor.querySelector(`[${SKILL_PILL_ATTR}="${skill.id}"]`)) return;
      const pill = createSkillPillElement({ id: skill.id, name: skill.name, content: skill.content }, removeSkillPill, c.font.mono, c.status.error);
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
      setAttachedSkills((prev) => ({ ...prev, [skill.id]: { id: skill.id, name: skill.name, content: skill.content } }));
    } else if (item.type === 'mode') {
      onModeChange(item.id);
    } else if (item.type === 'context') {
      if (item.command === 'file') generalFileInputRef.current?.click();
      else if (item.toolNames && item.toolNames.length > 0) setForcedTools((prev) => [...prev, { label: item.name, tools: item.toolNames!, icon: item.icon, iconKey: item.iconKey }]);
      else document.execCommand('insertText', false, `@${item.command} `);
    }
    updateHasContent();
    setTimeout(() => editor.focus(), 0);
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (picker.visible && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(e.key)) { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !autoRunMode) { e.preventDefault(); handleSend(); }
  };
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const copied = getClipboardCards();
    if (copied.length > 0 && elementSelection) {
      e.preventDefault();
      for (const card of copied) {
        const semanticTypeMap: Record<string, SelectedElement['semanticType']> = { agent: 'agent-card', view: 'view-card', browser: 'browser-card' };
        const semanticType = semanticTypeMap[card.type];
        if (!semanticType) continue;
        const labelMap: Record<string, string> = { 'agent-card': 'Agent', 'view-card': 'View', 'browser-card': 'Browser' };
        const el: SelectedElement = {
          id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          selectorPath: `[data-select-type="${semanticType}"][data-select-id="${card.id}"]`,
          tagName: 'DIV', className: '', outerHTML: '', computedStyles: {},
          boundingRect: { x: 0, y: 0, width: 0, height: 0 },
          semanticType, semanticLabel: (labelMap[semanticType] || semanticType) + ': ' + card.name,
          semanticData: { ...card.meta, selectId: card.id },
        };
        elementSelection.addElementForOwner(ownerId, el);
      }
      clearClipboard();
      return;
    }
    const items = e.clipboardData?.items;
    if (items) {
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) { const file = items[i].getAsFile(); if (file) imageFiles.push(file); }
      }
      if (imageFiles.length > 0) { e.preventDefault(); addImageFiles(imageFiles); return; }
    }
    e.preventDefault();
    const plain = e.clipboardData?.getData('text/plain');
    if (plain) document.execCommand('insertText', false, plain);
  }, [addImageFiles, elementSelection, ownerId]);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.types.includes('Files')) setIsDragOver(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    if (e.dataTransfer.files.length === 0) return;
    const allFiles = Array.from(e.dataTransfer.files);
    const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
    const otherFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
    if (imageFiles.length > 0) addImageFiles(imageFiles);
    if (otherFiles.length > 0) uploadAndAttachFiles(otherFiles);
  }, [addImageFiles, uploadAndAttachFiles]);
  const removeImage = useCallback((idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx)), []);

  return { handleSend, handlePickerSelect, handlePaste, handleKeyDown, handleInput, handleEditorClick, handleDragOver, handleDragLeave, handleDrop, addImageFiles, uploadAndAttachFiles, removeImage };
}
