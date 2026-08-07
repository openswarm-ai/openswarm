import React from 'react';
import Box from '@mui/material/Box';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { DomainIcon } from './DomainIcon';

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  }
}

const MAX_STACK = 3;

const FaviconDot: React.FC<{ domain: string; size: number; overlap: boolean; z: number }> = ({ domain, size, overlap, z }) => {
  const c = useClaudeTokens();
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `1.5px solid ${c.bg.elevated}`,
        bgcolor: c.bg.secondary,
        ml: overlap ? '-6px' : 0,
        zIndex: z,
        position: 'relative',
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <DomainIcon domain={domain} size={size - 4} shape="circle" />
    </Box>
  );
};

/** Perplexity-style overlapping favicon stack for web-source rows. */
export const SourceFavicons: React.FC<{ domains: string[]; size?: number }> = ({ domains, size = 16 }) => {
  const c = useClaudeTokens();
  if (domains.length === 0) return null;
  const shown = domains.slice(0, MAX_STACK);
  const extra = domains.length - shown.length;
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      {shown.map((d, i) => (
        <FaviconDot key={d} domain={d} size={size} overlap={i !== 0} z={MAX_STACK - i} />
      ))}
      {extra > 0 && (
        <Box
          sx={{
            ml: '-6px',
            minWidth: size,
            height: size,
            px: 0.4,
            borderRadius: 999,
            border: `1.5px solid ${c.bg.elevated}`,
            bgcolor: c.bg.secondary,
            color: c.text.tertiary,
            fontSize: '0.625rem',
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          +{extra}
        </Box>
      )}
    </Box>
  );
};
