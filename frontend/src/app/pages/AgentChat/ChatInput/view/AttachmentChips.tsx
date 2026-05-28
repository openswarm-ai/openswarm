import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import CloseIcon from '@mui/icons-material/Close';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import AdsClickIcon from '@mui/icons-material/AdsClick';
import { getToolGroupIcon } from '@/app/components/editor/CommandPicker';
import { SelectedElement } from '@/app/components/editor/ElementSelectionContext';
import { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';
import { AttachedImage, ForcedToolGroup } from '../types';
import { formatTokenCount, pathTail } from '../helpers';

interface ElementSelectionLike {
  removeOwnerElement: (ownerId: string, id: string) => void;
}

interface Props {
  c: ClaudeTokens;
  images: AttachedImage[];
  setLightboxSrc: (src: string | null) => void;
  removeImage: (idx: number) => void;
  contextPaths: ContextPath[];
  setContextPaths: React.Dispatch<React.SetStateAction<ContextPath[]>>;
  copiedPathIdx: number | null;
  setCopiedPathIdx: React.Dispatch<React.SetStateAction<number | null>>;
  pdfSupported: boolean;
  imageSupported: boolean;
  forcedTools: ForcedToolGroup[];
  setForcedTools: React.Dispatch<React.SetStateAction<ForcedToolGroup[]>>;
  selectedElements: SelectedElement[];
  elementSelection: ElementSelectionLike | null | undefined;
  ownerId: string;
}

export const AttachmentChips: React.FC<Props> = ({
  c, images, setLightboxSrc, removeImage,
  contextPaths, setContextPaths, copiedPathIdx, setCopiedPathIdx,
  pdfSupported, imageSupported,
  forcedTools, setForcedTools,
  selectedElements, elementSelection, ownerId,
}) => {
  return (
    <>
      {images.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            gap: 0.75,
            px: 1.5,
            pt: 1,
            pb: 0.5,
            overflowX: 'auto',
            '&::-webkit-scrollbar': { height: 4 },
            '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          }}
        >
          {images.map((img, idx) => (
            <Box
              key={idx}
              sx={{
                position: 'relative',
                width: 56,
                height: 56,
                flexShrink: 0,
                borderRadius: '8px',
                overflow: 'hidden',
                border: `1px solid ${c.border.subtle}`,
                cursor: 'pointer',
                transition: 'opacity 0.15s, transform 0.15s',
                '&:hover': { opacity: 0.85, transform: 'scale(1.04)' },
              }}
              onClick={() => setLightboxSrc(img.preview)}
            >
              <img
                src={img.preview}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                sx={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  width: 18,
                  height: 18,
                  bgcolor: c.bg.surface,
                  border: `1px solid ${c.border.medium}`,
                  color: c.text.tertiary,
                  '&:hover': { bgcolor: c.bg.secondary, color: c.text.primary },
                }}
              >
                <CloseIcon sx={{ fontSize: 10 }} />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}

      {contextPaths.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: images.length > 0 ? 0.25 : 1, pb: 0 }}>
          {contextPaths.map((cp, idx) => {
            const isAppWorkspace = /\/outputs_workspace\/ws-[^/]+\/?$/.test(cp.path);
            const label = isAppWorkspace
              ? 'App files'
              : pathTail(cp.path, 2);
            return (
              <Tooltip
                key={`${cp.path}-${idx}`}
                title={copiedPathIdx === idx ? 'Copied!' : cp.path}
                arrow
                placement="top"
                slotProps={{
                  tooltip: {
                    sx: {
                      fontFamily: c.font.mono,
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              >
                {(() => {
                  const unsupported = (cp.kind === 'pdf' && !pdfSupported) ||
                                      (cp.kind === 'image' && !imageSupported) ||
                                      cp.kind === 'binary';
                  const chipColor = unsupported ? c.status.warning : c.accent.primary;
                  return (
                <Chip
                  icon={
                    cp.type === 'directory'
                      ? <FolderOpenIcon sx={{ fontSize: 14 }} />
                      : <InsertDriveFileOutlinedIcon sx={{ fontSize: 14 }} />
                  }
                  label={(() => {
                    const kindTag = cp.kind && cp.kind !== 'text' ? ` · ${cp.kind}` : '';
                    const tokTag = typeof cp.tokens === 'number' && cp.tokens > 0 ? ` · ${formatTokenCount(cp.tokens)}` : '';
                    const warn = unsupported ? ' · not on this model' : '';
                    return `${label}${kindTag}${tokTag}${warn}`;
                  })()}
                  size="small"
                  onClick={() => {
                    navigator.clipboard.writeText(cp.path);
                    setCopiedPathIdx(idx);
                    setTimeout(() => setCopiedPathIdx((cur) => cur === idx ? null : cur), 1200);
                  }}
                  onDelete={() => setContextPaths((prev) => prev.filter((_, i) => i !== idx))}
                  sx={{
                    bgcolor: `${chipColor}12`,
                    color: chipColor,
                    fontSize: '0.72rem',
                    fontFamily: c.font.mono,
                    height: 26,
                    maxWidth: 280,
                    cursor: 'pointer',
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    '& .MuiChip-deleteIcon': {
                      color: chipColor,
                      fontSize: 16,
                      '&:hover': { color: c.status.error },
                    },
                  }}
                />
                  );
                })()}
              </Tooltip>
            );
          })}
        </Box>
      )}

      {forcedTools.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (images.length > 0 || contextPaths.length > 0) ? 0.25 : 1, pb: 0 }}>
          {forcedTools.map((ft, idx) => (
            <Chip
              key={`ft-${ft.label}-${idx}`}
              icon={<>{ft.icon || getToolGroupIcon(ft.iconKey || ft.label, 14)}</>}
              label={`@${ft.label.toLowerCase()}`}
              size="small"
              onDelete={() => setForcedTools((prev) => prev.filter((_, i) => i !== idx))}
              sx={{
                bgcolor: `${c.status.info}15`,
                color: c.status.info,
                fontSize: '0.72rem',
                fontFamily: c.font.mono,
                height: 26,
                maxWidth: 220,
                '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                '& .MuiChip-deleteIcon': {
                  color: c.status.info,
                  fontSize: 16,
                  '&:hover': { color: c.status.error },
                },
              }}
            />
          ))}
        </Box>
      )}

      {selectedElements.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: (images.length > 0 || contextPaths.length > 0 || forcedTools.length > 0) ? 0.25 : 1, pb: 0 }}>
          {selectedElements.map((el) => {
            const chipLabel = el.semanticLabel
              ? el.semanticLabel
              : el.className
                ? `${el.tagName.toLowerCase()}.${el.className.split(' ')[0]}`
                : el.tagName.toLowerCase();
            const tooltipText = el.semanticType
              ? `${el.semanticType}: ${el.semanticLabel || el.selectorPath}`
              : el.selectorPath;
            return (
              <Tooltip
                key={el.id}
                title={tooltipText}
                arrow
                placement="top"
                slotProps={{
                  tooltip: {
                    sx: {
                      fontFamily: c.font.mono,
                      fontSize: '0.7rem',
                      maxWidth: 420,
                      wordBreak: 'break-all',
                    },
                  },
                }}
              >
                <Chip
                  icon={<AdsClickIcon sx={{ fontSize: 14 }} />}
                  label={chipLabel}
                  size="small"
                  onDelete={() => elementSelection?.removeOwnerElement(ownerId, el.id)}
                  sx={{
                    bgcolor: 'rgba(59, 130, 246, 0.1)',
                    color: '#3b82f6',
                    fontSize: '0.72rem',
                    fontFamily: c.font.mono,
                    height: 26,
                    maxWidth: 220,
                    '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    '& .MuiChip-deleteIcon': {
                      color: '#3b82f6',
                      fontSize: 16,
                      '&:hover': { color: c.status.error },
                    },
                    '& .MuiChip-icon': {
                      color: '#3b82f6',
                    },
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}
    </>
  );
};
