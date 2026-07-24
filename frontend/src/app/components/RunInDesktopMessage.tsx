import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

interface Props {
  kind?: 'browser' | 'app';
}

// Shown when a browser/app card is rendered OUTSIDE Electron (the dev URL opened directly in a web browser). The real <webview> only exists in the desktop app; rather than a crippled <iframe> the agent can't drive, tell the user to launch correctly.
const RunInDesktopMessage: React.FC<Props> = ({ kind = 'browser' }) => {
  const noun = kind === 'app' ? 'Apps' : 'Browsers';
  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 3,
        textAlign: 'center',
        color: '#888',
        userSelect: 'none',
      }}
    >
      <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: '#bbb' }}>
        Open this in the OpenSwarm desktop app
      </Typography>
      <Typography sx={{ fontSize: '0.8125rem', lineHeight: 1.5, maxWidth: 360 }}>
        {noun} run inside the OpenSwarm desktop window, not a regular web browser. It looks like you opened the dev URL directly in a browser; launch OpenSwarm (the Electron window from <code>bash run.sh</code>) and use it there instead.
      </Typography>
    </Box>
  );
};

export default RunInDesktopMessage;
