import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { ClaudeTokens } from '@/shared/styles/claudeTokens';
import type { DetailBlock, DetailDoc } from '../notionDetails';

function Heading({ block, c }: { block: Extract<DetailBlock, { type: 'heading' }>; c: ClaudeTokens }) {
  return (
    <Typography
      component="h3"
      sx={{ mt: 3.5, mb: 1.25, fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.02em', color: c.text.primary }}
    >
      {block.emoji ? `${block.emoji} ` : ''}
      {block.text}
    </Typography>
  );
}

function Paragraph({ block, c }: { block: Extract<DetailBlock, { type: 'paragraph' }>; c: ClaudeTokens }) {
  return (
    <Typography sx={{ fontSize: '0.95rem', lineHeight: 1.7, color: c.text.secondary, mb: 1.5 }}>
      {block.text}
    </Typography>
  );
}

function Callout({ block, c }: { block: Extract<DetailBlock, { type: 'callout' }>; c: ClaudeTokens }) {
  const tone = block.tone ?? 'default';
  const bg =
    tone === 'warning' ? c.status.errorBg : tone === 'info' ? `${c.accent.primary}0F` : c.bg.secondary;
  const border =
    tone === 'warning' ? `${c.status.error}33` : tone === 'info' ? `${c.accent.primary}33` : c.border.subtle;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ bgcolor: bg, border: `1px solid ${border}`, borderRadius: 2.5, p: 2, mb: 1.5 }}
    >
      {block.emoji && <Box sx={{ fontSize: '1.2rem', lineHeight: 1.4, flexShrink: 0 }}>{block.emoji}</Box>}
      <Box sx={{ minWidth: 0 }}>
        {block.title && (
          <Typography sx={{ fontSize: '0.92rem', fontWeight: 700, color: c.text.primary, mb: 0.25 }}>
            {block.title}
          </Typography>
        )}
        <Typography sx={{ fontSize: '0.92rem', lineHeight: 1.65, color: c.text.secondary }}>
          {block.text}
        </Typography>
      </Box>
    </Stack>
  );
}

function Features({ block, c }: { block: Extract<DetailBlock, { type: 'features' }>; c: ClaudeTokens }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        gap: 1.25,
        mb: 1.5,
      }}
    >
      {block.items.map((item) => (
        <Stack
          key={item.title}
          direction="row"
          spacing={1.5}
          sx={{ bgcolor: c.bg.elevated, border: `1px solid ${c.border.subtle}`, borderRadius: 2.5, p: 1.75 }}
        >
          <Box sx={{ fontSize: '1.25rem', lineHeight: 1.3, flexShrink: 0 }}>{item.emoji}</Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.9rem', fontWeight: 700, color: c.text.primary, mb: 0.25 }}>
              {item.title}
            </Typography>
            <Typography sx={{ fontSize: '0.85rem', lineHeight: 1.55, color: c.text.tertiary }}>
              {item.text}
            </Typography>
          </Box>
        </Stack>
      ))}
    </Box>
  );
}

function Steps({ block, c }: { block: Extract<DetailBlock, { type: 'steps' }>; c: ClaudeTokens }) {
  return (
    <Stack spacing={1.25} sx={{ mb: 1.5 }}>
      {block.items.map((text, i) => (
        <Stack key={i} direction="row" spacing={1.5} alignItems="flex-start">
          <Box
            sx={{
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: `${c.accent.primary}14`,
              color: c.accent.primary,
              fontSize: '0.82rem',
              fontWeight: 700,
            }}
          >
            {i + 1}
          </Box>
          <Typography sx={{ fontSize: '0.92rem', lineHeight: 1.6, color: c.text.secondary, pt: 0.25 }}>
            {text}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function Bullets({ block, c }: { block: Extract<DetailBlock, { type: 'bullets' }>; c: ClaudeTokens }) {
  return (
    <Stack spacing={0.75} sx={{ mb: 1.5 }}>
      {block.items.map((text, i) => (
        <Stack key={i} direction="row" spacing={1.25} alignItems="flex-start">
          <Box sx={{ height: 'calc(0.92rem * 1.6)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <Box sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: c.text.muted }} />
          </Box>
          <Typography sx={{ fontSize: '0.92rem', lineHeight: 1.6, color: c.text.secondary }}>{text}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function FaqItem({ q, a, c }: { q: string; a: string; c: ClaudeTokens }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 2.5, overflow: 'hidden' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
        sx={{ cursor: 'pointer', px: 2, py: 1.5, bgcolor: c.bg.elevated }}
      >
        <Typography sx={{ fontSize: '0.92rem', fontWeight: 600, color: c.text.primary }}>💡 {q}</Typography>
        <ExpandMoreIcon
          sx={{ color: c.text.muted, transform: open ? 'rotate(180deg)' : 'none', transition: c.transition }}
        />
      </Stack>
      <Collapse in={open}>
        <Typography sx={{ px: 2, py: 1.75, fontSize: '0.9rem', lineHeight: 1.65, color: c.text.secondary }}>
          {a}
        </Typography>
      </Collapse>
    </Box>
  );
}

function Faq({ block, c }: { block: Extract<DetailBlock, { type: 'faq' }>; c: ClaudeTokens }) {
  return (
    <Stack spacing={1} sx={{ mb: 1.5 }}>
      {block.items.map((item, i) => (
        <FaqItem key={i} q={item.q} a={item.a} c={c} />
      ))}
    </Stack>
  );
}

function renderBlock(block: DetailBlock, i: number, c: ClaudeTokens) {
  switch (block.type) {
    case 'heading':
      return <Heading key={i} block={block} c={c} />;
    case 'paragraph':
      return <Paragraph key={i} block={block} c={c} />;
    case 'callout':
      return <Callout key={i} block={block} c={c} />;
    case 'features':
      return <Features key={i} block={block} c={c} />;
    case 'steps':
      return <Steps key={i} block={block} c={c} />;
    case 'bullets':
      return <Bullets key={i} block={block} c={c} />;
    case 'faq':
      return <Faq key={i} block={block} c={c} />;
  }
}

export default function PackageDetails({ doc }: { doc: DetailDoc }) {
  const c = useClaudeTokens();
  return <Box>{doc.blocks.map((block, i) => renderBlock(block, i, c))}</Box>;
}
