import React from 'react';
import Box from '@mui/material/Box';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { brandIconForDomain, monogramHue } from './domainBrand';

interface DomainIconProps {
  domain: string;
  size: number;
  shape?: 'circle' | 'rounded';
}

// Brand glyphs render in the neutral text tone: several brand hexes (GitHub's near-black) vanish on the dark theme.
export const DomainIcon: React.FC<DomainIconProps> = ({ domain, size, shape = 'rounded' }) => {
  const c = useClaudeTokens();
  const icon = brandIconForDomain(domain);
  if (icon) {
    return (
      <Box component="span" sx={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
          <path d={icon.path} fill={c.text.secondary} />
        </svg>
      </Box>
    );
  }
  return (
    <Box
      component="span"
      sx={{
        width: size,
        height: size,
        borderRadius: shape === 'circle' ? '50%' : `${Math.max(2, Math.round(size * 0.2))}px`,
        bgcolor: `hsl(${monogramHue(domain)} 42% 46%)`,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.62,
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {(domain.replace(/^www\./, '')[0] ?? '?').toUpperCase()}
    </Box>
  );
};
