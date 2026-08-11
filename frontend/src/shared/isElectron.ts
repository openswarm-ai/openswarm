// Are we running inside the Electron shell? Detect it by the preload bridge, NOT by sniffing
// navigator.userAgent for "Electron": the UA token is deliberately stripped in the browser
// partition (and can be stripped app-wide) so sign-in walls stop seeing an embedded browser, which
// would make a UA-string check silently wrong. window.openswarm is exposed synchronously in preload
// before the first frontend frame, so it is a reliable structural signal (ENG-238).
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { openswarm?: unknown }).openswarm;
}
