import React, { useState, useMemo } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Output, executeOutput, OutputExecuteResult, getFrontendCode, getBackendCode, buildServeUrl, SERVE_BASE } from '@/shared/state/outputsSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import InputSchemaForm from './InputSchemaForm';
import { getDefault } from '@/shared/inputSchemaDefaults';
import ViewPreview from './ViewPreview';

interface Props {
  output: Output;
  onClose: () => void;
}

const ViewRunDialog: React.FC<Props> = ({ output, onClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();

  const defaultInput = useMemo(() => getDefault(output.input_schema), [output.input_schema]);
  const [inputData, setInputData] = useState<Record<string, any>>(defaultInput);
  const [result, setResult] = useState<OutputExecuteResult | null>(null);
  const [running, setRunning] = useState(false);

  const warnings = result?.warnings && result.warnings.length > 0 ? result.warnings : null;
  const codePreview = result?.code_preview || null;

  const runWith = async (force: boolean) => {
    setRunning(true);
    try {
      const res = await dispatch(
        executeOutput({ output_id: output.id, input_data: inputData, force })
      ).unwrap();
      setResult(res);
    } finally {
      setRunning(false);
    }
  };

  const handleRun = () => runWith(false);
  const handleRunAnyway = () => runWith(true);

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 600, color: c.text.primary }}>
        Run: {output.name}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', gap: 3, minHeight: 400 }}>
          {/* Input form */}
          <Box sx={{ width: 340, flexShrink: 0, overflow: 'auto' }}>
            <Typography
              sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.muted, mb: 1.5 }}
            >
              Input
            </Typography>
            <InputSchemaForm
              schema={output.input_schema}
              value={inputData}
              onChange={setInputData}
            />
          </Box>

          {/* Preview */}
          <Box
            sx={{
              flex: 1,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: 2,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Box
              sx={{
                px: 1.5,
                py: 0.75,
                borderBottom: `1px solid ${c.border.subtle}`,
                bgcolor: c.bg.secondary,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: c.text.muted }}>
                Preview
              </Typography>
              {result?.error && (
                <Typography sx={{ fontSize: '0.75rem', color: c.status.error }}>
                  Backend error: {result.error}
                </Typography>
              )}
            </Box>
            <Box sx={{ flex: 1, position: 'relative' }}>
              {running && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'rgba(0,0,0,0.05)',
                    zIndex: 1,
                  }}
                >
                  <CircularProgress size={28} />
                </Box>
              )}
              {warnings && codePreview ? (
                <Box sx={{ p: 2, overflow: 'auto', height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <WarningAmberIcon sx={{ color: c.status.warning, fontSize: 22 }} />
                    <Typography sx={{ fontSize: '0.95rem', fontWeight: 600, color: c.text.primary }}>
                      Review before running
                    </Typography>
                  </Box>
                  <Typography sx={{ fontSize: '0.8rem', color: c.text.secondary }}>
                    This Output's backend code does things outside the safe
                    data-shaping allowlist. Read it and decide whether to run.
                  </Typography>
                  <Box
                    component="ul"
                    sx={{ m: 0, pl: 2.5, color: c.text.secondary, fontSize: '0.78rem', lineHeight: 1.55 }}
                  >
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </Box>
                  <Box
                    sx={{
                      flex: 1,
                      minHeight: 120,
                      mt: 0.5,
                      p: 1.25,
                      borderRadius: 1,
                      border: `1px solid ${c.border.subtle}`,
                      bgcolor: c.bg.secondary,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.74rem',
                      lineHeight: 1.5,
                      color: c.text.primary,
                      whiteSpace: 'pre',
                      overflow: 'auto',
                    }}
                  >
                    {codePreview}
                  </Box>
                </Box>
              ) : result ? (
                <ViewPreview
                  serveUrl={`${SERVE_BASE}/${output.id}/serve/index.html`}
                  frontendCode={result.frontend_code}
                  inputData={result.input_data}
                  backendResult={result.backend_result}
                />
              ) : (
                <ViewPreview
                  serveUrl={`${SERVE_BASE}/${output.id}/serve/index.html`}
                  frontendCode={getFrontendCode(output)}
                  inputData={inputData}
                />
              )}
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ color: c.text.muted }}>Close</Button>
        {warnings ? (
          <Button
            variant="contained"
            onClick={handleRunAnyway}
            disabled={running}
            sx={{ bgcolor: c.status.warning, '&:hover': { bgcolor: c.status.warning } }}
          >
            {running ? 'Running...' : 'Run anyway'}
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleRun}
            disabled={running}
            sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.hover } }}
          >
            {running ? 'Running...' : getBackendCode(output) ? 'Execute & Preview' : 'Preview'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default ViewRunDialog;
