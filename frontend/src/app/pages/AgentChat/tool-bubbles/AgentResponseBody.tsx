import React from 'react';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export const AgentResponseBody: React.FC<{ open: boolean; markdown: string }> = ({ open, markdown }) => {
  const c = useClaudeTokens();
  return (
    <Collapse in={open}>
      <Box
        sx={{
          borderTop: `1px solid ${c.border.subtle}`,
          px: 1.5,
          py: 1.25,
          maxHeight: 400,
          overflowY: 'auto',
          overflowX: 'hidden',
          color: c.text.secondary,
          fontFamily: c.font.sans,
          fontSize: '0.78rem',
          lineHeight: 1.65,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          '& p': { m: 0, mb: 0.75, '&:last-child': { mb: 0 } },
          '& h1, & h2, & h3, & h4': {
            color: c.text.primary, fontFamily: c.font.sans,
            mt: 1, mb: 0.5, '&:first-of-type': { mt: 0 },
          },
          '& h1': { fontSize: '0.88rem' }, '& h2': { fontSize: '0.84rem' },
          '& h3': { fontSize: '0.8rem' }, '& h4': { fontSize: '0.78rem' },
          '& strong': { color: c.text.primary, fontWeight: 600 },
          '& a': { color: c.accent.primary, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
          '& ul, & ol': { pl: 2, mb: 0.75, mt: 0 },
          '& li': { mb: 0.2 },
          '& blockquote': {
            m: 0, mb: 0.75, pl: 1, ml: 0,
            borderLeft: `2px solid ${c.border.subtle}`,
            color: c.text.tertiary, fontStyle: 'italic',
          },
          '& code': {
            bgcolor: c.bg.secondary, px: 0.4, py: 0.15,
            borderRadius: 0.5, fontSize: '0.72rem', fontFamily: c.font.mono,
          },
          '& pre': {
            bgcolor: c.bg.secondary, borderRadius: 1, p: 1,
            overflow: 'auto', fontSize: '0.72rem', fontFamily: c.font.mono,
            m: 0, mb: 0.75,
          },
          '& pre code': { bgcolor: 'transparent', p: 0 },
          '& hr': { border: 'none', borderTop: `1px solid ${c.border.subtle}`, my: 0.75 },
          '&::-webkit-scrollbar': { width: 5 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3 },
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, ...props }) => (
              <a {...props}>{children}</a>
            ),
          }}
        >
          {markdown}
        </ReactMarkdown>
      </Box>
    </Collapse>
  );
};
