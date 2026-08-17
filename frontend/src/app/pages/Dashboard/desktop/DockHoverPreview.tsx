import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { DockEntry } from './dockEntries';

const PREVIEW_W = 190;

interface DockHoverPreviewProps {
  entry: DockEntry;
  top: number;
  railHeight: number;
  image?: string;
}

/** The card that floats beside a hovered dock tile: a live shot when we have one, title + snippet otherwise. */
function DockHoverPreview({ entry, top, railHeight, image }: DockHoverPreviewProps): React.ReactElement {
  // A low tile's preview used to hang past the rail bottom into the canvas clip and get cut (ENG-331); the lower half anchors from the bottom and grows upward instead.
  const fromBottom = railHeight > 0 && top > railHeight / 2;
  return (
    <Box
      sx={{
        position: 'absolute',
        left: 'calc(100% + 10px)',
        ...(fromBottom
          ? { bottom: Math.max(0, railHeight - top - 44) }
          : { top: Math.max(0, top - 34) }),
        width: PREVIEW_W,
        borderRadius: '10px',
        overflow: 'hidden',
        background: image ? '#fff' : 'rgba(22,12,34,0.9)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      }}
    >
      {image && <Box component="img" src={image} alt="" sx={{ width: '100%', display: 'block' }} />}
      {/* The name rides along even under a live shot: a thumbnail of a page is not its title, and three identical glyphs need one. */}
      <Box sx={{ p: 1.25, ...(image && { background: 'rgba(22,12,34,0.9)' }) }}>
        <Typography sx={{ color: '#fff', fontSize: '0.75rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.label}
        </Typography>
        {!image && entry.snippet && (
          <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.6875rem', mt: 0.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {entry.snippet}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export default DockHoverPreview;
