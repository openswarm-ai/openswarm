"""
Shipped seed playbooks: a starting strategy memory for popular sites so a fresh
install isn't fully cold on its first task there. These are FALLBACKS, the moment
a user does a real verified run on a site, the reflective distill writes a learned
playbook that supersedes the seed (and refines it). So a wrong seed bullet can only
gently mislead a first run and is self-corrected, exactly the playbook's fail-safe.

Sourced from real observation (a read-only recon pass over the top sites) plus the
stable, documented deep-URL search patterns, NOT guessed mechanics. Host keys are
canonical (no leading 'www.'); the loader strips 'www.' before matching. Kept to
the same per-site shape and caps as a learned playbook.

Coverage note: only LinkedIn carries full task mechanics (it's the one we fully
exercised). The rest carry the high-value generalizable facts a first run wants:
the deep-URL search shortcut, whether the site is usable logged-out, and where the
primary controls live. Richer per-site mechanics accrue as users actually use them.
"""

SEED_PLAYBOOKS: dict[str, list[str]] = {
    "linkedin.com": [
        "Find people via URL: linkedin.com/search/results/people/?keywords=NAME (one nav beats driving the search UI).",
        "Open a person's profile, then click Message to open the compose box for that specific person.",
        "A 1:1 thread is titled '<Other Person> and <You>'; that IS the direct thread, do NOT start a new one.",
        "In the composer, type the message then click Send; do NOT press Enter (in the rich composer it only inserts a newline).",
    ],
    "amazon.com": [
        "Search via URL: amazon.com/s?k=QUERY (spaces become +). Browsing and reading prices/ratings work logged-out.",
        "Results are cards with a product link, price, and rating; pull them in one shot with BrowserExtract.",
    ],
    "ebay.com": [
        "Search via URL: ebay.com/sch/i.html?_nkw=QUERY. Browsing works logged-out.",
    ],
    "walmart.com": [
        "Search via URL: walmart.com/search?q=QUERY. Browsing works logged-out; it can show a press-and-hold bot check on heavy use.",
    ],
    "etsy.com": [
        "Search via URL: etsy.com/search?q=QUERY. Browsing works logged-out.",
    ],
    "target.com": [
        "Search via URL: target.com/s?searchTerm=QUERY. Browsing works logged-out.",
    ],
    "bestbuy.com": [
        "Search via URL: bestbuy.com/site/searchpage.jsp?st=QUERY. A country-select splash may appear first; pick United States.",
    ],
    "aliexpress.com": [
        "Browsing works logged-out; use the top search box rather than guessing the URL (the search path changes often).",
    ],
    "craigslist.org": [
        "Listings are per-city: go to the city subdomain first (e.g. sfbay.craigslist.org), search is local, not global.",
    ],
    "airbnb.com": [
        "Drive the homepage search (Where / check-in-out / Who) then Search; the results URL params are brittle, don't hand-build them.",
    ],
    "booking.com": [
        "Search via URL: booking.com/searchresults.html?ss=DESTINATION. Browsing works logged-out.",
    ],
    "expedia.com": [
        "Drive the homepage search widget (Where to, dates, travelers); its URL is complex, don't hand-build it.",
    ],
    "yelp.com": [
        "Search via URL: yelp.com/search?find_desc=WHAT&find_loc=WHERE. Browsing works logged-out.",
    ],
    "google.com": [
        "Web search via URL: google.com/search?q=QUERY. Maps search via URL: google.com/maps/search/PLACE.",
    ],
    "doordash.com": [
        "It gates on a delivery address up front; set the address before browsing restaurants or you'll see nothing.",
    ],
    "netflix.com": [
        "Requires sign-in to browse or play. Once logged in, search via URL: netflix.com/search?q=QUERY.",
    ],
    "spotify.com": [
        "Search via URL: open.spotify.com/search/QUERY. Reading catalog works, but playing full tracks needs a logged-in session.",
    ],
    "twitch.tv": [
        "Search via URL: twitch.tv/search?term=QUERY. A channel lives at twitch.tv/CHANNELNAME.",
    ],
    "tiktok.com": [
        "Search via URL: tiktok.com/search?q=QUERY. Heavy anti-bot, expect occasional captcha or a login prompt.",
    ],
    "pinterest.com": [
        "Search pins via URL: pinterest.com/search/pins/?q=QUERY. Most actions (save, follow) need sign-in.",
    ],
    "facebook.com": [
        "Requires sign-in. The login wall appears immediately; if you aren't signed in, use RequestHumanIntervention, do not try to log in.",
    ],
    "instagram.com": [
        "Requires sign-in. The login wall appears immediately; if you aren't signed in, use RequestHumanIntervention, do not try to log in.",
    ],
    "x.com": [
        "Most actions need sign-in. Once logged in, search via URL: x.com/search?q=QUERY (twitter.com redirects here).",
    ],
    "quora.com": [
        "Search via URL: quora.com/search?q=QUERY. Reading often triggers a sign-in wall after a bit of scrolling.",
    ],
    "github.com": [
        "Search via URL: github.com/search?q=QUERY&type=repositories. Public repos, issues, and code are readable logged-out.",
    ],
    "threads.net": [
        "A login overlay sits over the feed; no composer or search is reachable until signed in.",
    ],
    "web.whatsapp.com": [
        "Needs a phone-linked session via QR. In automation it often serves a 'use a supported browser' wall, treat as not reliably automatable.",
    ],
    "web.telegram.org": [
        "Web login is QR-code or passkey; if not already logged in, use RequestHumanIntervention rather than attempting it.",
    ],
    "trello.com": [
        "The landing page is marketing; the app needs sign-in. If not signed in, use RequestHumanIntervention.",
    ],
    "figma.com": [
        "The landing page is marketing; the app needs sign-in. If not signed in, use RequestHumanIntervention.",
    ],
}


def seed_for(host: str) -> list[str]:
    """Seed bullets for a host, or []. Matches with and without a leading 'www.'."""
    h = (host or "").lower().strip()
    if not h:
        return []
    bare = h[4:] if h.startswith("www.") else h
    return SEED_PLAYBOOKS.get(h) or SEED_PLAYBOOKS.get(bare) or SEED_PLAYBOOKS.get("www." + bare) or []
