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