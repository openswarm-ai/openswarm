import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  currentIndex: number;
  totalBranches: number;
  onPrevious: () => void;
  onNext: () => void;
}

const BranchNavigator: React.FC<Props> = ({ currentIndex, totalBranches, onPrevious, onNext }) => {
  const c = useClaudeTokens();
  if (totalBranches <= 1) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.5,
        my: 0.25,
      }}
    >
      <IconButton
        size="small"
        onClick={onPrevious}
        disabled={currentIndex === 0}
        sx={{ color: c.text.tertiary, p: 0.25, '&.Mui-disabled': { color: c.border.medium } }}
      >
        <ChevronLeftIcon sx={{ fontSize: 18 }} />
      </IconButton>
      <Typography sx={{ color: c.text.tertiary, fontSize: '0.7rem', minWidth: 32, textAlign: 'center' }}>
        {currentIndex + 1}/{totalBranches}
      </Typography>
      <IconButton
        size="small"
        onClick={onNext}
        disabled={currentIndex === totalBranches - 1}
        sx={{ color: c.text.tertiary, p: 0.25, '&.Mui-disabled': { color: c.border.medium } }}
      >
        <ChevronRightIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Box>
  );
};

export default BranchNavigator;
