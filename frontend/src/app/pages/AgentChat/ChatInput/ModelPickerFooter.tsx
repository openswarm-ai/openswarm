import React from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import { ClaudeTokens } from '@/shared/styles/claudeTokens';

interface PickerSummary { total: number; free: number; reasoning: number; subscription: number; apiKey: number; paid: number; longContext: number }

interface Props {
  c: ClaudeTokens;
  pickerSummary: PickerSummary;
  tooltipSlotProps: any;
}

export const ModelPickerFooter: React.FC<Props> = ({ c, pickerSummary, tooltipSlotProps }) => {
  return (
    <Box
      onClick={(e) => e.stopPropagation()}
      sx={{
        position: 'sticky', bottom: 0,
        bgcolor: c.bg.surface,
        borderTop: `1px solid ${c.border.subtle}`,
        px: 1.25, py: 0.5,
        fontSize: '0.65rem', color: c.text.ghost,
        display: 'flex', justifyContent: 'space-between',
        gap: 1,
      }}
    >
      <Box component="span" sx={{ flexShrink: 0, pointerEvents: 'none' }}>
        Type to search, Esc to close
      </Box>
      {(() => {
        const breakdown: Array<[string, number]> = ([
          ['Free',          pickerSummary.free],
          ['Subscription',  pickerSummary.subscription],
          ['API key',       pickerSummary.apiKey],
          ['Pay-per-use',   pickerSummary.paid],
          ['Reasoning',     pickerSummary.reasoning],
          ['1M+ context',   pickerSummary.longContext],
        ] as Array<[string, number]>).filter(([, n]) => n > 0);
        const breakdownTooltip = breakdown.length > 0 ? (
          <Box sx={{ fontSize: '0.74rem', lineHeight: 1.6, minWidth: 180 }}>
            <Box sx={{
              fontWeight: 600, fontSize: '0.78rem',
              color: c.text.primary,
              pb: 0.6, mb: 0.6,
              borderBottom: `1px solid ${c.border.subtle}`,
            }}>
              {pickerSummary.total} model{pickerSummary.total === 1 ? '' : 's'} available
            </Box>
            <Box sx={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              columnGap: 1.5, rowGap: 0.3,
              color: c.text.muted,
            }}>
              {breakdown.map(([label, n]) => (
                <React.Fragment key={label}>
                  <span>{label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: c.text.secondary }}>{n}</span>
                </React.Fragment>
              ))}
            </Box>
          </Box>
        ) : null;
        return (
          <Tooltip
            title={breakdownTooltip || ''}
            placement="top-end"
            enterDelay={300}
            slotProps={tooltipSlotProps}
            disableHoverListener={!breakdownTooltip}
          >
            <Box component="span" sx={{
              cursor: breakdownTooltip ? 'help' : 'default',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}>
              {pickerSummary.total} model{pickerSummary.total === 1 ? '' : 's'}
            </Box>
          </Tooltip>
        );
      })()}
    </Box>
  );
};
