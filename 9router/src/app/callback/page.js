"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * OAuth Callback Page Content
 */
function CallbackContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState("processing");

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    const callbackData = {
      code,
      state,
      error,
      errorDescription,
      fullUrl: window.location.href,
    };

    // Method 1: postMessage to opener (popup mode)
    if (window.opener) {
      try {
        window.opener.postMessage({ type: "oauth_callback", data: callbackData }, "*");
      } catch (e) {
        console.log("postMessage failed:", e);
      }
    }

    // Method 2: BroadcastChannel (same origin tabs)
    try {
      const channel = new BroadcastChannel("oauth_callback");
      channel.postMessage(callbackData);
      channel.close();
    } catch (e) {
      console.log("BroadcastChannel failed:", e);
    }

    // Method 3: localStorage event (fallback)
    try {
      localStorage.setItem("oauth_callback", JSON.stringify({ ...callbackData, timestamp: Date.now() }));
    } catch (e) {
      console.log("localStorage failed:", e);
    }

    if (!(code || error)) {
      setTimeout(() => setStatus("manual"), 0);
      return;
    }

    setStatus("success");

    // Method 4: Direct exchange via OpenSwarm backend. This is the path that
    // keeps the flow working when Method 1 silently fails (COOP severs
    // window.opener on Windows / newer Chromium, or Windows Defender blocks
    // cross-context postMessage from the popup back to the Electron parent).
    //
    // Two changes vs. the original implementation:
    //   1. Discover the backend port dynamically from /api/openswarm-config
    //      (falling back to 8324). The backend lives on a dynamic port picked
    //      from 8324-8424, and hardcoding 8324 broke Windows users whose
    //      machines held that port.
    //   2. Defer window.close() until after the exchange completes. The old
    //      1.5s unconditional close cancelled the in-flight exchange whenever
    //      token exchange with the upstream provider ran >1.5s (common on
    //      slow networks), leaving 9Router with no connection saved.
    if (code && state) {
      (async () => {
        let backendPort = 8324;
        try {
          const cfgRes = await fetch("/api/openswarm-config", { cache: "no-store" });
          if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            if (cfg && typeof cfg.backendPort === "number") backendPort = cfg.backendPort;
          }
        } catch (e) {
          console.log("config fetch failed, using 8324:", e);
        }

        try {
          const pendingRes = await fetch(
            `http://localhost:${backendPort}/api/subscriptions/pending/${encodeURIComponent(state)}`,
          );
          if (pendingRes.ok) {
            const pending = await pendingRes.json();
            if (pending.provider && pending.code_verifier) {
              const exchangeRes = await fetch(`/api/oauth/${pending.provider}/exchange`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  code,
                  redirectUri: pending.redirect_uri,
                  codeVerifier: pending.code_verifier,
                  state,
                }),
              });
              if (exchangeRes.ok) {
                console.log("Direct exchange successful");
              }
            }
          }
        } catch (e) {
          console.log("Direct exchange fallback failed:", e);
        }

        // Small grace period so any postMessage listeners on the parent
        // get their turn before the renderer is torn down.
        setTimeout(() => {
          window.close();
          setTimeout(() => setStatus("done"), 500);
        }, 500);
      })();
    } else {
      // Error-only callbacks (no code) — nothing to exchange, close quickly.
      setTimeout(() => {
        window.close();
        setTimeout(() => setStatus("done"), 500);
      }, 1500);
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="text-center p-8 max-w-md">
        {status === "processing" && (
          <>
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Processing...</h1>
            <p className="text-text-muted">Please wait while we complete the authorization.</p>
          </>
        )}

        {(status === "success" || status === "done") && (
          <>
            <div className="size-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-green-600">check_circle</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Authorization Successful!</h1>
            <p className="text-text-muted">
              {status === "success" ? "This window will close automatically..." : "You can close this tab now."}
            </p>
          </>
        )}

        {status === "manual" && (
          <>
            <div className="size-16 mx-auto mb-4 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-yellow-600">info</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">Copy This URL</h1>
            <p className="text-text-muted mb-4">
              Please copy the URL from the address bar and paste it in the application.
            </p>
            <div className="bg-surface border border-border rounded-lg p-3 text-left">
              <code className="text-xs break-all">{typeof window !== "undefined" ? window.location.href : ""}</code>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * OAuth Callback Page
 * Receives callback from OAuth providers and sends data back via multiple methods
 */
export default function CallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-center p-8">
          <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
          </div>
          <p className="text-text-muted">Loading...</p>
        </div>
      </div>
    }>
      <CallbackContent />
    </Suspense>
  );
}
