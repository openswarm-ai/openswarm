import React, { useEffect, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { type OverlayState, type DragRect, type DragPreviewElement } from './_shared/types';
import { useElementSelection } from './_shared/useElementSelection';

const HIGHLIGHT_COLOR = '#3b82f6';
const HIGHLIGHT_BG = 'rgba(59, 130, 246, 0.08)';
const SELECTED_BG = 'rgba(59, 130, 246, 0.06)';
const DRAG_BG = 'rgba(59, 130, 246, 0.1)';
const DRAG_BORDER = 'rgba(59, 130, 246, 0.5)';
const PREVIEW_ADD_BORDER = 'rgba(59, 130, 246, 0.6)';
const PREVIEW_ADD_BG = 'rgba(59, 130, 246, 0.1)';
const PREVIEW_REMOVE_BORDER = 'rgba(239, 68, 68, 0.6)';
const PREVIEW_REMOVE_BG = 'rgba(239, 68, 68, 0.1)';

interface PersistentRect {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
  label: string;
}

interface Props {
  overlay: OverlayState;
  dragRect: DragRect;
  dragPreview?: DragPreviewElement[];
}

const SelectionOverlay: React.FC<Props> = ({ overlay, dragRect, dragPreview = [] }) => {
  const ctx = useElementSelection();
  const [persistentRects, setPersistentRects] = useState<PersistentRect[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ctx || ctx.selectedElements.length === 0) {
      setPersistentRects([]);
      return;
    }

    const semanticEls = ctx.selectedElements.filter((e) => e.semanticType);
    if (semanticEls.length === 0) {
      setPersistentRects([]);
      return;
    }

    const updateRects = () => {
      const rects: PersistentRect[] = [];
      for (const sel of semanticEls) {
        try {
          const domEl = document.querySelector(sel.selectorPath);
          if (domEl) {
            const rect = domEl.getBoundingClientRect();
            rects.push({
              id: sel.id,
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              label: sel.semanticLabel || sel.tagName,
            });
          }
        } catch {
          // selector might be invalid
        }
      }
      setPersistentRects(rects);
      rafRef.current = requestAnimationFrame(updateRects);
    };

    rafRef.current = requestAnimationFrame(updateRects);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [ctx?.selectedElements]);

  const hasHover = overlay.visible;
  const hasPersistent = persistentRects.length > 0;
  const hasDrag = dragRect.visible;
  const hasPreview = dragPreview.length > 0;

  if (!hasHover && !hasPersistent && !hasDrag && !hasPreview) return null;

  return ReactDOM.createPortal(
    <>
      {/* Persistent highlights for already-selected elements */}
      {persistentRects.map((r) => (
        <React.Fragment key={r.id}>
          <div
            style={{
              position: 'fixed',
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
              border: `2px solid ${HIGHLIGHT_COLOR}`,
              background: SELECTED_BG,
              pointerEvents: 'none',
              zIndex: 2147483644,
              boxSizing: 'border-box',
              borderRadius: 4,
            }}
          />
          <div
            style={{
              position: 'fixed',
              top: Math.max(0, r.top),
              left: Math.max(0, r.left),
              background: HIGHLIGHT_COLOR,
              color: '#fff',
              fontSize: 9,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace",
              padding: '0px 5px',
              borderRadius: '0 0 4px 0',
              whiteSpace: 'nowrap',
              lineHeight: '14px',
              pointerEvents: 'none',
              zIndex: 2147483645,
              opacity: 0.8,
            }}
          >
            ✓ {r.label}
          </div>
        </React.Fragment>
      ))}

      {/* Drag-select rectangle */}
      {hasDrag && (
        <div
          style={{
            position: 'fixed',
            top: dragRect.top,
            left: dragRect.left,
            width: dragRect.width,
            height: dragRect.height,
            background: DRAG_BG,
            border: `1.5px dashed ${DRAG_BORDER}`,
            pointerEvents: 'none',
            zIndex: 2147483645,
            boxSizing: 'border-box',
            borderRadius: 2,
          }}
        />
      )}

      {/* Drag preview highlights */}
      {dragPreview.map((p) => {
        const isRemove = p.action === 'remove';
        const borderColor = isRemove ? PREVIEW_REMOVE_BORDER : PREVIEW_ADD_BORDER;
        const bgColor = isRemove ? PREVIEW_REMOVE_BG : PREVIEW_ADD_BG;
        const labelBg = isRemove ? '#ef4444' : HIGHLIGHT_COLOR;
        const labelText = isRemove ? `− ${p.label}` : `+ ${p.label}`;
        return (
          <React.Fragment key={`preview-${p.selectId}`}>
            <div
              style={{
                position: 'fixed',
                top: p.top,
                left: p.left,
                width: p.width,
                height: p.height,
                border: `2px dashed ${borderColor}`,
                background: bgColor,
                pointerEvents: 'none',
                zIndex: 2147483644,
                boxSizing: 'border-box',
                borderRadius: 4,
              }}
            />
            <div
              style={{
                position: 'fixed',
                top: Math.max(0, p.top),
                left: Math.max(0, p.left),
                background: labelBg,
                color: '#fff',
                fontSize: 9,
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace",
                padding: '0px 5px',
                borderRadius: '0 0 4px 0',
                whiteSpace: 'nowrap',
                lineHeight: '14px',
                pointerEvents: 'none',
                zIndex: 2147483645,
                opacity: 0.85,
              }}
            >
              {labelText}
            </div>
          </React.Fragment>
        );
      })}

      {/* Hover highlight */}
      {hasHover && (
        <>
          <div
            style={{
              position: 'fixed',
              top: overlay.top,
              left: overlay.left,
              width: overlay.width,
              height: overlay.height,
              border: `2px solid ${HIGHLIGHT_COLOR}`,
              background: HIGHLIGHT_BG,
              pointerEvents: 'none',
              zIndex: 2147483646,
              boxSizing: 'border-box',
              transition: 'top 0.05s ease-out, left 0.05s ease-out, width 0.05s ease-out, height 0.05s ease-out',
              borderRadius: 4,
            }}
          />
          <div
            style={{
              position: 'fixed',
              top: Math.max(0, overlay.top),
              left: Math.max(0, overlay.left),
              background: HIGHLIGHT_COLOR,
              color: '#fff',
              fontSize: 10,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace",
              padding: '1px 6px',
              borderRadius: '0 0 4px 0',
              whiteSpace: 'nowrap',
              lineHeight: '16px',
              pointerEvents: 'none',
              zIndex: 2147483647,
            }}
          >
            {overlay.label}
          </div>
        </>
      )}
    </>,
    document.body,
  );
};

export default SelectionOverlay;
