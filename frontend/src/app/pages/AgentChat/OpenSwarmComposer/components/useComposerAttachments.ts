import { useState, useCallback } from 'react';
import type { ContextPath } from '@/shared/state/agentsTypes';

interface AttachedImage {
  data: string;
  media_type: string;
  preview: string;
}

interface ForcedToolGroup {
  label: string;
  tools: string[];
  iconKey?: string;
}

interface AttachedSkill {
  id: string;
  name: string;
  content: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const isImagePath = (p: string) => IMAGE_EXTS.has(p.slice(p.lastIndexOf('.')).toLowerCase());

export function useComposerAttachments() {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [contextPaths, setContextPaths] = useState<ContextPath[]>([]);
  const [forcedTools, setForcedTools] = useState<ForcedToolGroup[]>([]);
  const [attachedSkills, setAttachedSkills] = useState<Record<string, AttachedSkill>>({});
  const [isDragOver, setIsDragOver] = useState(false);

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

  const attachFilePaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const newPaths: ContextPath[] = paths
      .filter((p) => !isImagePath(p))
      .map((p) => ({ path: p, type: 'file' as const }));
    if (newPaths.length > 0) setContextPaths((prev) => [...prev, ...newPaths]);
  }, []);

  /** Attach non-image files using their native Electron File.path. */
  const attachFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));
    attachFilePaths(paths);
  }, [attachFilePaths]);

  /** Open native OS file picker and attach selected files as context paths. */
  const browseAndAttachFiles = useCallback(async () => {
    const result = await window.openswarm.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths?.length) return;
    attachFilePaths(result.filePaths);
  }, [attachFilePaths]);

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
      if (otherFiles.length > 0) attachFiles(otherFiles);
    },
    [addImageFiles, attachFiles],
  );

  return {
    images, contextPaths, forcedTools, attachedSkills, isDragOver,
    setImages, setContextPaths, setForcedTools, setAttachedSkills,
    addImageFiles, attachFiles, browseAndAttachFiles, removeImage, removeContextPath,
    removeForcedTool, removeSkill, clearAll,
    handleDragOver, handleDragLeave, handleDrop,
  };
}
