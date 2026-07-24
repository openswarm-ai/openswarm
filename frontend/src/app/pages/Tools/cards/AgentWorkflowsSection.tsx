import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Switch from '@mui/material/Switch';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { fetchWorkflows, updateWorkflow } from '@/shared/state/workflowsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// Actions-page section: per-workflow opt-in that lets agents run the workflow via the InvokeWorkflow tool.
const AgentWorkflowsSection: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const workflows = useAppSelector((s) => s.workflows.items);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    dispatch(fetchWorkflows(undefined));
  }, [dispatch]);

  const list = Object.values(workflows).filter((w) => !w.deleted_at && !w.unsaved);
  const exposedCount = list.filter((w) => w.exposed_as_tool).length;
  if (list.length === 0) return null;

  return (
    <Box sx={{ mb: 3 }}>
      <Box
        onClick={() => setOpen((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, cursor: 'pointer', userSelect: 'none', '&:hover .section-arrow': { color: c.text.secondary } }}
      >
        {open ? <KeyboardArrowDownIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} /> : <KeyboardArrowRightIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} />}
        <AccountTreeIcon sx={{ fontSize: 14, color: c.text.tertiary }} />
        <Typography sx={{ color: c.text.muted, fontWeight: 600, fontSize: '0.8125rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Workflows agents can run</Typography>
        <Chip label={`${exposedCount}/${list.length}`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.6875rem', height: 18, minWidth: 24, '& .MuiChip-label': { px: 0.8 } }} />
      </Box>
      <Collapse in={open} timeout={0} unmountOnExit>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pl: 1 }}>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem', mb: 0.5 }}>
            Enabled workflows can be run by your agents as a tool (InvokeWorkflow); the agent waits for the run and reads its result.
          </Typography>
          {list.map((w) => (
            <Box key={w.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, px: 1, borderRadius: 1, border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title || 'Untitled workflow'}</Typography>
                {w.description && (
                  <Typography sx={{ color: c.text.tertiary, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.description}</Typography>
                )}
              </Box>
              <Switch
                size="small"
                checked={!!w.exposed_as_tool}
                onChange={(e) => dispatch(updateWorkflow({ id: w.id, patch: { exposed_as_tool: e.target.checked } }))}
              />
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};

export default AgentWorkflowsSection;
