# v3 holdout set, FROZEN

Frozen 2026-08-02 before any site-specific v3 work. Repo HEAD at freeze: `1508e03c`.

Integrity claim: no commit touching twitch, tiktok, or instagram behaviour exists at or before
`1508e03c`. Verify with `git log 1508e03c --oneline`. If a later commit tunes any host below, this
holdout is burned and a new one must be frozen.

Selection rule: the host string appears NOWHERE under `backend/apps/agents/browser/`. Checked
against the 106 hosts the module references (`seed_playbooks.py` carries most of them). Candidates
rejected for contamination: news.ycombinator.com, soundcloud.com, quora.com, pinterest.com,
wikipedia.org, github.com, stackoverflow.com, medium.com.

## The six

| host | composer architecture | task |
| --- | --- | --- |
| bsky.app | React SPA, modal composer | create a post |
| mastodon.social | inline composer on the home timeline | create a post |
| dev.to | URL-routed form (`/new`), markdown textarea | create a post |
| lobste.rs | server-rendered form (`/stories/new`) | create a story |
| pastebin.com | plain textarea, **no login required** | create a paste |
| meta.discourse.org | Discourse SPA, "New Topic" composer | create a topic |

Spread is deliberate: 2 plain forms, 2 SPA modals, 1 inline, 1 URL-routed. If reach holds on the
plain forms and collapses on the SPA modals, that localises the generalisation failure instead of
producing one useless aggregate.

## Rules

1. **Reach only, in dry run.** No holdout submit, ever. These are not the user's accounts.
2. **No tuning against these hosts** until the first evaluation is recorded in `holdout_run1.json`.
3. Sign-in state is measured, never assumed. A signed-out host is reported NOT MEASURABLE with the
   page's own evidence and leaves the denominator, exactly as gmail does on the known suite.
   pastebin.com is the one host guaranteed measurable regardless of session state, which is why it
   is in the set.
4. Every attempt is published, including failures, retries, and exclusions.

## Addendum, frozen 2026-08-02 at HEAD `ab898964`, before evaluating any of it

The first holdout was unmeasurable: 5 of 6 sites are signed out and I am not permitted to sign in,
so it tested nothing. It did earn its keep once (pastebin exposed the header-login-widget bug), but
a holdout that cannot be scored is not a generalisation test.

Fix: six more hosts, chosen because they publish a composer to anonymous users, so session state can
never be the reason a run fails. Same contamination rule, all six verified absent from everything
under `backend/apps/agents/browser/`. Frozen before the first run, per criterion 8.

| host | composer architecture | task |
| --- | --- | --- |
| rentry.co | plain textarea, markdown | create a paste |
| dpaste.org | plain textarea in a server form | create a paste |
| controlc.com | plain textarea | create a paste |
| txti.es | plain textarea, minimal markup | create a page |
| justpaste.it | rich contenteditable editor | create a note |
| telegra.ph | rich contenteditable (Telegram's editor) | create a page |

Four plain textareas and two contenteditable rich editors on purpose. The known suite's wins are
almost all contenteditable (x, linkedin, youtube, twitch), so a holdout of only rich editors would
flatter us, and one of only textareas would not exercise the path that actually carries production.

Same rules as above: reach only, dry run, never submitted, every attempt published.

## Editor-shape addendum, frozen 2026-08-04 at HEAD `e445ca3e`, before evaluating any of it

Eric's observation, and it is the sharpest critique of this benchmark so far: the suite was picked by
site POPULARITY, and popularity is not what determines whether we generalize. The **editor library**
is. The web's writing surfaces cluster into roughly eight shapes and most sites just adopt one, so
coverage should be counted per shape, not per famous site.

What the existing suites actually cover, audited:

| shape | covered by | samples |
| --- | --- | --- |
| plain `<textarea>` | rentry, dpaste, controlc, txti, pastebin | 5 |
| raw contenteditable | telegra.ph, justpaste.it | 2 |
| Draft.js family | x.com | 1 |
| Slate / Lexical | twitch | 1 |
| web components / shadow DOM | youtube | 1 |
| multi-field form | reddit | 1 |
| **iframe-embedded composer** | gmail (SIGNED OUT) | **0 measurable** |
| **Quill / TinyMCE / CKEditor** | nothing | **0** |
| canvas-based (Docs, Figma) | nothing | 0, likely out of scope |

The last two rows are the real hole, and they are not niche: every WordPress admin, every helpdesk
reply box, and every Disqus thread lives there. Disqus is the highest-value single target because it
is BOTH an iframe AND a rich editor, and it is embedded on millions of sites.

Frozen set, all verified absent from everything under `backend/apps/agents/browser/`, and all public
demo pages so no login is required and grading stays honest:

| host | shape | task |
| --- | --- | --- |
| disqus.com | iframe + rich editor | leave a comment on the demo thread |
| quilljs.com | Quill | write in the playground editor |
| tiny.cloud | TinyMCE | write in the demo editor |
| ckeditor.com | CKEditor 5 | write in the demo editor |
| codepen.io | CodeMirror in an iframe | write in the HTML pane |

Reach only, dry run, never submitted. Every attempt published, including failures and exclusions.
