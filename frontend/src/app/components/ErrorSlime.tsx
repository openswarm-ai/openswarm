import React from 'react';

/** Slime illustration with X eyes and red badge for errors/warnings. */
export const ErrorSlime: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" style={{ flexShrink: 0 }}>
    <path
      d="M4 20 Q4 7 14 7 Q24 7 24 20 Q22 22 19 21.5 Q16 23 14 22 Q12 23 9 21.5 Q6 22 4 20Z"
      fill="#E8927A"
    />
    <ellipse cx="11" cy="11" rx="3.5" ry="2" fill="#F0A68E" opacity="0.6" />
    <line x1="9.5" y1="13" x2="11.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="11.5" y1="13" x2="9.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="16.5" y1="13" x2="18.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    <line x1="18.5" y1="13" x2="16.5" y2="15.5" stroke="#4a2020" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M12 18.5 Q14 17.5 16 18.5" stroke="#4a2020" strokeWidth="1" strokeLinecap="round" fill="none" />
    <circle cx="22" cy="5" r="4" fill="#ef4444" stroke="rgba(0,0,0,0.15)" strokeWidth="0.5" />
    <text x="22" y="6.8" textAnchor="middle" fontSize="5.5" fill="white" fontWeight="bold" fontFamily="sans-serif">!</text>
  </svg>
);

export default ErrorSlime;
