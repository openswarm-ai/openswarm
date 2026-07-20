import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import { useAppDispatch } from '@/shared/hooks';
import { addBrowserCard } from '@/shared/state/dashboardLayoutSlice';

const HELP_URL = 'https://openswarm.com';

/** Top-right desktop help pill: opens the docs site in an in-app browser card. */
function HelpPill(): React.ReactElement {
  const dispatch = useAppDispatch();
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        height: 30,
        pl: 1.5,
        pr: 1,
        borderRadius: 999,
        background: 'rgba(22,12,34,0.66)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onClick={() => dispatch(addBrowserCard({ url: HELP_URL }))}
    >
      <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.72)', fontWeight: 500 }}>
        Help
      </Typography>
      <Tooltip title="Voice help (coming soon)" placement="bottom" arrow>
        <Box sx={{ display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.45)' }} onClick={(e) => e.stopPropagation()}>
          <MicNoneOutlinedIcon sx={{ fontSize: 15 }} />
        </Box>
      </Tooltip>
    </Box>
  );
}

export default HelpPill;
