import React, { useState, useMemo } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { Output, executeOutput, OutputExecuteResult, getFrontendCode, getBackendCode, buildServeUrl } from '@/shared/state/outputsSlice';
import { useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import InputSchemaForm, { getDefault } from './InputSchemaForm';
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

  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await dispatch(
        executeOutput({ output_id: output.id, input_data: inputData })
      ).unwrap();
      setResult(res);
    } finally {
      setRunning(false);
    }
  };

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
              {result ? (
                <ViewPreview
                  serveUrl={`/api/outputs/${output.id}/serve/index.html`}
                  frontendCode={result.frontend_code}
                  inputData={result.input_data}
                  backendResult={result.backend_result}
                />
              ) : (
                <ViewPreview
                  serveUrl={`/api/outputs/${output.id}/serve/index.html`}
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
        <Button
          variant="contained"
          onClick={handleRun}
          disabled={running}
          sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.hover } }}
        >
          {running ? 'Running...' : getBackendCode(output) ? 'Execute & Preview' : 'Preview'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ViewRunDialog;
