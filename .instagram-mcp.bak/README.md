# instagram-mcp-buddy

**Instagram for AI agents in OpenSwarm.** Sign in once with your Instagram Business or Creator account and your agents can pull insights, monitor comments, and research hashtags on your own Instagram. No API keys. No Meta Developer app. No `.env`.

```
npx -y instagram-mcp-buddy
```

That's the whole setup. The first time your agent calls `instagram_connect`, a browser opens, you log in, you're done. The 60-day access token is stored in your OS keychain on your own machine and refreshes itself.

---

## Quickstart for OpenSwarm

1. Open **OpenSwarm → Tools → Featured → Instagram → Add**.
2. Start a new agent chat and ask: *"connect Instagram."* The agent runs `instagram_connect`, a browser tab opens, you log in.
3. Now ask anything:
   - *"what were my top 3 posts last week?"*
   - *"summarize comments on my latest reel"*
   - *"is there a trending hashtag in my niche I should jump on?"*
   - *"compare my engagement to @somecompetitor"*

That's it. There is no step 4.

---

## What it can do today (v0.1.x)

Read-only baseline:

- **Account insights** — reach, profile views, accounts engaged, follow / unfollow trends, audience demographics over any date range.
- **Per-post analytics** — likes, comments, shares, saves, reach. Reels also expose views and average watch time.
- **Comment intelligence** — list comments and replies on any of your posts (no moderation actions yet).
- **Hashtag research** — top posts and recent posts for any hashtag, plus a stable id you can reuse.
- **Competitor / partner lookup** — read any public Business or Creator account by username with `instagram_business_discovery`.
- **Mention monitoring** — read comments and posts that @-tagged your account.
- **Account info** — `instagram_who_am_i` and `instagram_status` so agents can sanity-check what's available.

Full per-tool reference: [`TOOLS.md`](TOOLS.md).

## Coming soon

These features ship inside the same `npx` package — your agents pick them up automatically the next time `npx -y instagram-mcp-buddy` resolves the latest version. No action on your end.

- **v0.2.x** — publishing (image, carousel, reel, story, scheduling containers, delete).
- **v0.3.x** — comment moderation (reply, hide, delete, toggle comments on a post).
- **v0.4.x** — DMs (list conversations, list messages, send within 24h window).

Each unlock waits on Meta App Review approving the corresponding permission. Until then, the tools simply aren't registered in the MCP server.

---

## Quickstart for Claude Desktop / Cursor / Claude Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "instagram-mcp-buddy"]
    }
  }
}
```

Locations:
- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
- **Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project.
- **Claude Code** — `~/.claude/mcp.json` or per-project `.claude/mcp.json`.

Restart the client. Your agent should see the `instagram_*` tools. Start with `instagram_connect`.

---

## Requirements

- **Node 18 or later.** That's it. `npx` handles the rest.
- An **Instagram Business or Creator account**. Personal accounts are not supported by the Instagram Graph API. Switch via the Instagram app: *Settings → Account → Account type*.

---

## Privacy

Your Instagram access token never leaves your machine.

- **Primary storage**: your OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret) under the service name `instagram-mcp-buddy`.
- **Fallback** (Linux without libsecret, headless servers): an AES-256-GCM encrypted file at `$XDG_DATA_HOME/instagram-mcp-buddy/token.json`. The encryption key is derived from your machine's stable id.

No tokens are sent to any server we operate. The only network calls this package makes are to `instagram.com` and `graph.instagram.com`.

You can wipe the stored token at any time by asking your agent to *"log out of Instagram"* — it calls `instagram_logout`.

---

## Advanced: bring your own Meta app

Most users should never need this. But if you want to point the package at your own Meta Developer app — for staging environments, internal testing, or pre-review feature flagging — use either:

**Runtime (env or `.env` file):** the CLI loads `instagram-mcp/.env` when you run `node dist/index.js` (see `src/env-bootstrap.ts`). You can still export vars in the shell before `npx` if you prefer:

```bash
INSTAGRAM_MCP_APP_ID=your_app_id
INSTAGRAM_MCP_APP_SECRET=your_app_secret
# Pre-review unlocks for your own admin/tester account:
INSTAGRAM_MCP_ENABLE_PUBLISHING=true
INSTAGRAM_MCP_ENABLE_COMMENTMODERATION=true
INSTAGRAM_MCP_ENABLE_MESSAGING=true
```

Tunables (rarely needed):

```bash
IG_GRAPH_API_VERSION=v21.0     # default
IG_DEFAULT_TIMEOUT_MS=30000
IG_REEL_TIMEOUT_MS=300000      # 5 min, for reel container polling
IG_IMAGE_TIMEOUT_MS=60000
LOG_LEVEL=info                 # debug | info | warn | error
```

---

## Troubleshooting

**"This tool is not available in the current build."**
Feature flag is off in this version. Run `npx -y instagram-mcp-buddy@latest` to pick up the latest features. See [Coming soon](#coming-soon).

**Browser opens but nothing happens after I log in.**
Your firewall may be blocking the localhost callback. The server tries port `54321` first, then random ports. Check stderr logs for the URL it bound to. If you're behind a corporate firewall, the OAuth flow needs `localhost:54321` (or similar) to be reachable from your browser.

**"Not connected to Instagram."**
Agent forgot to call `instagram_connect` first. Tell it to. (Or your token expired — also resolved by `instagram_connect`.)

**Keychain prompt every time.**
macOS asks once per process for keychain access; click *Always allow*. If you're running headless on Linux without `libsecret`, the package transparently falls back to an encrypted file — no prompt.

**Token expired.**
Long-lived Instagram tokens last 60 days. The package auto-refreshes within 7 days of expiry. If you go offline for more than 60 days, just call `instagram_connect` again.

**Personal Instagram account.**
The Instagram Graph API doesn't support personal accounts. Switch to a Creator or Business account in the Instagram app's settings — it's free, takes 30 seconds, and doesn't change anything user-facing.

---

## Developing from a git clone (OpenSwarm)

`instagram-mcp` is a **subfolder of this monorepo**, not `~/instagram-mcp`. From your clone root:

```bash
cd instagram-mcp
```

Checkouts ship **without** embedded Meta credentials. Create `instagram-mcp/.env` from `.env.example`, set `INSTAGRAM_MCP_APP_ID` and `INSTAGRAM_MCP_APP_SECRET`, then `npm run build` and `node dist/index.js connect` — or run `npm run build:inject` to rewrite `dist/oauth-config.js` using the same `.env` / shell vars (`inject:credentials` accepts `META_APP_*` or `INSTAGRAM_MCP_APP_*`).

Maintainer publish (credentials in the npm tarball):

```bash
META_APP_ID=... META_APP_SECRET=... npm run publish:npm
```

---

## Publishing (maintainer notes)

The package ships with `META_APP_ID` and `META_APP_SECRET` embedded into `dist/oauth-config.js` at publish time. The placeholders `REPLACE_AT_BUILD` in source are rewritten by `scripts/inject-credentials.mjs`.

```bash
META_APP_ID=... META_APP_SECRET=... npm run publish:npm
```

The script:
- Fails (exit 1) if `META_APP_ID` / `META_APP_SECRET` or `INSTAGRAM_MCP_APP_ID` / `INSTAGRAM_MCP_APP_SECRET` are missing (values may come from `instagram-mcp/.env` when you run `npm run inject:credentials`).
- Surgically replaces only the two `export const` fallback strings — the literal in `hasInjectedCredentials()` survives intentionally.
- Logs `sha256(dist/oauth-config.js)` and the prefix+length of each credential so you can verify what landed in the artifact.

### Maintainer hygiene

- Run two Meta apps: one for local dev (creds in your untracked `.env`), one for production npm publishes (creds pulled from a password manager at publish time only).
- Store the production secret in 1Password / Bitwarden / equivalent. Never plaintext on disk between publishes.
- Rotate the prod secret every ~6 months. Rotate immediately if abuse is suspected.

### Security notes

The app secret WILL ship inside the published npm artifact. This is the standard installed-app OAuth tradeoff — Spotify desktop, Vercel CLI, Notion, gh CLI all do the same. The actual security boundary is the **per-user access token**, which is generated client-side via OAuth and stored only in each user's OS keychain on their own machine.

### Version bump cadence

| Version | Adds |
|---------|------|
| v0.1.x | Read-only baseline. 18 tools. |
| v0.2.x | + Publishing (image / carousel / reel / story / containers / delete). 27 tools. |
| v0.3.x | + Comment moderation (reply / hide / delete / toggle). 31 tools. |
| v0.4.x | + DMs (list conversations / list messages / send). 34 tools. |

Each bump waits on the corresponding Meta App Review approval. Bump cycle:

1. Meta approves a permission.
2. Flip the matching flag to `true` in `src/feature-flags.ts`.
3. Bump version, update `CHANGELOG.md`, `npm run publish:npm`.
4. Users on `npx` get the new tools on their next invocation.

### Meta App Review submission order

In order of escalating reviewer rigor:

1. `instagram_business_basic`
2. `instagram_business_manage_insights`
3. `instagram_business_manage_comments`
4. `instagram_business_content_publish`
5. `instagram_business_manage_messages`

---

## License

MIT. See [`LICENSE`](LICENSE).
