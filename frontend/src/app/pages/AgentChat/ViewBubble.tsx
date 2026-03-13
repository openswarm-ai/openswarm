import React, { useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Icon from '@mui/material/Icon';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ViewPreview from '../Views/ViewPreview';

interface Props {
  toolInput: Record<string, any>;
  toolResult?: string | Record<string, any>;
  isStreaming?: boolean;
}

const ViewBubble: React.FC<Props> = ({ toolInput, toolResult, isStreaming }) => {
  const c = useClaudeTokens();
  const [expanded, setExpanded] = useState(false);
  const [showInputs, setShowInputs] = useState(false);

  const outputId = toolInput?.output_id;
  const inputData = toolInput?.input_data || {};
  const outputsMap = useAppSelector((state) => state.outputs.items);
  const output = outputId ? outputsMap[outputId] : null;

  const parsedResult = useMemo(() => {
    if (!toolResult) return null;
    if (typeof toolResult === 'object') return toolResult;
    try { return JSON.parse(toolResult as string); } catch { return null; }
  }, [toolResult]);

  const frontendCode = parsedResult?.frontend_code || (output?.files?.['index.html'] ?? '') || '';
  const backendResult = parsedResult?.backend_result || null;
  const outputName = parsedResult?.output_name || output?.name || 'View';
  const outputColor = c.accent.primary;
  const outputIcon = output?.icon || 'view_quilt';
  const hasPreview = !!frontendCode.trim();
  const serveUrl = outputId ? `/api/outputs/${outputId}/serve/index.html` : undefined;
  const inputEntries = Object.entries(inputData);

  if (isStreaming && !hasPreview) {
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
  }

  return (
    <>
      <Box sx={{ width: '100%', my: 1.5 }}>
        <Box
          sx={{
            borderRadius: '12px',
            overflow: 'hidden',
            bgcolor: c.bg.surface,
            boxShadow: c.shadow.md,
            border: `1px solid ${c.border.medium}`,
            position: 'relative',
            '&::before': {
              content: '""',
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 4,
              bgcolor: outputColor,
              borderRadius: '12px 0 0 12px',
              zIndex: 1,
            },
          }}
        >
          {/* Header */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              px: 2.5,
              py: 1.25,
              pl: 3,
              background: `linear-gradient(135deg, ${outputColor}08 0%, transparent 60%)`,
              borderBottom: `1px solid ${c.border.subtle}`,
            }}
          >
            <Icon sx={{ fontSize: 22, color: outputColor }}>{outputIcon}</Icon>
            <Typography
              sx={{
                fontSize: '0.95rem',
                fontWeight: 700,
                color: c.text.primary,
                flex: 1,
                letterSpacing: '-0.01em',
              }}
            >
              {outputName}
            </Typography>
            {inputEntries.length > 0 && (
              <IconButton
                size="small"
                onClick={() => setShowInputs(!showInputs)}
                sx={{
                  color: c.text.tertiary,
                  p: 0.5,
                  transform: showInputs ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s ease',
                }}
              >
                <ExpandMoreIcon sx={{ fontSize: 18 }} />
              </IconButton>
            )}
            {hasPreview && (
              <IconButton
                size="small"
                onClick={() => setExpanded(true)}
                sx={{ color: c.text.tertiary, p: 0.5, '&:hover': { color: outputColor } }}
              >
                <OpenInFullIcon sx={{ fontSize: 16 }} />
              </IconButton>
            )}
          </Box>

          {/* Collapsible input params */}
          <Collapse in={showInputs}>
            <Box
              sx={{
                px: 2.5,
                pl: 3,
                py: 1,
                bgcolor: c.bg.secondary,
                borderBottom: `1px solid ${c.border.subtle}`,
              }}
            >
              {inputEntries.map(([key, val]) => {
                const display = typeof val === 'string' ? val : JSON.stringify(val);
                return (
                  <Box key={key} sx={{ display: 'flex', gap: 1, py: 0.25 }}>
                    <Typography sx={{ fontSize: '0.72rem', color: c.text.tertiary, fontFamily: c.font.mono, minWidth: 80 }}>
                      {key}
                    </Typography>
                    <Typography sx={{ fontSize: '0.72rem', color: c.text.secondary, fontFamily: c.font.mono, wordBreak: 'break-word' }}>
                      {display.length > 120 ? display.slice(0, 120) + '…' : display}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          </Collapse>

          {/* Preview */}
          {hasPreview && (
            <Box
              sx={{
                height: 350,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <ViewPreview
                serveUrl={serveUrl}
                frontendCode={frontendCode}
                inputData={inputData}
                backendResult={backendResult}
              />
            </Box>
          )}

          {parsedResult?.error && (
            <Box sx={{ px: 2.5, pl: 3, py: 1, bgcolor: c.status.errorBg, borderTop: `1px solid ${c.border.subtle}` }}>
              <Typography sx={{ fontSize: '0.75rem', color: c.status.error }}>
                {parsedResult.error}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* Fullscreen dialog */}
      <Dialog
        open={expanded}
        onClose={() => setExpanded(false)}
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
          <IconButton onClick={() => setExpanded(false)} size="small" sx={{ color: c.text.tertiary }}>
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
    </>
  );
};

export default ViewBubble;
