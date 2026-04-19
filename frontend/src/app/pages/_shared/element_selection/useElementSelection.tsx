import { createContext, useContext, RefObject } from 'react';
import { type SelectedElement } from './SelectedElement';


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

export const ElementSelectionContext = createContext<ElementSelectionContextValue | null>(null);

export function useElementSelection() {
  return useContext(ElementSelectionContext);
}