import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckIcon from '@mui/icons-material/Check';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export const BODY_FS = '0.88rem';
export const LABEL_FS = '0.82rem';
export const HINT_FS = '0.78rem';
export const INPUT_FS = '0.88rem';

export function FieldRow({ label, children, align }: { label: string; children: React.ReactNode; align?: 'top' | 'center' }) {
  const c = useClaudeTokens();
  return (
    <Box sx={{ display: 'flex', alignItems: align === 'top' ? 'flex-start' : 'center', gap: 1 }}>
      <Typography sx={{ width: 100, flexShrink: 0, fontSize: LABEL_FS, color: c.text.secondary, mt: align === 'top' ? 0.75 : 0, fontWeight: 500 }}>{label}:</Typography>
      {children}
    </Box>
  );
}

type ActionBtnTone = 'muted' | 'success' | 'danger';

export function ActionBtn({ label, tone, disabled, onClick, icon }: { label: string; tone: ActionBtnTone; disabled?: boolean; onClick: () => void; icon?: 'trash' | 'check' }) {
  const c = useClaudeTokens();
  const palette = tone === 'success'
    ? { color: c.status.success, bg: c.status.successBg, border: c.status.success + '60', hover: c.status.success + '30' }
    : tone === 'danger'
      ? { color: c.status.error, bg: c.status.errorBg, border: c.status.error + '60', hover: c.status.error + '30' }
      : { color: c.text.secondary, bg: c.bg.secondary, border: c.border.subtle, hover: c.bg.elevated };
  return (
    <Box
      onClick={disabled ? undefined : onClick}
      role="button"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: 0.45,
        fontSize: LABEL_FS, fontWeight: 600, px: 1.25, py: 0.5,
        borderRadius: c.radius.full,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: palette.color,
        bgcolor: palette.bg,
        border: `1px solid ${palette.border}`,
        opacity: disabled ? 0.5 : 1,
        '&:hover': { bgcolor: palette.hover },
      }}>
      {icon === 'trash' && <DeleteOutlineIcon sx={{ fontSize: 15 }} />}
      {icon === 'check' && <CheckIcon sx={{ fontSize: 15 }} />}
      {label}
    </Box>
  );
}
