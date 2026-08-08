import React, { useEffect, useRef, useState } from 'react';

interface CountUpProps {
  value: number;
  durationMs?: number;
  format?: (n: number) => string;
}

// One-shot rAF that parks when it lands; a permanent loop here would cost the whole machine 60fps forever.
const CountUp: React.FC<CountUpProps> = ({ value, durationMs = 650, format }) => {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(0);

  useEffect(() => {
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || durationMs <= 0) { setShown(value); return undefined; }
    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) { setShown(value); return undefined; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 4);
      setShown(from + delta * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  useEffect(() => { fromRef.current = value; }, [value]);

  return <>{format ? format(shown) : Math.round(shown).toLocaleString()}</>;
};

export default CountUp;
