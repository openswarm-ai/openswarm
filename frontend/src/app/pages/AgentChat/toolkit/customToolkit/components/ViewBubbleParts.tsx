import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Icon from '@mui/material/Icon';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewPreview from '@/app/pages/Views/ViewPreview';

interface StreamingPlaceholderProps {
  outputColor: string;
  outputIcon: string;
  outputName: string;
}

export const StreamingPlaceholder: React.FC<StreamingPlaceholderProps> = ({
  outputColor, outputIcon, outputName,
}) => {
  const c = useClaudeTokens();
  return (
    <Box sx={{ width: '100%', my: 1 }}>
      <Box
        sx={{
          borderLeft: `3px solid ${outputColor}`,
          borderRadius: '0 12px 12px 0',
          bgcolor: c.bg.surface,
          border: `1px solid ${c.border.subtle}`,
          borderLeftColor: outputColor,
          borderLeftWidth: 3,
          borderLeftStyle: 'solid',
          px: 2,
          py: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
        }}
      >
        <Icon sx={{ fontSize: 20, color: outputColor }}>{outputIcon}</Icon>
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: c.text.primary, flex: 1 }}>
          {outputName}
        </Typography>
        <Box
          sx={{
            width: 16,
            height: 16,
            border: `2px solid ${outputColor}`,
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'output-spin 0.8s linear infinite',
            '@keyframes output-spin': {
              '0%': { transform: 'rotate(0deg)' },
              '100%': { transform: 'rotate(360deg)' },
            },
          }}
        />
        <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary }}>
          Rendering…
        </Typography>
      </Box>
    </Box>
  );
};

interface ViewBubbleDialogProps {
  expanded: boolean;
  onClose: () => void;
  outputColor: string;
  outputIcon: string;
  outputName: string;
  serveUrl?: string;
  frontendCode: string;
  inputData: Record<string, any>;
  backendResult: any;
}

export const ViewBubbleDialog: React.FC<ViewBubbleDialogProps> = ({
  expanded, onClose, outputColor, outputIcon, outputName,
  serveUrl, frontendCode, inputData, backendResult,
}) => {
  const c = useClaudeTokens();
  return (
    <Dialog
      open={expanded}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          overflow: 'hidden',
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2.5,
          py: 1.25,
          borderBottom: `1px solid ${c.border.subtle}`,
          background: `linear-gradient(135deg, ${outputColor}08 0%, transparent 60%)`,
          position: 'relative',
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            bgcolor: outputColor,
          },
        }}
      >
        <Icon sx={{ fontSize: 22, color: outputColor, ml: 1 }}>{outputIcon}</Icon>
        <Typography sx={{ fontWeight: 700, flex: 1, fontSize: '1rem' }}>{outputName}</Typography>
        <IconButton onClick={onClose} size="small" sx={{ color: c.text.tertiary }}>
          <CloseIcon />
        </IconButton>
      </Box>
      <DialogContent sx={{ p: 0, flex: 1, overflow: 'hidden' }}>
        <ViewPreview
          serveUrl={serveUrl}
          frontendCode={frontendCode}
          inputData={inputData}
          backendResult={backendResult}
        />
      </DialogContent>
    </Dialog>
  );
};
