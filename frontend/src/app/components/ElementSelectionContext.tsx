import React, { createContext, useContext, useState, useRef, useCallback, useMemo, RefObject } from 'react';

export interface SelectedElement {
  id: string;
  selectorPath: string;
  tagName: string;
  className: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  screenshot?: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  semanticType?: 'agent-card' | 'message' | 'tool-call' | 'tool-group' | 'view-card' | 'browser-card' | 'dom-element';
  semanticLabel?: string;
  semanticData?: Record<string, any>;
}

interface ElementSelectionContextValue {
  selectMode: boolean;
  toggleSelectMode: () => void;
  setSelectMode: (active: boolean) => void;
  excludeSelectId: string | null;
  setExcludeSelectId: (id: string | null) => void;
  activeOwnerId: string | null;
  setActiveOwnerId: (id: string | null) => void;
  selectedElements: SelectedElement[];
  addSelectedElement: (el: SelectedElement) => void;
  updateSelectedElement: (id: string, patch: Partial<SelectedElement>) => void;
  removeSelectedElement: (id: string) => void;
  clearSelectedElements: () => void;
  elementsByOwner: Record<string, SelectedElement[]>;
  addElementForOwner: (ownerId: string, el: SelectedElement) => void;
  removeOwnerElement: (ownerId: string, elementId: string) => void;
  clearOwnerElements: (ownerId: string) => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
}

const ElementSelectionContext = createContext<ElementSelectionContextValue | null>(null);

export function useElementSelection() {
  return useContext(ElementSelectionContext);
}

export const ElementSelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectMode, setSelectMode] = useState(false);
  const [excludeSelectId, setExcludeSelectId] = useState<string | null>(null);
  const [activeOwnerId, setActiveOwnerId] = useState<string | null>(null);
  const [elementsByOwner, setElementsByOwner] = useState<Record<string, SelectedElement[]>>({});
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const activeOwnerIdRef = useRef(activeOwnerId);
  activeOwnerIdRef.current = activeOwnerId;

  const selectedElements = useMemo(
    () => (activeOwnerId ? elementsByOwner[activeOwnerId] ?? [] : []),
    [activeOwnerId, elementsByOwner],
  );

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      if (prev) setExcludeSelectId(null);
      return !prev;
    });
  }, []);

  const addSelectedElement = useCallback((el: SelectedElement) => {
    const ownerId = activeOwnerIdRef.current;
    if (!ownerId) return;
    setElementsByOwner((prev) => {
      const existing = prev[ownerId] ?? [];
      if (existing.some((e) => e.id === el.id)) return prev;
      return { ...prev, [ownerId]: [...existing, el] };
    });
  }, []);

  const updateSelectedElement = useCallback((id: string, patch: Partial<SelectedElement>) => {
    const ownerId = activeOwnerIdRef.current;
    if (!ownerId) return;
    setElementsByOwner((prev) => {
      const existing = prev[ownerId];
      if (!existing) return prev;
      return { ...prev, [ownerId]: existing.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
    });
  }, []);

  const removeSelectedElement = useCallback((id: string) => {
    const ownerId = activeOwnerIdRef.current;
    if (!ownerId) return;
    setElementsByOwner((prev) => {
      const existing = prev[ownerId];
      if (!existing) return prev;
      return { ...prev, [ownerId]: existing.filter((e) => e.id !== id) };
    });
  }, []);

  const clearSelectedElements = useCallback(() => {
    const ownerId = activeOwnerIdRef.current;
    if (!ownerId) return;
    setElementsByOwner((prev) => {
      if (!prev[ownerId]?.length) return prev;
      return { ...prev, [ownerId]: [] };
    });
  }, []);

  const addElementForOwner = useCallback((ownerId: string, el: SelectedElement) => {
    setElementsByOwner((prev) => {
      const existing = prev[ownerId] ?? [];
      if (existing.some((e) => e.semanticData?.selectId === el.semanticData?.selectId)) return prev;
      return { ...prev, [ownerId]: [...existing, el] };
    });
  }, []);

  const removeOwnerElement = useCallback((ownerId: string, elementId: string) => {
    setElementsByOwner((prev) => {
      const existing = prev[ownerId];
      if (!existing) return prev;
      return { ...prev, [ownerId]: existing.filter((e) => e.id !== elementId) };
    });
  }, []);

  const clearOwnerElements = useCallback((ownerId: string) => {
    setElementsByOwner((prev) => {
      if (!prev[ownerId]?.length) return prev;
      return { ...prev, [ownerId]: [] };
    });
  }, []);

  return (
    <ElementSelectionContext.Provider
      value={{
        selectMode,
        toggleSelectMode,
        setSelectMode,
        excludeSelectId,
        setExcludeSelectId,
        activeOwnerId,
        setActiveOwnerId,
        selectedElements,
        addSelectedElement,
        updateSelectedElement,
        removeSelectedElement,
        clearSelectedElements,
        elementsByOwner,
        addElementForOwner,
        removeOwnerElement,
        clearOwnerElements,
        iframeRef,
      }}
    >
      {children}
    </ElementSelectionContext.Provider>
  );
};
