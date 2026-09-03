import React from 'react';
import Box from '@mui/material/Box';

// The quiet mark that holds the floor before a reply: three dots breathing in turn, the Claude/ChatGPT
// pattern. Lifted as plain CSS from LDRS dot-pulse (MIT, (c) 2022 Griffin Johnston, github.com/GriffinJohnston/ldrs) so no dependency rides along.
const keyframes = `
@keyframes osw-thinking-mark {
  0%, 100% { transform: scale(0); opacity: 0.35; }
  50% { transform: scale(1); opacity: 1; }
}
`;

interface Props {
  size?: number;
  color: string;
}

export default function ThinkingMark({ size = 6, color }: Props) {
  const dot = {
    width: size,
    height: size,
    borderRadius: '50%',
    bgcolor: color,
    transform: 'scale(0)',
  };
  const speed = '1.3s';
  return (
    <Box aria-label="Waiting for a reply" role="img" sx={{ display: 'inline-flex', alignItems: 'center', gap: `${size * 0.9}px`, height: size * 2, flexShrink: 0 }}>
      <style>{keyframes}</style>
      <Box sx={{ ...dot, animation: `osw-thinking-mark ${speed} ease-in-out calc(${speed} * -0.375) infinite` }} />
      <Box sx={{ ...dot, animation: `osw-thinking-mark ${speed} ease-in-out calc(${speed} * -0.25) infinite both` }} />
      <Box sx={{ ...dot, animation: `osw-thinking-mark ${speed} ease-in-out calc(${speed} * -0.125) infinite` }} />
    </Box>
  );
}
