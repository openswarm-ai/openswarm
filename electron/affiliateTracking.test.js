// End-to-end tests for the desktop-side affiliate / referral handshake.
//
// We stand up an in-process HTTP server that implements the same contract
// as openswarm-cloud's /api/install/{mint,bind,lookup} endpoints (in-memory
// state, no SQLite). The Electron module's polling code talks to this
// server over real fetch over real loopback TCP, which is as realistic as
// it gets without booting the actual cloud Hono app.
//
// We then drive both halves of the flow:
//   * The "user clicks Download on the landing page" half: mint() to get an
//     install_token, stash it where the test's "welcome page" simulator can
//     find it.
//   * The "user installs the app" half: maybeRunFirstLaunchHandshake() with
//     a fake shell that captures the welcome URL, then we simulate the
//     welcome page by calling /api/install/bind from the test before the
//     poll loop times out.
//
// Polling cadence is squeezed via env vars (OPENSWARM_AFFILIATE_POLL_*) so
// the suite finishes in milliseconds instead of seconds.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");

// Force the tracking module to use tight polling well before requiring it,
// because the constants are read at module-load time.
process.env.OPENSWARM_AFFILIATE_POLL_INTERVAL_MS = "20";
process.env.OPENSWARM_AFFILIATE_POLL_MAX_ATTEMPTS = "30";

const affiliateTracking = require("./affiliateTracking");

// --- in-memory mock cloud --------------------------------------------------

function makeMockCloud() {
  // Mirrors the install_tokens table.
  const tokens = new Map();
  const filenameHashes = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json);
    };
    const readBody = () =>
      new Promise((resolve) => {
        let buf = "";
        req.on("data", (c) => (buf += c));
        req.on("end", () => {
          try {
            resolve(JSON.parse(buf || "{}"));
          } catch {
            resolve(null);
          }
        });
      });

    (async () => {
      if (req.method === "POST" && url.pathname === "/api/install/mint") {
        const body = await readBody();
        if (!body || typeof body.ref !== "string" || !body.ref) {
          return send(400, { error: "ref required" });
        }
        const token = crypto.randomBytes(32).toString("base64url");
        tokens.set(token, {
          ref: body.ref,
          app_install_id: null,
          bound_at: null,
          expires_at: Date.now() + 24 * 60 * 60 * 1000,
        });
        return send(200, { install_token: token, expires_at: Date.now() + 24 * 60 * 60 * 1000 });
      }

      if (req.method === "POST" && url.pathname === "/api/install/bind") {
        const body = await readBody();
        if (!body || typeof body.app_install_id !== "string") {
          return send(400, { error: "app_install_id required" });
        }
        if (typeof body.affiliate_hash === "string" && !body.install_token) {
          const ref = filenameHashes.get(body.affiliate_hash);
          if (!ref) return send(404, { error: "affiliate_hash not found" });
          const token = `filename_${crypto.randomBytes(24).toString("base64url")}`;
          tokens.set(token, {
            ref,
            app_install_id: body.app_install_id,
            bound_at: Date.now(),
            expires_at: Date.now() + 24 * 60 * 60 * 1000,
          });
          return send(200, { ok: true, ref });
        }
        if (typeof body.install_token !== "string") {
          return send(400, { error: "install_token required" });
        }
        const row = tokens.get(body.install_token);
        if (!row) return send(404, { error: "not found" });
        if (row.expires_at < Date.now()) return send(410, { error: "expired" });
        if (row.app_install_id && row.app_install_id !== body.app_install_id) {
          return send(409, { error: "already bound" });
        }
        row.app_install_id = body.app_install_id;
        row.bound_at = Date.now();
        return send(200, { ok: true, ref: row.ref });
      }

      if (req.method === "GET" && url.pathname === "/api/install/lookup") {
        const appInstallId = url.searchParams.get("app_install_id") || "";
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(appInstallId)) {
          return send(400, { error: "bad app_install_id" });
        }
        for (const row of tokens.values()) {
          if (row.app_install_id === appInstallId) {
            return send(200, { ref: row.ref, bound_at: row.bound_at });
          }
        }
        return send(200, { ref: null });
      }

      send(404, { error: "no route" });
    })().catch((err) => send(500, { error: err.message }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        tokens,
        filenameHashes,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --- fake shell ------------------------------------------------------------

function makeFakeShell() {
  const opened = [];
  return {
    opened,
    openExternal: async (url) => {
      opened.push(url);
      return true;
    },
  };
}

// --- temp-dir helper -------------------------------------------------------

function makeTempUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openswarm-affiliate-test-"));
  return dir;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Prefer the actual install_token = call the bind endpoint with it.
async function simulateWelcomePageBind(cloudUrl, installToken, appInstallId) {
  const res = await fetch(`${cloudUrl}/api/install/bind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ install_token: installToken, app_install_id: appInstallId }),
  });
  return { status: res.status, body: await res.json() };
}

async function mintTokenFromCloud(cloudUrl, ref) {
  const res = await fetch(`${cloudUrl}/api/install/mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  const body = await res.json();
  return body.install_token;
}

function appInstallIdFromWelcomeUrl(url) {
  const u = new URL(url);
  return u.searchParams.get("app_install_id");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("first launch: opens welcome URL and binds ref via poll loop", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();

    process.env.OPENSWARM_AFFILIATE_LANDING_URL = "https://landing.test";
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    // 1. Pre-mint a token at the cloud as if the user had clicked Download
    //    on the landing page.
    const installToken = await mintTokenFromCloud(cloud.url, "haik-test");

    // 2. Run the desktop's first-launch handshake.
    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
    });

    // 3. The shell should have been told to open the welcome URL with the
    //    freshly generated app_install_id.
    assert.equal(shell.opened.length, 1, "exactly one browser open");
    assert.ok(
      shell.opened[0].startsWith("https://landing.test/welcome?app_install_id="),
      "welcome URL has correct prefix",
    );

    const appInstallId = appInstallIdFromWelcomeUrl(shell.opened[0]);
    assert.ok(appInstallId && appInstallId.length > 8, "app_install_id present in URL");

    // 4. install.json on disk now has the app_install_id but no ref yet.
    const stateFile = path.join(userDataDir, "install.json");
    let state = readJson(stateFile);
    assert.equal(state.app_install_id, appInstallId);
    assert.equal(state.ref, null);
    assert.ok(state.first_launch_at > 0);

    // 5. Simulate the welcome page completing the bind.
    const bindResult = await simulateWelcomePageBind(cloud.url, installToken, appInstallId);
    assert.equal(bindResult.status, 200);
    assert.equal(bindResult.body.ref, "haik-test");

    // 6. Wait for the poll loop to pick up the bind. Poll cadence is
    //    20ms × 30 attempts = ~600ms upper bound; we wait up to 1s.
    let final = null;
    for (let i = 0; i < 50; i++) {
      await delay(50);
      final = readJson(stateFile);
      if (final.ref) break;
    }
    assert.equal(final.ref, "haik-test", "ref should have been written by poll loop");
    assert.ok(final.ref_bound_at > 0, "ref_bound_at populated");
  } finally {
    await cloud.close();
  }
});

test("first launch: stamped AppImage hash binds before opening welcome URL", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    const hash = "abcDEF1234567890_hash";
    cloud.filenameHashes.set(hash, "filename-affiliate");

    process.env.OPENSWARM_AFFILIATE_LANDING_URL = "https://landing.test";
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
      platform: "linux",
      env: { APPIMAGE: `/tmp/OpenSwarm-x64-${hash}.AppImage` },
    });

    assert.equal(shell.opened.length, 0, "filename hash bind skips welcome URL");
    const state = readJson(path.join(userDataDir, "install.json"));
    assert.equal(state.ref, "filename-affiliate");
    assert.equal(state.ref_bind_method, "affiliate_filename_hash");
    assert.ok(state.ref_bound_at > 0);
  } finally {
    await cloud.close();
  }
});

test("filename parser accepts browser duplicate suffix", () => {
  assert.equal(
    affiliateTracking.p_hashFromInstallerBasename("OpenSwarm-arm64-abcDEF1234567890_hash (1).dmg"),
    "abcDEF1234567890_hash",
  );
});

test("filename parser keeps hyphens inside base64url affiliate hash", () => {
  assert.equal(
    affiliateTracking.p_hashFromInstallerBasename("OpenSwarm-arm64-abcDEF1234567890-hash.dmg"),
    "abcDEF1234567890-hash",
  );
});

test("filename parser covers every stamped artifact shape (mac/win/linux)", () => {
  const h = "abcDEF1234567890_hash";
  for (const name of [
    `OpenSwarm-arm64-${h}.dmg`,
    `OpenSwarm-x64-${h}.dmg`,
    `OpenSwarm-Setup-x64-${h}.exe`,
    `OpenSwarm-x64-${h}.AppImage`,
    `OpenSwarm-arm64-${h}.AppImage`,
  ]) {
    assert.equal(affiliateTracking.p_hashFromInstallerBasename(name), h, name);
  }
  for (const name of ["OpenSwarm-arm64.dmg", "OpenSwarm-Setup-x64.exe", "OpenSwarm-x64.AppImage"]) {
    assert.equal(affiliateTracking.p_hashFromInstallerBasename(name), null, name);
  }
});

test("first launch (win32): stamped setup exe in Downloads binds before welcome URL", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    const hash = "abcDEF1234567890_hash";
    cloud.filenameHashes.set(hash, "windows-affiliate");

    const downloads = path.join(userDataDir, "Downloads");
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(downloads, `OpenSwarm-Setup-x64-${hash}.exe`), "");

    process.env.OPENSWARM_AFFILIATE_LANDING_URL = "https://landing.test";
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
      platform: "win32",
      homeDir: userDataDir,
    });

    assert.equal(shell.opened.length, 0, "filename hash bind skips welcome URL");
    const state = readJson(path.join(userDataDir, "install.json"));
    assert.equal(state.ref, "windows-affiliate");
    assert.equal(state.ref_bind_method, "affiliate_filename_hash");
  } finally {
    await cloud.close();
  }
});

test("download scan refuses ambiguous stamped installers", () => {
  const userDataDir = makeTempUserDataDir();
  const downloads = path.join(userDataDir, "Downloads");
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(downloads, "OpenSwarm-arm64-abcDEF1234567890_a.dmg"), "");
  fs.writeFileSync(path.join(downloads, "OpenSwarm-arm64-abcDEF1234567890_b.dmg"), "");

  const hash = affiliateTracking.p_findAffiliateHashFromInstaller({
    platform: "darwin",
    homeDir: userDataDir,
    nowMs: Date.now(),
  });
  assert.equal(hash, null);
});

test("resolveInstallId: reuses install.json app_install_id", () => {
  const userDataDir = makeTempUserDataDir();
  affiliateTracking.p_writeState(userDataDir, { app_install_id: "existing-id-12345" });
  const id = affiliateTracking.resolveInstallId({
    userDataDir, isPackaged: true, projectRoot: userDataDir, homeDir: userDataDir,
  });
  assert.equal(id, "existing-id-12345");
});

test("resolveInstallId: adopts python settings installation_id and persists it", () => {
  const userDataDir = makeTempUserDataDir();
  const settingsDir = path.join(userDataDir, "backend", "data", "settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ installation_id: "python-analytics-id-1" }),
  );

  const id = affiliateTracking.resolveInstallId({
    userDataDir,
    isPackaged: false,
    projectRoot: userDataDir,
  });
  assert.equal(id, "python-analytics-id-1");
  const state = readJson(path.join(userDataDir, "install.json"));
  assert.equal(state.app_install_id, "python-analytics-id-1");
});

test("resolveInstallId: generates once and returns the same id on repeat calls", () => {
  const userDataDir = makeTempUserDataDir();
  const first = affiliateTracking.resolveInstallId({
    userDataDir, isPackaged: true, projectRoot: userDataDir, homeDir: userDataDir,
  });
  const second = affiliateTracking.resolveInstallId({
    userDataDir, isPackaged: true, projectRoot: userDataDir, homeDir: userDataDir,
  });
  assert.ok(first && first.length >= 8);
  assert.equal(second, first);
  const state = readJson(path.join(userDataDir, "install.json"));
  assert.equal(state.app_install_id, first);
});

test("first launch handshake reuses the pre-resolved install id", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    const hash = "abcDEF1234567890_hash";
    cloud.filenameHashes.set(hash, "unified-affiliate");

    process.env.OPENSWARM_AFFILIATE_LANDING_URL = "https://landing.test";
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    const resolved = affiliateTracking.resolveInstallId({
      userDataDir,
      isPackaged: true,
      projectRoot: userDataDir,
      homeDir: userDataDir,
    });

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
      platform: "linux",
      env: { APPIMAGE: `/tmp/OpenSwarm-x64-${hash}.AppImage` },
    });

    const state = readJson(path.join(userDataDir, "install.json"));
    assert.equal(state.app_install_id, resolved, "handshake must keep the unified id");
    assert.equal(state.ref, "unified-affiliate");
    const bound = [...cloud.tokens.values()].find((t) => t.ref === "unified-affiliate");
    assert.equal(bound.app_install_id, resolved, "cloud bind must carry the unified id");
  } finally {
    await cloud.close();
  }
});

test("returning launch: no-op when ref already bound", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    // Seed install.json as if first launch already happened and a ref
    // was bound a few minutes ago.
    fs.writeFileSync(
      path.join(userDataDir, "install.json"),
      JSON.stringify({
        app_install_id: "preexisting-app-install-id-1234",
        first_launch_at: Date.now() - 5 * 60 * 1000,
        ref: "previously-bound-ref",
        ref_bound_at: Date.now() - 4 * 60 * 1000,
        attempts: 1,
      }),
    );

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
    });

    assert.equal(shell.opened.length, 0, "should NOT pop a browser tab");
    const state = readJson(path.join(userDataDir, "install.json"));
    assert.equal(state.ref, "previously-bound-ref");
  } finally {
    await cloud.close();
  }
});

test("returning launch within grace window: silent re-poll, no second browser pop-up", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    // Pre-mint a token + seed install.json as if first launch happened
    // but the user never completed the welcome page handshake yet.
    const appInstallId = "grace-app-install-id-abcdef0123";
    fs.writeFileSync(
      path.join(userDataDir, "install.json"),
      JSON.stringify({
        app_install_id: appInstallId,
        first_launch_at: Date.now() - 10 * 60 * 1000,
        ref: null,
        ref_bound_at: null,
        attempts: 5,
      }),
    );

    const installToken = await mintTokenFromCloud(cloud.url, "grace-ref");
    // Simulate a late welcome bind (user finally clicked through).
    await simulateWelcomePageBind(cloud.url, installToken, appInstallId);

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
    });

    // Specifically NO browser pop-up the second time around.
    assert.equal(shell.opened.length, 0, "no second browser open");

    // Wait for the silent re-poll to pick up the bind.
    const stateFile = path.join(userDataDir, "install.json");
    let state = null;
    for (let i = 0; i < 50; i++) {
      await delay(50);
      state = readJson(stateFile);
      if (state.ref) break;
    }
    assert.equal(state.ref, "grace-ref", "silent re-poll should pick up the bind");
  } finally {
    await cloud.close();
  }
});

test("returning launch outside grace window: skipped entirely", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    fs.writeFileSync(
      path.join(userDataDir, "install.json"),
      JSON.stringify({
        app_install_id: "old-app-install-id-1234567890",
        first_launch_at: Date.now() - 7 * 24 * 60 * 60 * 1000,
        ref: null,
        ref_bound_at: null,
        attempts: 12,
      }),
    );

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
    });

    assert.equal(shell.opened.length, 0, "no browser open after grace window");
    // Give the poll loop time to NOT run.
    await delay(200);
    const state = readJson(path.join(userDataDir, "install.json"));
    assert.equal(state.ref, null, "no ref bound");
  } finally {
    await cloud.close();
  }
});

test("dev mode: skipped unless OPENSWARM_AFFILIATE_FORCE=1", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    delete process.env.OPENSWARM_AFFILIATE_FORCE;
    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: true,
      isPackaged: false,
    });
    assert.equal(shell.opened.length, 0, "dev mode skips the handshake");
    assert.ok(!fs.existsSync(path.join(userDataDir, "install.json")), "no state file written");

    process.env.OPENSWARM_AFFILIATE_FORCE = "1";
    try {
      await affiliateTracking.maybeRunFirstLaunchHandshake({
        shell,
        userDataDir,
        isDev: true,
        isPackaged: false,
      });
      assert.equal(shell.opened.length, 1, "force flag opts back in");
    } finally {
      delete process.env.OPENSWARM_AFFILIATE_FORCE;
    }
  } finally {
    await cloud.close();
  }
});

test("install.json write is atomic-ish (temp + rename)", async () => {
  const userDataDir = makeTempUserDataDir();
  affiliateTracking.p_writeState(userDataDir, { app_install_id: "atomic-test-1234567890", ref: "x" });
  // After write, the temp file shouldn't be left behind.
  const files = fs.readdirSync(userDataDir);
  assert.ok(files.includes("install.json"));
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "no leftover temp file");
});

test("readState returns {} when no install.json exists", () => {
  const userDataDir = makeTempUserDataDir();
  const state = affiliateTracking.p_readState(userDataDir);
  assert.deepEqual(state, {});
});

test("readState returns {} when install.json is corrupt", () => {
  const userDataDir = makeTempUserDataDir();
  fs.writeFileSync(path.join(userDataDir, "install.json"), "{ not json");
  const state = affiliateTracking.p_readState(userDataDir);
  assert.deepEqual(state, {});
});

test("poll loop respects max attempts and gives up", async () => {
  // No cloud server at all — every poll attempt fails (ECONNREFUSED).
  const userDataDir = makeTempUserDataDir();
  const shell = makeFakeShell();
  // Point at a port nothing's listening on.
  process.env.OPENSWARM_AFFILIATE_CLOUD_URL = "http://127.0.0.1:1";

  await affiliateTracking.maybeRunFirstLaunchHandshake({
    shell,
    userDataDir,
    isDev: false,
    isPackaged: true,
  });

  // Wait long enough for all attempts to fail. 20ms × 30 = 600ms.
  await delay(900);
  const state = readJson(path.join(userDataDir, "install.json"));
  assert.equal(state.ref, null, "no ref after exhausted polls");
  assert.equal(state.attempts, 30, "all attempts recorded");
});
