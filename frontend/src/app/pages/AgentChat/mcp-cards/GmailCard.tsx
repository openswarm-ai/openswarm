import React from 'react';
import Box from '@mui/material/Box';
import EmailIcon from '@mui/icons-material/Email';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import SendIcon from '@mui/icons-material/Send';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useCardColors } from './cardColors';
import { extractEmailFields } from './mcpCardHelpers';

export const GmailCard: React.FC<{ data: Record<string, any>; action: string; hideSubjectHeader?: boolean }> = ({ data, action, hideSubjectHeader }) => {
  const c = useClaudeTokens();
  const { TC_BG, TC_BORDER, TC_HOVER, TC_HEADING, TC_BODY, TC_MUTED, TC_DIM, TC_ACCENT, TC_SUCCESS, TC_WARNING } = useCardColors();
  const email = extractEmailFields(data);
  const labels = data.labelIds || data.labels || [];
  const attachments = data.attachments || [];

  const isSend = action.includes('send');
  const isSearch = action.includes('search') || action.includes('list');
  const messages: any[] = data.messages || (isSearch && data.results ? data.results : []);

  if (messages.length > 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.5, pt: 1 }}>
        {messages.slice(0, 5).map((msg: any, i: number) => {
          const m = extractEmailFields(msg);
          return (
            <Box key={i} sx={{
              bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`, borderRadius: 1.5,
              px: 1.25, py: 1, display: 'flex', flexDirection: 'column', gap: 0.4,
              transition: 'background-color 0.15s',
              '&:hover': { bgcolor: TC_HOVER },
            }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
                <span style={{ color: TC_HEADING, fontSize: '0.74rem', fontWeight: 600, fontFamily: c.font.sans }}>
                  {m.subject}
                </span>
                {m.date && (
                  <span style={{ color: TC_DIM, fontSize: '0.6rem', flexShrink: 0, fontFamily: c.font.mono }}>
                    {m.date}
                  </span>
                )}
              </Box>
              {m.from && (
                <span style={{ color: TC_MUTED, fontSize: '0.68rem', fontFamily: c.font.sans }}>
                  {m.from}
                </span>
              )}
              {(m.snippet || m.bodyPreview) && (
                <span style={{ color: TC_BODY, fontSize: '0.68rem', lineHeight: 1.45, fontFamily: c.font.sans }}>
                  {(m.snippet || m.bodyPreview).slice(0, 120)}
                  {(m.snippet || m.bodyPreview).length > 120 ? '…' : ''}
                </span>
              )}
            </Box>
          );
        })}
        {messages.length > 5 && (
          <span style={{ color: TC_DIM, fontSize: '0.66rem', fontStyle: 'italic', textAlign: 'center', display: 'block' }}>
            +{messages.length - 5} more
          </span>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{
      ...(hideSubjectHeader
        ? { overflow: 'hidden' }
        : { bgcolor: TC_BG, border: `1px solid ${TC_BORDER}`, borderRadius: 1.5, mx: 1.5, my: 1, overflow: 'hidden' }),
    }}>
      {!hideSubjectHeader && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75,
          px: 1.5, py: 0.85,
          borderBottom: `1px solid ${TC_BORDER}`,
        }}>
          {isSend ? (
            <SendIcon sx={{ fontSize: 14, color: TC_SUCCESS, opacity: 0.8 }} />
          ) : (
            <EmailIcon sx={{ fontSize: 14, color: TC_ACCENT, opacity: 0.8 }} />
          )}
          <span style={{ color: TC_HEADING, fontSize: '0.78rem', fontWeight: 600, flex: 1, fontFamily: c.font.sans }}>
            {email.subject}
          </span>
        </Box>
      )}

      <Box sx={{ px: 1.5, py: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {(email.from || email.to || email.date) && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3 }}>
            {email.from && (
              <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
                <span style={{ color: TC_DIM, minWidth: 32, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>From</span>
                <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{email.from}</span>
              </Box>
            )}
            {email.to && (
              <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
                <span style={{ color: TC_DIM, minWidth: 32, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>To</span>
                <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{email.to}</span>
              </Box>
            )}
            {email.date && (
              <Box sx={{ display: 'flex', gap: 0.75, fontSize: '0.7rem', alignItems: 'baseline' }}>
                <span style={{ color: TC_DIM, minWidth: 32, fontFamily: c.font.mono, fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Date</span>
                <span style={{ color: TC_BODY, fontFamily: c.font.sans }}>{email.date}</span>
              </Box>
            )}
          </Box>
        )}

        {labels.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', mt: 0.15 }}>
            {labels.map((l: string, i: number) => (
              <Box key={i} sx={{
                display: 'inline-flex', alignItems: 'center',
                bgcolor: `${TC_ACCENT}18`, borderRadius: 0.75,
                px: 0.6, py: 0.1,
              }}>
                <span style={{ fontSize: '0.56rem', color: TC_ACCENT, fontFamily: c.font.mono, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{l}</span>
              </Box>
            ))}
          </Box>
        )}

        {(email.snippet || email.bodyPreview) && (
          <Box sx={{
            mt: 0.25, pt: 0.5, borderTop: `1px solid ${TC_BORDER}`,
            color: TC_BODY,
            fontFamily: c.font.sans,
            fontSize: '0.7rem',
            lineHeight: 1.6,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            '& p': { m: 0, mb: 0.75, '&:last-child': { mb: 0 } },
            '& h1, & h2, & h3, & h4, & h5, & h6': {
              color: TC_HEADING, fontFamily: c.font.sans,
              mt: 1, mb: 0.5, '&:first-of-type': { mt: 0 },
            },
            '& h1': { fontSize: '0.82rem' }, '& h2': { fontSize: '0.78rem' },
            '& h3': { fontSize: '0.74rem' }, '& h4, & h5, & h6': { fontSize: '0.7rem' },
            '& strong': { color: TC_HEADING, fontWeight: 600 },
            '& em': { fontStyle: 'italic' },
            '& a': { color: TC_ACCENT, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
            '& ul, & ol': { pl: 2, mb: 0.75, mt: 0 },
            '& li': { mb: 0.2 },
            '& blockquote': {
              m: 0, mb: 0.75, pl: 1, ml: 0,
              borderLeft: `2px solid ${TC_BORDER}`,
              color: TC_MUTED, fontStyle: 'italic',
            },
            '& code': {
              bgcolor: `${TC_BORDER}`, px: 0.4, py: 0.15,
              borderRadius: 0.5, fontSize: '0.65rem', fontFamily: c.font.mono,
            },
            '& pre': {
              bgcolor: `${TC_BORDER}`, borderRadius: 1, p: 1,
              overflow: 'auto', fontSize: '0.65rem', fontFamily: c.font.mono,
              m: 0, mb: 0.75,
            },
            '& pre code': { bgcolor: 'transparent', p: 0 },
            '& hr': { border: 'none', borderTop: `1px solid ${TC_BORDER}`, my: 0.75 },
            '& img': { maxWidth: '100%', borderRadius: 1 },
          }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ a: ({ children, ...props }) => <a {...props}>{children}</a> }}
            >
              {email.bodyPreview || email.snippet}
            </ReactMarkdown>
          </Box>
        )}

        {attachments.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', mt: 0.2 }}>
            {attachments.map((a: any, i: number) => (
              <Box key={i} sx={{
                display: 'inline-flex', alignItems: 'center', gap: 0.3,
                bgcolor: `${TC_WARNING}15`, borderRadius: 0.75,
                px: 0.6, py: 0.1,
              }}>
                <AttachFileIcon sx={{ fontSize: 9, color: TC_WARNING, opacity: 0.7 }} />
                <span style={{ fontSize: '0.58rem', color: TC_WARNING, fontFamily: c.font.mono }}>
                  {a.filename || a.name || 'attachment'}
                </span>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};
