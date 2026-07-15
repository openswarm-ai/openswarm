import React from 'react';

// Claude's signature asterisk mark, drawn as 8 rounded rays around a hollow center; gradient runs hover->pressed so it wears whatever accent the user picked.
const Starburst: React.FC<{ size: number; from: string; to: string }> = ({ size, from, to }) => {
  const id = React.useId();
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      {Array.from({ length: 8 }, (unused, i) => (
        <rect key={i} x={-7} y={-46} width={14} height={34} rx={7} fill={`url(#${id})`} transform={`rotate(${i * 45})`} />
      ))}
    </svg>
  );
};

export default Starburst;
