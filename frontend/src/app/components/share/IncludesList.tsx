// The "what's inside this bundle" panel, shared by the Share and Import modals:
// the root entity, the dependencies pulled in with it, and any environment
// requirements (an Action the importer must enable themselves). Long bundles
// (a dashboard pulls in every agent) read as a wall, so the contents collapse
// to a one-line count by default and expand on demand. Requirements always
// show, they're the part the importer has to act on.
import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

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

const pluralize = (label: string, n: number): string => (n === 1 ? label : `${label}s`);

const IncludesList: React.FC<{ summary: BundleSummary }> = ({ summary }) => {
  const c = useClaudeTokens();
  const [expanded, setExpanded] = useState(false);
  const includes = summary.includes;

  // One quiet line: "9 agents · 1 app", in the bundle's own type order.
  const order: string[] = [];
  const byType = new Map<string, number>();
  for (const it of includes) {
    if (!byType.has(it.type)) order.push(it.type);
    byType.set(it.type, (byType.get(it.type) || 0) + 1);
  }
  const countLine = order
    .map((t) => `${byType.get(t)} ${pluralize((KIND_LABEL[t] || t).toLowerCase(), byType.get(t) || 0)}`)
    .join('  ·  ');

  const Row: React.FC<{ tag: string; name: string; detail?: string; faded?: boolean }> = ({
    tag,
    name,
    detail,
    faded,
  }) => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, py: 0.55 }}>
      <Typography
        sx={{
          fontSize: '0.62rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: c.text.tertiary,
          minWidth: 64,
          flexShrink: 0,
        }}
      >
        {tag}
      </Typography>
      <Typography
        sx={{
          fontSize: '0.85rem',
          color: faded ? c.text.muted : c.text.primary,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </Typography>
      {detail && (
        <Typography sx={{ fontSize: '0.72rem', color: c.text.muted, flexShrink: 0 }}>{detail}</Typography>
      )}
    </Box>
  );

  return (
    <Box
      sx={{
        border: `1px solid ${c.border.subtle}`,
        borderRadius: `${c.radius.lg}px`,
        bgcolor: c.bg.surface,
        px: 2,
        py: 1,
      }}
    >
      <Row tag={KIND_LABEL[summary.root.type] || summary.root.type} name={summary.root.name} />

      {includes.length > 0 && !expanded && (
        <Box
          onClick={() => setExpanded(true)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            py: 0.55,
            cursor: 'pointer',
            '&:hover .show-toggle': { color: c.accent.primary },
          }}
        >
          <Typography sx={{ fontSize: '0.82rem', color: c.text.muted }}>{countLine}</Typography>
          <Box className="show-toggle" sx={{ display: 'flex', alignItems: 'center', gap: 0.25, color: c.text.tertiary, transition: 'color 0.15s' }}>
            <Typography sx={{ fontSize: '0.72rem' }}>Show</Typography>
            <KeyboardArrowDownIcon sx={{ fontSize: 14 }} />
          </Box>
        </Box>
      )}

      {includes.length > 0 && expanded && (
        <>
          {includes.map((it, i) => (
            <Row key={`inc-${i}`} tag={KIND_LABEL[it.type] || it.type} name={it.name} detail={it.detail} />
          ))}
          <Box
            onClick={() => setExpanded(false)}
            sx={{ py: 0.4, cursor: 'pointer', color: c.text.tertiary, '&:hover': { color: c.accent.primary } }}
          >
            <Typography sx={{ fontSize: '0.72rem' }}>Hide</Typography>
          </Box>
        </>
      )}

      {summary.requirements.length > 0 && (
        <Box sx={{ mt: 0.75, pt: 0.75, borderTop: `1px solid ${c.border.subtle}` }}>
          {summary.requirements.map((r, i) => (
            <Row key={`req-${i}`} tag="Needs" name={r.label} detail={r.detail} faded />
          ))}
        </Box>
      )}
    </Box>
  );
};

export default IncludesList;
