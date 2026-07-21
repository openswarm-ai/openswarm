"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { flushSync } from "react-dom";
import type { ImageGalleryItem } from "./schema";

const VIEW_TRANSITION_NAME = "active-gallery-image";

interface ImageGalleryContextValue {
  images: ImageGalleryItem[];
  activeIndex: number | null;
  openLightbox: (index: number) => void;
  closeLightbox: () => void;
  registerImage: (id: string, element: HTMLElement | null) => void;
  lightboxContentRef: React.MutableRefObject<HTMLDivElement | null>;
  setDialogRef: (element: HTMLDialogElement | null) => void;
}

const ImageGalleryContext = createContext<ImageGalleryContextValue | null>(
  null,
);

export function useImageGallery(): ImageGalleryContextValue {
  const context = useContext(ImageGalleryContext);
  if (!context) {
    throw new Error("useImageGallery must be used within ImageGalleryProvider");
  }
  return context;
}

function supportsViewTransitions(): boolean {
  return (
    typeof document !== "undefined" &&
    "startViewTransition" in document &&
    typeof window !== "undefined" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  );
}

function withViewTransition(
  element: HTMLElement,
  domUpdate: () => void,
  onFinished?: () => void,
): void {
  if (!supportsViewTransitions()) {
    domUpdate();
    onFinished?.();
    return;
  }

  element.style.viewTransitionName = VIEW_TRANSITION_NAME;

  const transition = document.startViewTransition(() => domUpdate());

  transition.finished.finally(() => {
    element.style.removeProperty("view-transition-name");
    onFinished?.();
  });
}

interface ImageGalleryProviderProps {
  images: ImageGalleryItem[];
  children: React.ReactNode;
}

export function ImageGalleryProvider({
  images,
  children,
}: ImageGalleryProviderProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const imageElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const lightboxContentRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const originalParentRef = useRef<HTMLElement | null>(null);

  const registerImage = useCallback(
    (id: string, element: HTMLElement | null) => {
      if (element) {
        imageElementsRef.current.set(id, element);
      } else {
        imageElementsRef.current.delete(id);
      }
    },
    [],
  );

  const setDialogRef = useCallback((element: HTMLDialogElement | null) => {
    dialogRef.current = element;
  }, []);

  const openLightbox = useCallback(
    (index: number) => {
      const image = images[index];
      if (!image) return;

      const imageElement = imageElementsRef.current.get(image.id);
      const container = lightboxContentRef.current;
      const dialog = dialogRef.current;

      if (!imageElement || !container || !dialog) {
        setActiveIndex(index);
        dialog?.showModal();
        return;
      }

      originalParentRef.current = imageElement.parentElement;

      withViewTransition(imageElement, () => {
        container.appendChild(imageElement);
        flushSync(() => setActiveIndex(index));
        dialog.showModal();
      });
    },
    [images],
  );

  const closeLightbox = useCallback(() => {
    if (activeIndex === null) return;

    const image = images[activeIndex];
    const dialog = dialogRef.current;

    if (!image) {
      setActiveIndex(null);
      dialog?.close();
      return;
    }

    const imageElement = imageElementsRef.current.get(image.id);
    const originalParent = originalParentRef.current;

    if (!imageElement || !originalParent) {
      setActiveIndex(null);
      dialog?.close();
      return;
    }

    withViewTransition(
      imageElement,
      () => {
        originalParent.appendChild(imageElement);
        flushSync(() => setActiveIndex(null));
        dialog?.close();
      },
      () => {
        originalParentRef.current = null;
      },
    );
  }, [activeIndex, images]);

  const value = useMemo<ImageGalleryContextValue>(
    () => ({
      images,
      activeIndex,
      openLightbox,
      closeLightbox,
      registerImage,
      lightboxContentRef,
      setDialogRef,
    }),
    [
      images,
      activeIndex,
      openLightbox,
      closeLightbox,
      registerImage,
      setDialogRef,
    ],
  );

  return (
    <ImageGalleryContext.Provider value={value}>
      {children}
    </ImageGalleryContext.Provider>
  );
}
