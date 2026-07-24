import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Modal from '@mui/material/Modal';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import PlanPicker from './PlanPicker';
import type {
  OpenSwarmPlan,
  CheckoutSource,
} from '@/shared/subscription/checkout';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  source: CheckoutSource;
  defaultPlan?: OpenSwarmPlan;
  currentPlan?: OpenSwarmPlan;
  onSubscribed?: (plan: OpenSwarmPlan) => void;
}

/** Centered modal around the compact PlanPicker; keeps pricing out of the page flow until asked for. */
const PlanPickerModal: React.FC<Props> = ({
  open,
  onClose,
  title,
  subtitle,
  source,
  defaultPlan,
  currentPlan,
  onSubscribed,
}) => {
  const c = useClaudeTokens();
  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}
    >
      <Box sx={{
        width: 460, maxWidth: '100%',
        maxHeight: '90vh', overflowY: 'auto',
        bgcolor: c.bg.surface, borderRadius: `${c.radius.xl}px`,
        border: `1px solid ${c.border.subtle}`,
        p: 3, outline: 'none',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1.5 }}>
          <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary }}>
            {title}
          </Typography>
          <IconButton
            size="small"
            onClick={onClose}
            sx={{ color: c.text.tertiary }}
            aria-label="Close"
          >
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
        {subtitle && (
          <Typography sx={{ fontSize: '0.75rem', color: c.text.muted, mb: 2 }}>
            {subtitle}
          </Typography>
        )}
        <PlanPicker
          source={source}
          defaultPlan={defaultPlan}
          currentPlan={currentPlan}
          compact
          onSubscribed={onSubscribed}
        />
      </Box>
    </Modal>
  );
};

export default PlanPickerModal;
