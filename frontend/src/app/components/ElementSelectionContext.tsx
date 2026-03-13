import React, { createContext, useContext, useState, useRef, useCallback, RefObject } from 'react';

export interface SelectedElement {
  id: string;
  selectorPath: string;
  tagName: string;
  className: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  screenshot?: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  semanticType?: 'agent-card' | 'message' | 'tool-call' | 'tool-group' | 'view-card' | 'dom-element';
  semanticLabel?: string;
  semanticData?: Record<string, any>;
}

interface ElementSelectionContextValue {
  selectMode: boolean;
  toggleSelectMode: () => void;
  setSelectMode: (active: boolean) => void;
  selectedElements: SelectedElement[];
  addSelectedElement: (el: SelectedElement) => void;
  updateSelectedElement: (id: string, patch: Partial<SelectedElement>) => void;
  removeSelectedElement: (id: string) => void;
  clearSelectedElements: () => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
}

const ElementSelectionContext = createContext<ElementSelectionContextValue | null>(null);

export function useElementSelection() {
  return useContext(ElementSelectionContext);
}

export const ElementSelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedElements, setSelectedElements] = useState<SelectedElement[]>([]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => !prev);
  }, []);

  const addSelectedElement = useCallback((el: SelectedElement) => {
    setSelectedElements((prev) => {
      if (prev.some((e) => e.id === el.id)) return prev;
      return [...prev, el];
    });
  }, []);

  const updateSelectedElement = useCallback((id: string, patch: Partial<SelectedElement>) => {
    setSelectedElements((prev) => prev.map((e) => e.id === id ? { ...e, ...patch } : e));
  }, []);

  const removeSelectedElement = useCallback((id: string) => {
    setSelectedElements((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clearSelectedElements = useCallback(() => {
    setSelectedElements([]);
  }, []);

  return (
    <ElementSelectionContext.Provider
      value={{
        selectMode,
        toggleSelectMode,
        setSelectMode,
        selectedElements,
        addSelectedElement,
        updateSelectedElement,
        removeSelectedElement,
        clearSelectedElements,
        iframeRef,
      }}
    >
      {children}
    </ElementSelectionContext.Provider>
  );
};
