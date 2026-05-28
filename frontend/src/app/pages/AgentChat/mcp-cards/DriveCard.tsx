import React from 'react';
import Box from '@mui/material/Box';
import FolderIcon from '@mui/icons-material/Folder';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCardColors } from './cardColors';

export const DriveCard: React.FC<{ data: Record<string, any> }> = ({ data }) => {
  const c = useClaudeTokens();
  const { TC_BG, TC_BORDER, TC_HOVER, TC_HEADING, TC_DIM, TC_WARNING } = useCardColors();
  const files: any[] = data.files || (Array.isArray(data) ? data : []);
  const single = !files.length && data.name ? data : null;

  if (single) {
    return (
      <Box sx={{
        bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`,
        borderRadius: 1.5, mx: 1.5, my: 1, px: 1.25, py: 0.85, display: 'flex', alignItems: 'center', gap: 0.75,
      }}>
        <FolderIcon sx={{ fontSize: 16, color: TC_WARNING, opacity: 0.7 }} />
        <Box>
          <span style={{ color: TC_HEADING, fontSize: '0.73rem', fontWeight: 500, display: 'block', fontFamily: c.font.sans }}>
            {single.name}
          </span>
          {single.mimeType && (
            <span style={{ color: TC_DIM, fontSize: '0.6rem', fontFamily: c.font.mono }}>{single.mimeType}</span>
          )}
        </Box>
      </Box>
    );
  }

  if (files.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, p: 1.5, pt: 1 }}>
        {files.slice(0, 8).map((f: any, i: number) => (
          <Box key={i} sx={{
            bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`,
            borderRadius: 1.5, px: 1.25, py: 0.6, display: 'flex', alignItems: 'center', gap: 0.75,
            transition: 'background-color 0.15s',
            '&:hover': { bgcolor: TC_HOVER },
          }}>
            <FolderIcon sx={{ fontSize: 13, color: TC_WARNING, opacity: 0.5 }} />
            <span style={{ color: TC_HEADING, fontSize: '0.7rem', fontFamily: c.font.sans }}>{f.name || f.id}</span>
            {f.mimeType && (
              <span style={{ color: TC_DIM, fontSize: '0.58rem', flexShrink: 0, fontFamily: c.font.mono }}>
                {f.mimeType.split('/').pop()}
              </span>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  return null;
};
