import React from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CommandPicker from './CommandPicker/CommandPicker';
import { RichPromptEditorProps, LINE_HEIGHT, FONT_SIZE } from './richPromptEditorTypes';
import { useRichPromptEditor } from './useRichPromptEditor';

const RichPromptEditor: React.FC<RichPromptEditorProps> = (props) => {
  const { placeholder = '' } = props;
  const {
    c, editorRef, wrapperRef, focused, setFocused,
    hasContent, picker, setPicker, pickerRect,
    minHeight, maxHeight, isLabelFloating,
    handleInput, handleEditorClick, handlePickerSelect,
    handleKeyDown, handlePaste,
    updateHasContent, emitChange,
  } = useRichPromptEditor(props);

  return (
    <Box ref={wrapperRef} sx={{ position: 'relative' }}>
      {picker.visible && pickerRect && createPortal(
        <div
          style={{
            position: 'fixed',
            top: pickerRect.top,
            left: pickerRect.left,
            width: pickerRect.width,
            height: 0,
            zIndex: 1400,
            pointerEvents: 'none',
          }}
        >
          <div style={{ position: 'relative', width: '100%', pointerEvents: 'auto' }}>
            <CommandPicker
              trigger={picker.trigger}
              filter={picker.filter}
              onSelect={handlePickerSelect}
              onClose={() => setPicker((p) => ({ ...p, visible: false }))}
              visible={picker.visible}
            />
          </div>
        </div>,
        document.body,
      )}

      <Box
        onClick={() => editorRef.current?.focus()}
        sx={{
          position: 'relative',
          border: `1px solid ${focused ? c.accent.primary : c.border.medium}`,
          borderRadius: '4px',
          bgcolor: c.bg.page,
          transition: 'border-color 0.15s',
          '&:hover': {
            borderColor: focused ? c.accent.primary : c.text.primary,
          },
          cursor: 'text',
        }}
      >
        {props.label && (
          <Typography
            component="label"
            sx={{
              position: 'absolute',
              left: 12,
              top: isLabelFloating ? -1 : '50%',
              transform: isLabelFloating ? 'translateY(-50%) scale(0.75)' : 'translateY(-50%)',
              transformOrigin: 'top left',
              color: focused ? c.accent.primary : c.text.tertiary,
              fontSize: '1rem',
              lineHeight: 1,
              pointerEvents: 'none',
              transition: 'all 0.15s ease',
              bgcolor: isLabelFloating ? c.bg.page : 'transparent',
              px: isLabelFloating ? 0.5 : 0,
              zIndex: 1,
            }}
          >
            {props.label}
          </Typography>
        )}

        <Box sx={{ px: 1.75, pt: props.label ? 2 : 1.25, pb: 1.25, position: 'relative' }}>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onClick={handleEditorClick}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{
              width: '100%',
              minHeight: `${minHeight}rem`,
              maxHeight: `${maxHeight}rem`,
              overflowY: 'auto',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: c.text.primary,
              fontSize: `${FONT_SIZE}rem`,
              lineHeight: `${LINE_HEIGHT}`,
              fontFamily: 'inherit',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          />
          {!hasContent && (
            <div
              style={{
                position: 'absolute',
                top: props.label ? 16 : 10,
                left: 14,
                right: 14,
                color: c.text.tertiary,
                fontSize: `${FONT_SIZE}rem`,
                lineHeight: `${LINE_HEIGHT}`,
                fontFamily: 'inherit',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            >
              {placeholder}
            </div>
          )}
        </Box>
      </Box>

    </Box>
  );
};

export default RichPromptEditor;
