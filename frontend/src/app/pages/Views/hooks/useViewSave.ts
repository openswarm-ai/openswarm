import React, { useState, useEffect, useRef } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { CREATE_APP, UPDATE_APP, App } from '@/shared/backend-bridge/apps/app_builder';
import { ViewPreviewHandle } from '../ViewPreview';
import { captureViewThumbnail } from '../captureViewThumbnail';

interface UseViewSaveParams {
  output: App | null;
  name: string;
  description: string;
  files: Record<string, string>;
  testInput: Record<string, any>;
  onClose: () => void;
  previewRef: React.RefObject<ViewPreviewHandle | null>;
  createdIdRef: React.MutableRefObject<string | null>;
  setCreatedId: (id: string) => void;
}

export function useViewSave(params: UseViewSaveParams) {
  const {
    output, name, description, files, testInput, onClose, previewRef,
    createdIdRef, setCreatedId,
  } = params;
  const dispatch = useAppDispatch();

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'unsaved' | 'saving' | 'saved'>('idle');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const savedRef = useRef(!!output);
  const autoSaveInitRef = useRef(true);

  const buildBody = () => {
    let schema: Record<string, any>;
    try { schema = JSON.parse(files['schema.json'] ?? '{}'); } catch { schema = { type: 'object', properties: {} }; }
    const appFiles = { ...files };
    delete appFiles['meta.json'];
    delete appFiles['schema.json'];
    delete appFiles['SKILL.md'];
    return {
      name: name || 'Untitled App',
      description,
      icon: 'view_quilt',
      input_schema: schema,
      files: appFiles,
    };
  };

  const captureThumbnailAsync = (appId: string) => {
    captureViewThumbnail(files['index.html'] ?? '', testInput, files)
      .then((thumbnail) => { if (thumbnail) dispatch(UPDATE_APP({ appId, thumbnail })); })
      .catch(() => {});
  };

  const performSaveRef = useRef<((close: boolean) => Promise<void>) | null>(null);

  performSaveRef.current = async (close: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveStatus('saving');
    try {
      const body = buildBody();
      const eid = output?.id ?? createdIdRef.current;
      let savedId: string;
      if (eid) {
        await dispatch(UPDATE_APP({ appId: eid, ...body })).unwrap();
        savedId = eid;
      } else {
        const created = await dispatch(CREATE_APP(body)).unwrap();
        savedId = created.id;
        createdIdRef.current = savedId;
        setCreatedId(savedId);
      }
      savedRef.current = true;
      setSaveStatus('saved');
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
      savedStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      if (close) onClose();
      else previewRef.current?.reload();
      captureThumbnailAsync(savedId);
    } catch (err: any) {
      console.error('Failed to save output:', err);
      setSaveStatus('unsaved');
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const handleSave = async (close = true) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    await performSaveRef.current?.(close);
  };

  useEffect(() => {
    if (autoSaveInitRef.current) { autoSaveInitRef.current = false; return; }
    const hasContent = name.trim() || (files['index.html'] ?? '').trim();
    if (!hasContent) return;
    if (!savingRef.current) setSaveStatus('unsaved');
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => { performSaveRef.current?.(false); }, 1500);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [files, name, description]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
    };
  }, []);

  return { saving, saveStatus, handleSave };
}
