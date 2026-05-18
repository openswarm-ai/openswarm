// E2E tests for the desktop affiliate handshake against an in-process mock cloud.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");

// Polling envs must be set before require: constants read at module load.
process.env.OPENSWARM_AFFILIATE_POLL_INTERVAL_MS = "20";
process.env.OPENSWARM_AFFILIATE_POLL_MAX_ATTEMPTS = "30";

const affiliateTracking = require("./affiliateTracking");

function makeMockCloud() {
  const tokens = new Map();

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
        if (!body || typeof body.install_token !== "string" || typeof body.app_install_id !== "string") {
          return send(400, { error: "install_token + app_install_id required" });
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
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

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

test("first launch: opens welcome URL and binds ref via poll loop", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();

    process.env.OPENSWARM_AFFILIATE_LANDING_URL = "https://landing.test";
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

    const installToken = await mintTokenFromCloud(cloud.url, "haik-test");

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
    });

    assert.equal(shell.opened.length, 1, "exactly one browser open");
    assert.ok(
      shell.opened[0].startsWith("https://landing.test/welcome?app_install_id="),
      "welcome URL has correct prefix",
    );

    const appInstallId = appInstallIdFromWelcomeUrl(shell.opened[0]);
    assert.ok(appInstallId && appInstallId.length > 8, "app_install_id present in URL");

    const stateFile = path.join(userDataDir, "install.json");
    let state = readJson(stateFile);
    assert.equal(state.app_install_id, appInstallId);
    assert.equal(state.ref, null);
    assert.ok(state.first_launch_at > 0);

    const bindResult = await simulateWelcomePageBind(cloud.url, installToken, appInstallId);
    assert.equal(bindResult.status, 200);
    assert.equal(bindResult.body.ref, "haik-test");

    // Poll budget: 20ms * 30 attempts ~= 600ms; wait up to 1s.
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

test("returning launch: no-op when ref already bound", async () => {
  const cloud = await makeMockCloud();
  try {
    const userDataDir = makeTempUserDataDir();
    const shell = makeFakeShell();
    process.env.OPENSWARM_AFFILIATE_CLOUD_URL = cloud.url;

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
    await simulateWelcomePageBind(cloud.url, installToken, appInstallId);

    await affiliateTracking.maybeRunFirstLaunchHandshake({
      shell,
      userDataDir,
      isDev: false,
      isPackaged: true,
    });

    assert.equal(shell.opened.length, 0, "no second browser open");

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
  affiliateTracking._writeState(userDataDir, { app_install_id: "atomic-test-1234567890", ref: "x" });
  const files = fs.readdirSync(userDataDir);
  assert.ok(files.includes("install.json"));
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "no leftover temp file");
});

test("readState returns {} when no install.json exists", () => {
  const userDataDir = makeTempUserDataDir();
  const state = affiliateTracking._readState(userDataDir);
  assert.deepEqual(state, {});
});

test("readState returns {} when install.json is corrupt", () => {
  const userDataDir = makeTempUserDataDir();
  fs.writeFileSync(path.join(userDataDir, "install.json"), "{ not json");
  const state = affiliateTracking._readState(userDataDir);
  assert.deepEqual(state, {});
});

test("poll loop respects max attempts and gives up", async () => {
  const userDataDir = makeTempUserDataDir();
  const shell = makeFakeShell();
  process.env.OPENSWARM_AFFILIATE_CLOUD_URL = "http://127.0.0.1:1";

  await affiliateTracking.maybeRunFirstLaunchHandshake({
    shell,
    userDataDir,
    isDev: false,
    isPackaged: true,
  });

  // 20ms * 30 = 600ms upper bound; wait 900ms.
  await delay(900);
  const state = readJson(path.join(userDataDir, "install.json"));
  assert.equal(state.ref, null, "no ref after exhausted polls");
  assert.equal(state.attempts, 30, "all attempts recorded");
});
