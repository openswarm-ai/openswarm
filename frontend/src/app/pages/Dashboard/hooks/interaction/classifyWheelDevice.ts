// Is this wheel event a trackpad or a mouse wheel? The zoom/scroll toggle hangs off this verdict,
// and it was wrong for accelerated mouse wheels (3rd field report): macOS acceleration and
// smooth-scroll drivers (Magic Mouse, Logitech Options) emit NON-INTEGER deltaY for real wheel
// notches, and the old rule sent every non-integer delta to the trackpad branch regardless of
// size, so the wheel always panned and the setting looked dead. Synthetic harness wheels have
// integer deltas, which is exactly why two harness verifications passed while every physical
// wheel failed. Rule now: a chunky vertical-only delta is a wheel notch whatever its fraction;
// only SMALL deltas (accelerated-to-nothing notches vs slow two-finger drift) fall back to the
// integer heuristic.
export interface WheelDeviceEvent {
  deltaMode: number;
  wheelDeltaY?: number;
}

export function classifyWheelDevice(e: WheelDeviceEvent, dx: number, dy: number): boolean {
  if (e.deltaMode !== 0) return false;
  const legacy = e.wheelDeltaY ?? 0;
  // Chromium stamps discrete notches with legacy wheelDeltaY = ticks*120; definitive when present.
  if (legacy !== 0 && legacy % 120 === 0 && dx === 0) return false;
  // Any sideways component means fingers on glass; wheels (tilt aside, handled upstream by the
  // dominant-axis branch) are vertical-only.
  if (dx !== 0) return true;
  // Chunky vertical-only = a wheel notch, fractional or not. Trackpad two-finger streams open
  // with small deltas, and stream continuity upstream keeps a gesture's first verdict. THIS line
  // is the fix: the old rule sent large fractional deltas to the trackpad branch.
  if (Math.abs(dy) >= 40) return false;
  // Small vertical-only deltas keep the old conservative verdict: glass, whichever their fraction.
  return true;
}
