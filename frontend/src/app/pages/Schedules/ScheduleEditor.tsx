import React, { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createSchedule, updateSchedule, fetchSchedules } from '@/shared/state/schedulesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  open: boolean;
  scheduleId: string | null;
  onClose: () => void;
}

const TRIGGER_TYPES = [
  { value: 'cron', label: 'Cron Expression' },
  { value: 'interval', label: 'Interval' },
  { value: 'once', label: 'One-shot' },
];

const ACTION_TYPES = [
  { value: 'new_session', label: 'Create New Session' },
  { value: 'message_existing', label: 'Message Existing Session' },
];

const ScheduleEditor: React.FC<Props> = ({ open, scheduleId, onClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const existing = useAppSelector((s) => scheduleId ? s.schedules.items[scheduleId] : null);
  const dashboards = useAppSelector((s) => s.dashboards.items);
  const templates = useAppSelector((s) => s.templates.items);
  const dashboardList = Object.values(dashboards);
  const templateList = Object.values(templates);

  const [name, setName] = useState('');
  const [dashboardId, setDashboardId] = useState('');
  const [triggerType, setTriggerType] = useState('cron');
  const [cronExpression, setCronExpression] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [runAt, setRunAt] = useState('');
  const [actionType, setActionType] = useState('new_session');
  const [prompt, setPrompt] = useState('');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [model, setModel] = useState('sonnet');
  const [mode, setMode] = useState('agent');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [targetDirectory, setTargetDirectory] = useState('');
  const [configSource, setConfigSource] = useState<'template' | 'inline'>('inline');

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDashboardId(existing.dashboard_id);
      setTriggerType(existing.trigger_type);
      setCronExpression(existing.cron_expression || '');
      setIntervalSeconds(existing.interval_seconds || 3600);
      setRunAt(existing.run_at || '');
      setActionType(existing.action_type);
      setPrompt(existing.prompt);
      setTargetSessionId(existing.target_session_id || '');
      setTemplateId(existing.template_id || '');
      setModel(existing.model || 'sonnet');
      setMode(existing.mode || 'agent');
      setSystemPrompt(existing.system_prompt || '');
      setTargetDirectory(existing.target_directory || '');
      setConfigSource(existing.template_id ? 'template' : 'inline');
    } else {
      setName('');
      setDashboardId(dashboardList[0]?.id || '');
      setTriggerType('cron');
      setCronExpression('');
      setIntervalSeconds(3600);
      setRunAt('');
      setActionType('new_session');
      setPrompt('');
      setTargetSessionId('');
      setTemplateId('');
      setModel('sonnet');
      setMode('agent');
      setSystemPrompt('');
      setTargetDirectory('');
      setConfigSource('inline');
    }
  }, [existing, open]);

  const inputSx = {
    '& .MuiOutlinedInput-root': {
      color: c.text.primary,
      '& fieldset': { borderColor: c.border.strong },
      '&:hover fieldset': { borderColor: c.text.tertiary },
      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
    },
    '& .MuiInputLabel-root': { color: c.text.tertiary },
    '& .MuiInputLabel-root.Mui-focused': { color: c.accent.primary },
  };

  const handleSave = async () => {
    const body: any = {
      name: name || 'Untitled Schedule',
      dashboard_id: dashboardId,
      trigger_type: triggerType,
      action_type: actionType,
      prompt,
    };

    if (triggerType === 'cron') body.cron_expression = cronExpression;
    if (triggerType === 'interval') body.interval_seconds = intervalSeconds;
    if (triggerType === 'once') body.run_at = runAt;

    if (actionType === 'message_existing') {
      body.target_session_id = targetSessionId;
    } else if (configSource === 'template') {
      body.template_id = templateId;
    } else {
      body.model = model;
      body.mode = mode;
      if (systemPrompt) body.system_prompt = systemPrompt;
    }

    if (targetDirectory) body.target_directory = targetDirectory;

    if (scheduleId) {
      await dispatch(updateSchedule({ id: scheduleId, ...body }));
    } else {
      await dispatch(createSchedule(body));
    }

    dispatch(fetchSchedules());
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { bgcolor: c.bg.surface, borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 700 }}>
        {scheduleId ? 'Edit Schedule' : 'New Schedule'}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth size="small" sx={inputSx} />

        <TextField
          select label="Dashboard" value={dashboardId}
          onChange={(e) => setDashboardId(e.target.value)} fullWidth size="small" sx={inputSx}
          SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
        >
          {dashboardList.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>

        <Typography variant="subtitle2" sx={{ color: c.text.secondary, mt: 1 }}>Trigger</Typography>

        <TextField
          select label="Type" value={triggerType}
          onChange={(e) => setTriggerType(e.target.value)} fullWidth size="small" sx={inputSx}
          SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
        >
          {TRIGGER_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
        </TextField>

        {triggerType === 'cron' && (
          <TextField
            label="Cron Expression" value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)} fullWidth size="small" sx={inputSx}
            helperText="e.g. 0 9 * * * (every day at 9am)"
          />
        )}
        {triggerType === 'interval' && (
          <TextField
            label="Interval (seconds)" type="number" value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))} fullWidth size="small" sx={inputSx}
            helperText="e.g. 3600 = every hour"
          />
        )}
        {triggerType === 'once' && (
          <TextField
            label="Run At" type="datetime-local" value={runAt}
            onChange={(e) => setRunAt(e.target.value)} fullWidth size="small" sx={inputSx}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}

        <Typography variant="subtitle2" sx={{ color: c.text.secondary, mt: 1 }}>Action</Typography>

        <TextField
          select label="Action Type" value={actionType}
          onChange={(e) => setActionType(e.target.value)} fullWidth size="small" sx={inputSx}
          SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
        >
          {ACTION_TYPES.map((a) => <MenuItem key={a.value} value={a.value}>{a.label}</MenuItem>)}
        </TextField>

        <TextField
          label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
          fullWidth size="small" multiline minRows={3} sx={inputSx}
        />

        {actionType === 'message_existing' && (
          <TextField
            label="Target Session ID" value={targetSessionId}
            onChange={(e) => setTargetSessionId(e.target.value)} fullWidth size="small" sx={inputSx}
          />
        )}

        <TextField
          label="Working Directory"
          value={targetDirectory}
          onChange={(e) => setTargetDirectory(e.target.value)}
          fullWidth
          size="small"
          sx={inputSx}
          placeholder="Leave empty for default"
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    onClick={async () => {
                      const openswarm = (window as any).openswarm;
                      if (openswarm?.showFolderDialog) {
                        const picked = await openswarm.showFolderDialog(targetDirectory || undefined);
                        if (picked) setTargetDirectory(picked);
                      }
                    }}
                    sx={{ color: c.text.muted }}
                  >
                    <FolderOpenIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />

        {actionType === 'new_session' && (
          <>
            <Typography variant="subtitle2" sx={{ color: c.text.secondary, mt: 1 }}>Agent Config</Typography>

            <TextField
              select label="Config Source" value={configSource}
              onChange={(e) => setConfigSource(e.target.value as 'template' | 'inline')}
              fullWidth size="small" sx={inputSx}
              SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
            >
              <MenuItem value="inline">Configure Inline</MenuItem>
              <MenuItem value="template">Use Template</MenuItem>
            </TextField>

            {configSource === 'template' ? (
              <TextField
                select label="Template" value={templateId}
                onChange={(e) => setTemplateId(e.target.value)} fullWidth size="small" sx={inputSx}
                SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
              >
                {templateList.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
              </TextField>
            ) : (
              <>
                <TextField
                  select label="Model" value={model}
                  onChange={(e) => setModel(e.target.value)} fullWidth size="small" sx={inputSx}
                  SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
                >
                  <MenuItem value="sonnet">Sonnet 4.6</MenuItem>
                  <MenuItem value="opus">Opus 4.6</MenuItem>
                  <MenuItem value="opus-1m">Opus 4.6 1M</MenuItem>
                  <MenuItem value="haiku">Haiku 3.5</MenuItem>
                </TextField>

                <TextField
                  label="Mode" value={mode}
                  onChange={(e) => setMode(e.target.value)} fullWidth size="small" sx={inputSx}
                />

                <TextField
                  label="System Prompt (optional)" value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  fullWidth size="small" multiline minRows={2} sx={inputSx}
                />
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ color: c.text.muted }}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!prompt || !dashboardId} sx={{ bgcolor: c.accent.primary }}>
          {scheduleId ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ScheduleEditor;
