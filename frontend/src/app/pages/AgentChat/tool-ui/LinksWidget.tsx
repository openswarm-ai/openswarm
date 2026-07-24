import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { LinksProps } from './showUiPayload';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Tool-UI-style link previews: domain, title, description; opens like any transcript link. */
function LinksWidget({ props }: { props: LinksProps }): React.ReactElement {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxWidth: 420 }}>
      {props.links.map((l, i) => (
        <Box
          key={`${i}-${l.url.slice(0, 40)}`}
          component="a"
          href={l.url}
          target="_blank"
          rel="noreferrer"
          sx={{
            display: 'block',
            textDecoration: 'none',
            borderRadius: '12px',
            border: `1px solid ${c.border.subtle}`,
            bgcolor: c.bg.elevated,
            px: 1.75,
            py: 1.25,
            transition: 'border-color 0.12s',
            '&:hover': { borderColor: c.border.strong },
          }}
        >
          <Typography sx={{ fontSize: '0.6875rem', color: c.text.tertiary, mb: 0.25 }}>
            {hostOf(l.url)}
          </Typography>
          <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary }}>
            {l.title}
          </Typography>
          {l.description && (
            <Typography sx={{ fontSize: '0.75rem', color: c.text.secondary, mt: 0.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {l.description}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}

export default LinksWidget;
