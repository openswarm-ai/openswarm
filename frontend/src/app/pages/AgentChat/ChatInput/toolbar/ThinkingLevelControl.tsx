import React from 'react';
import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'auto';

interface Props {
  c: ClaudeTokens;
  model: string;
  allModelFlat: Array<any>;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  thinkingAnchor: HTMLElement | null;
  setThinkingAnchor: (el: HTMLElement | null) => void;
  menuPaperProps: { sx: any };
}

export const ThinkingLevelControl: React.FC<Props> = ({
  c, model, allModelFlat, thinkingLevel, onThinkingLevelChange, thinkingAnchor, setThinkingAnchor, menuPaperProps,
}) => {
  const currentModel = allModelFlat.find((m: any) => m.value === model) as any;
  if (!currentModel?.reasoning || !onThinkingLevelChange) return null;
  const levels: Array<{ value: ThinkingLevel; label: string; desc: string }> = [
    { value: 'auto', label: 'Auto', desc: 'Model decides (recommended)' },
    { value: 'off', label: 'Off', desc: 'No thinking (fastest)' },
    { value: 'low', label: 'Low', desc: 'Minimal thinking' },
    { value: 'medium', label: 'Medium', desc: 'Balanced' },
    { value: 'high', label: 'High', desc: 'Extensive thinking (slowest)' },
  ];
  const current = levels.find((l) => l.value === thinkingLevel) || levels[0];
  return (
    <>
      <Box
        onClick={(e) => setThinkingAnchor(e.currentTarget)}
        sx={{
          display: 'inline-flex', alignItems: 'center', gap: 0.25,
          px: 0.75, py: 0.25, borderRadius: '6px', cursor: 'pointer', userSelect: 'none',
          color: c.text.muted,
          '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
          transition: 'background 0.15s',
        }}
      >
        <PsychologyOutlinedIcon sx={{ fontSize: 14, opacity: 0.7 }} />
        <Typography sx={{ fontSize: '0.8rem', fontWeight: 500, color: 'inherit', lineHeight: 1 }}>
          {current.label}
        </Typography>
        <KeyboardArrowDownIcon sx={{ fontSize: 15, color: 'inherit', opacity: 0.7 }} />
      </Box>
      <Menu
        anchorEl={thinkingAnchor}
        open={Boolean(thinkingAnchor)}
        onClose={() => setThinkingAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: menuPaperProps }}
        autoFocus
        MenuListProps={{ autoFocusItem: true }}
      >
        <MenuItem disabled sx={{ opacity: '1 !important', py: 0.5, px: 1.5, minHeight: 'auto', pointerEvents: 'none' }}>
          <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: c.text.tertiary }}>
            Thinking Level
          </Typography>
        </MenuItem>
        {/* Gemini 3 preview rejects "thought signature" on tool-call turns when thinking is on; warn search users. */}
        {(() => {
          const isGemini3 = typeof model === 'string' && (model.includes('gemini-3') || (allModelFlat.find((m: any) => m.value === model)?.label || '').toLowerCase().includes('gemini 3'));
          if (!isGemini3 || thinkingLevel === 'off') return null;
          return (
            <MenuItem disabled sx={{ opacity: '1 !important', py: 0.6, px: 1.5, minHeight: 'auto', pointerEvents: 'none', mx: 0.5, my: 0.25, borderRadius: 1, bgcolor: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.18)' }}>
              <Typography sx={{ fontSize: '0.66rem', color: c.text.muted, lineHeight: 1.4, whiteSpace: 'normal', maxWidth: 240 }}>
                Web search breaks on Gemini 3 preview while thinking is on. Set to <strong>Off</strong> if you need search.
              </Typography>
            </MenuItem>
          );
        })()}
        {levels.map((lvl) => (
          <MenuItem
            key={lvl.value}
            selected={thinkingLevel === lvl.value}
            onClick={() => { onThinkingLevelChange(lvl.value); setThinkingAnchor(null); }}
            sx={{ py: 0.6 }}
          >
            <Box>
              <Typography sx={{ fontSize: '0.8rem', color: thinkingLevel === lvl.value ? c.text.primary : c.text.muted }}>
                {lvl.label}
              </Typography>
              <Typography sx={{ fontSize: '0.65rem', color: c.text.ghost, mt: 0.1 }}>
                {lvl.desc}
              </Typography>
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};
