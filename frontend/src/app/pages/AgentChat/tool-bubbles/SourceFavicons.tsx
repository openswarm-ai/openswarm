import React, { useState } from 'react';
import Box from '@mui/material/Box';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Same favicon service LibreChat ships with; the browser cards already load arbitrary sites, so
// fetching site icons adds no new exposure class.
export function faviconUrlForDomain(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

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
  const [failed, setFailed] = useState(false);
  const ring = {
    width: size,
    height: size,
    borderRadius: '50%',
    border: `1.5px solid ${c.bg.elevated}`,
    bgcolor: c.bg.secondary,
    ml: overlap ? '-6px' : 0,
    zIndex: z,
    position: 'relative' as const,
    flexShrink: 0,
  };
  if (failed) {
    // assistant-ui's fallback: the domain's first letter beats a hole in the stack.
    return (
      <Box sx={{ ...ring, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: c.text.tertiary, fontSize: size * 0.55, fontWeight: 700 }}>
        {(domain[0] || '?').toUpperCase()}
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={faviconUrlForDomain(domain)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      sx={ring}
    />
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
