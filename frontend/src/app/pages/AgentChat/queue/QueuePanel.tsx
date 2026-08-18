import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import CheckIcon from '@mui/icons-material/Check';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { MessageQueue } from './useMessageQueue';

// The pending-send queue chip + expandable, editable, reorderable list above the composer. Renders nothing
// when the queue is empty. All queue mutation lives in the useMessageQueue hook; this is presentational.
export function QueuePanel({ queue, c }: { queue: MessageQueue; c: ReturnType<typeof useClaudeTokens> }) {
  if (queue.length === 0) return null;
  return (
    <Box sx={{ ml: 3, mr: 1.5 }}>
      <Box
        onClick={() => { queue.setExpanded((v) => !v); queue.setEditingIdx(null); }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.25,
          py: 0.25,
          borderRadius: '8px 8px 0 0',
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.subtle}`,
          borderBottom: 'none',
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: c.bg.secondary },
          transition: 'background 0.12s',
        }}
      >
        {queue.expanded
          ? <KeyboardArrowDownIcon sx={{ fontSize: 12, color: c.text.tertiary }} />
          : <KeyboardArrowUpIcon sx={{ fontSize: 12, color: c.text.tertiary }} />
        }
        <Typography sx={{ fontSize: '0.6875rem', fontWeight: 600, color: c.text.muted, letterSpacing: 0.2 }}>
          {queue.length} queued
        </Typography>
        <Tooltip title="Clear all">
          <IconButton
            size="small"
            onClick={(e) => { e.stopPropagation(); queue.clear(); }}
            sx={{ p: 0.15, color: c.text.tertiary, '&:hover': { color: c.status.error } }}
          >
            <CloseIcon sx={{ fontSize: 10 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {queue.expanded && (
        <Box
          sx={{
            bgcolor: c.bg.surface,
            border: `1px solid ${c.border.subtle}`,
            borderBottom: 'none',
            borderRadius: '0 8px 0 0',
            maxHeight: 240,
            overflowY: 'auto',
            '&::-webkit-scrollbar': { width: 4 },
            '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          }}
        >
          {queue.ref.current.map((msg, idx) => (
            <Box
              key={idx}
              draggable={queue.editingIdx !== idx}
              onDragStart={(e) => {
                queue.setDragIdx(idx);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (queue.dragIdx !== null && queue.dragIdx !== idx) queue.setDropTargetIdx(idx);
              }}
              onDragLeave={() => { if (queue.dropTargetIdx === idx) queue.setDropTargetIdx(null); }}
              onDrop={(e) => {
                e.preventDefault();
                if (queue.dragIdx !== null && queue.dragIdx !== idx) {
                  queue.reorder(queue.dragIdx, idx);
                }
                queue.setDragIdx(null);
                queue.setDropTargetIdx(null);
              }}
              onDragEnd={() => { queue.setDragIdx(null); queue.setDropTargetIdx(null); }}
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 0.75,
                px: 1.5,
                py: 1,
                borderBottom: idx < queue.length - 1 ? `1px solid ${c.border.subtle}` : 'none',
                '&:hover': { bgcolor: c.bg.secondary },
                transition: 'background 0.1s, opacity 0.15s',
                ...(queue.dragIdx === idx ? { opacity: 0.35 } : {}),
                ...(queue.dropTargetIdx === idx && queue.dragIdx !== null && queue.dragIdx !== idx
                  ? { borderTop: `2px solid ${c.accent.primary}` }
                  : {}),
              }}
            >
              <Box
                sx={{
                  cursor: queue.editingIdx === idx ? 'default' : 'grab',
                  display: 'flex',
                  alignItems: 'center',
                  mt: 0.3,
                  color: c.text.ghost,
                  '&:hover': { color: c.text.tertiary },
                  '&:active': { cursor: 'grabbing' },
                }}
              >
                <DragIndicatorIcon sx={{ fontSize: 14 }} />
              </Box>
              {queue.editingIdx === idx ? (
                <Box sx={{ flex: 1, display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
                  <TextField
                    multiline
                    fullWidth
                    size="small"
                    value={queue.editingText}
                    onChange={(e) => queue.setEditingText(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const trimmed = queue.editingText.trim();
                        if (trimmed) queue.commitEdit(idx, trimmed);
                        queue.setEditingIdx(null);
                      }
                      if (e.key === 'Escape') queue.setEditingIdx(null);
                    }}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        fontSize: '0.75rem',
                        color: c.text.primary,
                        '& fieldset': { borderColor: c.border.medium },
                        '&.Mui-focused fieldset': { borderColor: c.accent.primary },
                      },
                    }}
                  />
                  <IconButton
                    size="small"
                    onClick={() => {
                      const trimmed = queue.editingText.trim();
                      if (trimmed) queue.commitEdit(idx, trimmed);
                      queue.setEditingIdx(null);
                    }}
                    sx={{ p: 0.25, color: c.accent.primary, mt: 0.25 }}
                  >
                    <CheckIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </Box>
              ) : (
                <Typography
                  sx={{
                    flex: 1,
                    fontSize: '0.75rem',
                    color: c.text.secondary,
                    lineHeight: 1.5,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    wordBreak: 'break-word',
                  }}
                >
                  {msg.prompt}
                </Typography>
              )}
              {queue.editingIdx !== idx && (
                <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0, mt: 0.15 }}>
                  <Tooltip title="Edit">
                    <IconButton
                      size="small"
                      onClick={() => { queue.setEditingIdx(idx); queue.setEditingText(msg.prompt); }}
                      sx={{ p: 0.25, color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
                    >
                      <EditOutlinedIcon sx={{ fontSize: 13 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Remove">
                    <IconButton
                      size="small"
                      onClick={() => queue.remove(idx)}
                      sx={{ p: 0.25, color: c.text.tertiary, '&:hover': { color: c.status.error } }}
                    >
                      <DeleteOutlineIcon sx={{ fontSize: 13 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
