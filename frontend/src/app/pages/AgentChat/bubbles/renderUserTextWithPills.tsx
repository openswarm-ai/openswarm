import React from 'react';
import Chip from '@mui/material/Chip';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { SKILL_COLOR } from '@/app/components/editor/richEditorUtils';

const SKILL_PILL_RE = /\{\{skill:([^}]+)\}\}/g;

export function renderUserTextWithPills(text: string, c: ReturnType<typeof useClaudeTokens>): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(SKILL_PILL_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const skillName = match[1];
    parts.push(
      <Chip
        key={`skill-${match.index}`}
        icon={<PsychologyOutlinedIcon sx={{ fontSize: 12 }} />}
        label={skillName}
        size="small"
        sx={{
          bgcolor: `${SKILL_COLOR}18`,
          color: SKILL_COLOR,
          fontSize: '0.75rem',
          fontFamily: c.font.mono,
          height: 20,
          mx: 0.25,
          verticalAlign: 'baseline',
          '& .MuiChip-icon': { color: SKILL_COLOR },
        }}
      />,
    );
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}
