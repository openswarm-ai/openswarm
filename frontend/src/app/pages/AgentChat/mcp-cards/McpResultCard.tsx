import React from 'react';
import Box from '@mui/material/Box';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { ParsedMcpResult } from '../parsing/toolResultParsing';
import { useTermColors } from '../parsing/toolColorize';
import { useCardColors } from './cardColors';
import { GmailCard } from './GmailCard';
import { CalendarCard } from './CalendarCard';
import { DriveCard } from './DriveCard';
import { GenericMcpCard } from './GenericMcpCard';

export const McpResultCard: React.FC<{ parsed: ParsedMcpResult; compact?: boolean }> = ({ parsed, compact }) => {
  const c = useClaudeTokens();
  const tc = useTermColors();
  const { TC_BODY } = useCardColors();
  const { service, action, data, rawText } = parsed;

  if (data.error || data.is_error) {
    return (
      <Box sx={{ p: 1 }}>
        <span style={{ color: tc.STDERR_COLOR, fontSize: '0.73rem' }}>
          {data.error || data.message || JSON.stringify(data, null, 2)}
        </span>
      </Box>
    );
  }

  if (service === 'gmail') return <GmailCard data={data} action={action} hideSubjectHeader={compact} />;
  if (service === 'calendar') return <CalendarCard data={data} hideHeader={compact} />;
  if (service === 'drive' || service === 'sheets') return <DriveCard data={data} />;

  // Plain-text MCP results: render rawText capped at 6000 chars (model still sees full payload).
  const hasData = data && Object.keys(data).length > 0;
  if (!hasData && rawText && rawText.trim()) {
    const DISPLAY_CAP = 6000;
    const preview = rawText.length > DISPLAY_CAP
      ? rawText.slice(0, DISPLAY_CAP) + `\n… (${rawText.length - DISPLAY_CAP} more chars; model received full output)`
      : rawText;
    return (
      <Box sx={{ px: 1.5, py: 1 }}>
        <span style={{
          color: TC_BODY,
          fontSize: '0.72rem',
          fontFamily: c.font.sans,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          display: 'block',
          lineHeight: 1.55,
        }}>
          {preview}
        </span>
      </Box>
    );
  }

  return <GenericMcpCard data={data} />;
};
