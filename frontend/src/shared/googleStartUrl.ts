// The install id lives in settings, so it is empty until `GET /api/settings` has answered. Clicking
// "Continue with Google" before that sent the user to the cloud with `install_id=`, and the cloud
// answers with a bare black page reading "install_id must be 8-128 chars". Three call sites built
// this URL by hand and all three could do it. Refusing to build an unusable URL is the whole fix.

// Mirrors the cloud's own validation, so we fail on this side of the network instead of over there.
const INSTALL_ID_MIN = 8;
const INSTALL_ID_MAX = 128;

export function isUsableInstallId(id: string | undefined | null): boolean {
  return !!id && id.length >= INSTALL_ID_MIN && id.length <= INSTALL_ID_MAX;
}

/** The Google sign-in start URL, or null when this install cannot form a valid one yet. */
export function googleStartUrl(proxyUrl: string, installId: string, localPort: number): string | null {
  if (!isUsableInstallId(installId)) return null;
  const params = new URLSearchParams({ install_id: installId, local_port: String(localPort) });
  // Strip ALL trailing slashes, not one: a settings value ending "com//" produced the path
  // "//api/auth/google/start", which is a different path to any server that normalises strictly.
  return `${proxyUrl.replace(/\/+$/, '')}/api/auth/google/start?${params.toString()}`;
}
