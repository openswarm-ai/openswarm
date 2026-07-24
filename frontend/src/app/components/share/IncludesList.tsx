// The "what's inside this bundle" panel, shared by the Share and Import modals. Kept deliberately spare: the bundle's name already lives in the modal title, so here it's just one line of type + counts, the requirements as small icon chips, and an optional expand for the full contents. No boxes, the modal's whitespace does the grouping.
import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';

import { BundleSummary } from './shareTypes';

const KIND_LABEL: Record<string, string> = {
  skill: 'Skill',
  app: 'App',
  dashboard: 'Dashboard',
  mode: 'Mode',
  workflow: 'Workflow',
  session: 'Agent',
};

// One glyph per requirement kind, so needs read as icons + names, not sentences.
const REQ_ICON: Record<string, React.ReactNode> = {
  mcp_action: <ExtensionOutlinedIcon sx={{ fontSize: 14 }} />,
  api_key: <KeyOutlinedIcon sx={{ fontSize: 14 }} />,
  builtin_mode: <TuneOutlinedIcon sx={{ fontSize: 14 }} />,
};

const pluralize = (label: string, n: number): string => (n === 1 ? label : `${label}s`);

const IncludesList: React.FC<{ summary: BundleSummary }> = ({ summary }) => {
  const c = useClaudeTokens();
  const [expanded, setExpanded] = useState(false);
  const includes = summary.includes;

  // "9 agents · 1 app", in the bundle's own type order.
  const order: string[] = [];
  const byType = new Map<string, number>();
  for (const it of includes) {
    if (!byType.has(it.type)) order.push(it.type);
    byType.set(it.type, (byType.get(it.type) || 0) + 1);
  }
  const countLine = order
    .map((t) => `${byType.get(t)} ${pluralize((KIND_LABEL[t] || t).toLowerCase(), byType.get(t) || 0)}`)
    .join('  ·  ');
  const rootLabel = KIND_LABEL[summary.root.type] || summary.root.type;

  return (
    <Box>
      {/* Lead: the bundle's type + a one-line count. The name is in the title. */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography sx={{ fontSize: '0.875rem', color: c.text.muted }}>
          <Box component="span" sx={{ color: c.text.primary, fontWeight: 600 }}>{rootLabel}</Box>
          {countLine && `  ·  ${countLine}`}
        </Typography>
        {includes.length > 0 && (
          <Box
            onClick={() => setExpanded((v) => !v)}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: c.text.tertiary, cursor: 'pointer', '&:hover': { color: c.accent.primary } }}
          >
            <Typography sx={{ fontSize: '0.75rem' }}>{expanded ? 'Hide' : 'Show'}</Typography>
            <KeyboardArrowDownIcon sx={{ fontSize: 14, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.18s' }} />
          </Box>
        )}
      </Box>

      {expanded && includes.length > 0 && (
        <Box sx={{ mt: 0.5, maxHeight: 184, overflowY: 'auto' }}>
          {includes.map((it, i) => (
            <Box key={`inc-${i}`} sx={{ display: 'flex', gap: 1, py: 0.4 }}>
              <Typography sx={{ fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: c.text.tertiary, minWidth: 56, flexShrink: 0, mt: '2px' }}>
                {KIND_LABEL[it.type] || it.type}
              </Typography>
              <Typography sx={{ fontSize: '0.8125rem', color: c.text.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.name}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      {summary.requirements.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, mt: 1.5 }}>
          <Typography sx={{ fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: c.text.tertiary, mr: 0.25 }}>
            Needs
          </Typography>
          {summary.requirements.map((r, i) => (
            <Tooltip key={`req-${i}`} title={r.detail || ''} placement="top" arrow disableInteractive>
              <Box
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: 0.5,
                  px: 1, py: 0.4, borderRadius: '999px',
                  border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.elevated,
                  color: c.text.tertiary, cursor: 'default',
                }}
              >
                {REQ_ICON[r.kind] || <ExtensionOutlinedIcon sx={{ fontSize: 14 }} />}
                <Typography sx={{ fontSize: '0.75rem', color: c.text.secondary, whiteSpace: 'nowrap' }}>
                  {r.label}
                </Typography>
              </Box>
            </Tooltip>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default IncludesList;
