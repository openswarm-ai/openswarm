import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Exposes the OpenSwarm backend's dynamic port to the in-popup callback page
// at /callback. The Python backend picks its port via
// getPort.makeRange(8324, 8424) and exports it as OPENSWARM_PORT when it
// spawns the 9Router subprocess, so we just surface that here.
//
// Needed because the callback page used to hardcode localhost:8324 in its
// "direct exchange" fallback (Method 4 in page.js). On Windows, 8324 is
// frequently held by other services, so the backend lands on 8325+ and the
// hardcoded URL 404s — breaking subscription connect for anyone whose
// postMessage path also fails (common on Windows due to COOP / popup-opener
// quirks). Fetching this config first makes Method 4 work regardless of
// which port the backend ended up on.
export async function GET() {
  const raw = process.env.OPENSWARM_PORT;
  const port = raw ? parseInt(raw, 10) : 8324;
  return NextResponse.json(
    { backendPort: Number.isFinite(port) && port > 0 ? port : 8324 },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    },
  );
}
