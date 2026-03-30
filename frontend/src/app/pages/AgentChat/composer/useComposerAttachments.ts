import { useState, useCallback, useRef } from 'react';
import { API_BASE } from '@/shared/config';
import type { ContextPath } from '@/app/components/DirectoryBrowser';

export interface AttachedImage {
  data: string;
  media_type: string;
  preview: string;
}

export interface ForcedToolGroup {
  label: string;
  tools: string[];
  iconKey?: string;
}

export interface AttachedSkill {
  id: string;
  name: string;
  content: string;
}

export function useComposerAttachments() {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [contextPaths, setContextPaths] = useState<ContextPath[]>([]);
  const [forcedTools, setForcedTools] = useState<ForcedToolGroup[]>([]);
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const generalFileInputRef = useRef<HTMLInputElement>(null);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setImages((prev) => [
          ...prev,
          { data: result.split(',')[1], media_type: file.type, preview: result },
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

  const removeImage = useCallback(
    (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx)),
    [],
  );

  const removeContextPath = useCallback(
    (idx: number) => setContextPaths((prev) => prev.filter((_, i) => i !== idx)),
    [],
  );

  const removeForcedTool = useCallback(
    (idx: number) => setForcedTools((prev) => prev.filter((_, i) => i !== idx)),
    [],
  );

  const removeSkill = useCallback(
    (id: string) =>
      setAttachedSkills((prev) => {
        const { [id]: _, ...rest } = prev;
        return rest;
      }),
    [],
  );

  const clearAll = useCallback(() => {
    setImages([]);
    setContextPaths([]);
    setForcedTools([]);
    setAttachedSkills({});
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (e.dataTransfer.files.length === 0) return;
      const allFiles = Array.from(e.dataTransfer.files);
      const imageFiles = allFiles.filter((f) => f.type.startsWith('image/'));
      const otherFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
      if (imageFiles.length > 0) addImageFiles(imageFiles);
      if (otherFiles.length > 0) uploadAndAttachFiles(otherFiles);
    },
    [addImageFiles, uploadAndAttachFiles],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const allFiles = Array.from(files);
      const imgFiles = allFiles.filter((f) => f.type.startsWith('image/'));
      const otherFiles = allFiles.filter((f) => !f.type.startsWith('image/'));
      if (imgFiles.length > 0) addImageFiles(imgFiles);
      if (otherFiles.length > 0) uploadAndAttachFiles(otherFiles);
      e.target.value = '';
    },
    [addImageFiles, uploadAndAttachFiles],
  );

  return {
    images, contextPaths, forcedTools, attachedSkills, isUploading, isDragOver,
    generalFileInputRef,
    setImages, setContextPaths, setForcedTools, setAttachedSkills,
    addImageFiles, uploadAndAttachFiles, removeImage, removeContextPath,
    removeForcedTool, removeSkill, clearAll,
    handleDragOver, handleDragLeave, handleDrop, handleFileInputChange,
  };
}
