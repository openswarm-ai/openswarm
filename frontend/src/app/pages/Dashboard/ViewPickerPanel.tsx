import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import Icon from '@mui/material/Icon';
import SearchIcon from '@mui/icons-material/Search';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { App } from '@/shared/backend-bridge/apps/app_builder';

interface ViewPickerPanelProps {
  searchInputRef: React.RefObject<HTMLInputElement>;
  viewSearch: string;
  onSearchChange: (q: string) => void;
  filteredOutputs: App[];
  outputList: App[];
  onSelect: (output: App) => void;
  c: ClaudeTokens;
}

export default function ViewPickerPanel({
  searchInputRef, viewSearch, onSearchChange,
  filteredOutputs, outputList, onSelect, c,
}: ViewPickerPanelProps) {
  return (
    <div style={{ width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
        <SearchIcon sx={{ fontSize: 18, color: c.text.muted }} />
        <InputBase
          inputRef={searchInputRef}
          value={viewSearch}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search apps..."
          sx={{
            flex: 1,
            fontSize: '0.85rem',
            color: c.text.primary,
            fontFamily: c.font.sans,
            '& input::placeholder': { color: c.text.ghost, opacity: 1 },
          }}
        />
      </Box>
      <Box
        sx={{
          maxHeight: 400,
          overflow: 'auto',
          borderTop: `1px solid ${c.border.subtle}`,
          '&::-webkit-scrollbar': { width: 4 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
          scrollbarWidth: 'thin',
          scrollbarColor: `${c.border.medium} transparent`,
        }}
      >
        {filteredOutputs.length === 0 ? (
          <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
            <Typography sx={{ fontSize: '0.82rem', color: c.text.muted }}>
              {outputList.length === 0 ? 'No apps created yet' : 'No matching apps'}
            </Typography>
          </Box>
        ) : (
          filteredOutputs.map((output) => (
            <Box
              key={output.id}
              onClick={() => onSelect(output)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: 1.5,
                py: 1,
                cursor: 'pointer',
                transition: 'background-color 0.1s',
                '&:hover': { bgcolor: c.bg.elevated },
              }}
            >
              {output.thumbnail ? (
                <Box
                  component="img"
                  src={output.thumbnail}
                  alt={output.name}
                  sx={{
                    width: 144,
                    height: 96,
                    borderRadius: '6px',
                    objectFit: 'cover',
                    objectPosition: 'top left',
                    flexShrink: 0,
                    border: `1px solid ${c.border.subtle}`,
                  }}
                />
              ) : (
                <Box
                  sx={{
                    width: 144,
                    height: 96,
                    borderRadius: '6px',
                    flexShrink: 0,
                    border: `1px solid ${c.border.subtle}`,
                    bgcolor: c.accent.primary + '12',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon sx={{ fontSize: 32, color: c.accent.primary, opacity: 0.7 }}>
                    {output.icon || 'view_quilt'}
                  </Icon>
                </Box>
              )}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: '0.82rem',
                    fontWeight: 500,
                    color: c.text.primary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {output.name}
                </Typography>
                {output.description && (
                  <Typography
                    sx={{
                      fontSize: '0.72rem',
                      color: c.text.muted,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {output.description}
                  </Typography>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </div>
  );
}
