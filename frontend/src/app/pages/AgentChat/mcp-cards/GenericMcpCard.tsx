import React from 'react';
import Box from '@mui/material/Box';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCardColors } from './cardColors';

export const GenericMcpCard: React.FC<{ data: Record<string, any> }> = ({ data }) => {
  const c = useClaudeTokens();
  const { TC_DIM, TC_BODY } = useCardColors();
  const entries = Object.entries(data).filter(([, v]) => v != null);

  if (entries.length === 0)
    return <span style={{ color: TC_DIM, fontStyle: 'italic', fontSize: '0.7rem', padding: '8px 12px', display: 'block' }}>(empty response)</span>;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3, px: 1.5, py: 1 }}>
      {entries.slice(0, 20).map(([key, val], i) => {
        const isLong = typeof val === 'string' && val.length > 100;
        const isObj = typeof val === 'object';
        return (
          <Box key={i} sx={{ fontSize: '0.7rem', display: 'flex', gap: 0.75, lineHeight: 1.5 }}>
            <span style={{ color: TC_DIM, minWidth: 72, flexShrink: 0, fontWeight: 500, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.03em', paddingTop: 1 }}>
              {key}
            </span>
            {isObj ? (
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: TC_BODY, fontFamily: c.font.mono, fontSize: '0.68rem',
              }}>
                {JSON.stringify(val, null, 2).slice(0, 500)}
              </pre>
            ) : isLong ? (
              <pre style={{
                margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: TC_BODY, fontFamily: c.font.sans, fontSize: '0.68rem',
              }}>
                {String(val).slice(0, 500)}{String(val).length > 500 ? '…' : ''}
              </pre>
            ) : (
              <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{String(val)}</span>
            )}
          </Box>
        );
      })}
      {entries.length > 20 && (
        <span style={{ color: TC_DIM, fontSize: '0.62rem', fontStyle: 'italic' }}>
          +{entries.length - 20} more fields
        </span>
      )}
    </Box>
  );
};
