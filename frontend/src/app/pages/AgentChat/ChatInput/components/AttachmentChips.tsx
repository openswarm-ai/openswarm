import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import { getToolGroupIcon } from '@/app/components/CommandPicker';
import type { SelectedElement } from '@/app/components/ElementSelectionContext';
import type { ContextPath } from '@/shared/state/agentsTypes';

export interface ForcedToolGroup {
  label: string;
  tools: string[];
  icon?: React.ReactNode;
  iconKey?: string;
}

interface Props {
  contextPaths: ContextPath[];
  onRemoveContextPath: (idx: number) => void;
  copiedPathIdx: number | null;
  onCopyPath: (idx: number) => void;
  forcedTools: ForcedToolGroup[];
  onRemoveForcedTool: (idx: number) => void;
  selectedElements: SelectedElement[];
  onRemoveElement: (id: string) => void;
  hasImages: boolean;
  c: {
    accent: { primary: string };
    font: { mono: string };
    status: { error: string; info: string };
  };
}

const AttachmentChips: React.FC<Props> = ({
  contextPaths, onRemoveContextPath, copiedPathIdx, onCopyPath,
  forcedTools, onRemoveForcedTool,
  selectedElements, onRemoveElement,
  hasImages, c,
}) => (
  <>
    {contextPaths.length > 0 && (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: hasImages ? 0.25 : 1, pb: 0 }}>
        {contextPaths.map((cp, idx) => {
          const label = cp.path.split('/').filter(Boolean).slice(-2).join('/');
          return (
            <Tooltip key={`${cp.path}-${idx}`} title={copiedPathIdx === idx ? 'Copied!' : cp.path}
              arrow placement="top"
              slotProps={{ tooltip: { sx: { fontFamily: c.font.mono, fontSize: '0.7rem', maxWidth: 420, wordBreak: 'break-all' } } }}>
              <Chip
                icon={cp.type === 'directory' ? <FolderOpenIcon sx={{ fontSize: 14 }} /> : <InsertDriveFileOutlinedIcon sx={{ fontSize: 14 }} />}
                label={label} size="small"
                onClick={() => onCopyPath(idx)}
                onDelete={() => onRemoveContextPath(idx)}
                sx={{
                  bgcolor: `${c.accent.primary}12`, color: c.accent.primary,
                  fontSize: '0.72rem', fontFamily: c.font.mono, height: 26, maxWidth: 220, cursor: 'pointer',
                  '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                  '& .MuiChip-deleteIcon': { color: c.accent.primary, fontSize: 16, '&:hover': { color: c.status.error } },
                }}
              />
            </Tooltip>
          );
        })}
      </Box>
    )}

    {forcedTools.length > 0 && (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (hasImages || contextPaths.length > 0) ? 0.25 : 1, pb: 0 }}>
        {forcedTools.map((ft, idx) => (
          <Chip key={`ft-${ft.label}-${idx}`}
            icon={<>{ft.icon || getToolGroupIcon(ft.iconKey || ft.label, 14)}</>}
            label={`@${ft.label.toLowerCase()}`} size="small"
            onDelete={() => onRemoveForcedTool(idx)}
            sx={{
              bgcolor: `${c.status.info}15`, color: c.status.info,
              fontSize: '0.72rem', fontFamily: c.font.mono, height: 26, maxWidth: 220,
              '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
              '& .MuiChip-deleteIcon': { color: c.status.info, fontSize: 16, '&:hover': { color: c.status.error } },
            }}
          />
        ))}
      </Box>
    )}

    {selectedElements.length > 0 && (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5,
        pt: (hasImages || contextPaths.length > 0 || forcedTools.length > 0) ? 0.25 : 1, pb: 0 }}>
        {selectedElements.map((el) => {
          const chipLabel = el.semanticLabel ? el.semanticLabel
            : el.className ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}`
            : el.tagName.toLowerCase();
          const tooltipText = el.semanticType
            ? `${el.semanticType}: ${el.semanticLabel || el.selectorPath}`
            : el.selectorPath;
          return (
            <Tooltip key={el.id} title={tooltipText} arrow placement="top"
              slotProps={{ tooltip: { sx: { fontFamily: c.font.mono, fontSize: '0.7rem', maxWidth: 420, wordBreak: 'break-all' } } }}>
              <Chip icon={<AdsClickIcon sx={{ fontSize: 14 }} />} label={chipLabel} size="small"
                onDelete={() => onRemoveElement(el.id)}
                sx={{
                  bgcolor: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6',
                  fontSize: '0.72rem', fontFamily: c.font.mono, height: 26, maxWidth: 220,
                  '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                  '& .MuiChip-deleteIcon': { color: '#3b82f6', fontSize: 16, '&:hover': { color: c.status.error } },
                  '& .MuiChip-icon': { color: '#3b82f6' },
                }}
              />
            </Tooltip>
          );
        })}
      </Box>
    )}
  </>
);

export default AttachmentChips;
