import { useState, useRef, useCallback, useEffect } from 'react';
import { AttachedImage } from '../types';

export function useImageAttachments() {
  const [images, setImages] = useState<AttachedImage[]>([]);
  // Ref so unmount cleanup revokes the latest blob: preview URLs.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => {
    for (const img of imagesRef.current) {
      if (img.preview?.startsWith('blob:')) {
        try { URL.revokeObjectURL(img.preview); } catch {}
      }
    }
  }, []);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const addImageFiles = useCallback((files: FileList | File[]) => {
    // Preview via blob: URL; base64 only materializes at send (saves ~2.7MB JS heap per attachment).
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const previewUrl = URL.createObjectURL(file);
      setImages((prev) => [
        ...prev,
        { data: '', media_type: file.type, preview: previewUrl, _file: file } as AttachedImage,
      ]);
    });
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => {
      const removed = prev[idx];
      if (removed?.preview?.startsWith('blob:')) {
        try { URL.revokeObjectURL(removed.preview); } catch {}
      }
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  return { images, setImages, addImageFiles, removeImage, lightboxSrc, setLightboxSrc };
}
