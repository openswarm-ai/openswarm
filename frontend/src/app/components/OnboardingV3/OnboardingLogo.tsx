import React from 'react';

// The OpenSwarm octopus, our actual brand mark. A raster (its coral already sits right next to the
// default accent), so unlike the old asterisk it wears its own color rather than the picked gradient.
const OnboardingLogo: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <img
    src="./logo.png"
    width={size}
    height={size}
    alt="OpenSwarm"
    draggable={false}
    style={{ display: 'block', objectFit: 'contain', ...style }}
  />
);

export default OnboardingLogo;
