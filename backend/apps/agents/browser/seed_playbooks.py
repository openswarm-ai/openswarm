"""Shipped seed playbooks DATA: starting strategy memory for popular sites so a fresh install
isn't fully cold on its first task there. FALLBACKS only, the moment a user does a real verified
run on a site the reflective distill writes a learned playbook that supersedes the seed, so a
wrong bullet can only gently mislead a first run and is self-corrected (the playbook's fail-safe).

Facts are the stable, documented deep-URL search patterns + observed login/bot walls, NOT guessed
mechanics; where a URL pattern is unstable the bullet says to drive the search box instead. Host
keys are canonical (no leading 'www.'); the loader (seed_for) strips 'www.' before matching.

Money sites are deliberately framed READ-ONLY: read balances/activity, NEVER move money, pay, trade,
or transfer, hand any transaction to the user. This mirrors the product's financial-action rule.
"""

SEED_PLAYBOOKS: dict[str, list[str]] = {
    # --- search ---
    "google.com": [
        "Web search via URL: google.com/search?q=QUERY. Maps search via URL: google.com/maps/search/PLACE.",
    ],
    "bing.com": ["Search via URL: bing.com/search?q=QUERY. Works logged-out."],
    "duckduckgo.com": ["Search via URL: duckduckgo.com/?q=QUERY. Works logged-out, no login."],
    "yahoo.com": ["Search via URL: search.yahoo.com/search?p=QUERY. Works logged-out."],
    # --- reference / knowledge ---
    "wikipedia.org": [
        "Read via URL: en.wikipedia.org/wiki/TITLE (spaces become _). Search via en.wikipedia.org/w/index.php?search=QUERY. Fully readable logged-out.",
    ],
    "imdb.com": ["A title lives at imdb.com/title/ttID. Search via URL: imdb.com/find/?q=QUERY. Readable logged-out."],
    "quora.com": ["Search via URL: quora.com/search?q=QUERY. Reading often triggers a sign-in wall after a bit of scrolling."],
    "goodreads.com": ["Search via URL: goodreads.com/search?q=QUERY. Browsing works logged-out; shelving/rating needs sign-in."],
    "stackoverflow.com": [
        "Search via URL: stackoverflow.com/search?q=QUERY. Questions and answers are readable logged-out; voting/answering needs sign-in.",
    ],
    "github.com": ["Search via URL: github.com/search?q=QUERY&type=repositories. Public repos, issues, and code are readable logged-out."],
    "news.ycombinator.com": [
        "The front page is news.ycombinator.com; an item is news.ycombinator.com/item?id=ID. Readable logged-out; commenting/voting needs sign-in.",
    ],
    "medium.com": ["Articles are readable but many hit a metered paywall after a few reads; search via URL: medium.com/search?q=QUERY."],
    # --- news / weather ---
    "news.google.com": ["Google News: news.google.com/search?q=QUERY. Works logged-out."],
    "weather.com": ["Type a city into the search box (weather.com keys pages on an internal location code, so don't hand-build a URL from a city name); forecasts read fine logged-out."],
    "cnn.com": ["Readable logged-out; search via URL: cnn.com/search?q=QUERY."],
    "bbc.com": ["Readable logged-out; search via URL: bbc.co.uk/search?q=QUERY."],
    "nytimes.com": ["A metered paywall appears after a few articles; use the site's own search box, not a guessed URL."],
    # --- video / streaming / music ---
    "youtube.com": [
        "Search via URL: youtube.com/results?search_query=QUERY. A video is youtube.com/watch?v=ID; browsing and watching work logged-out.",
        "To comment: open the video, click the 'Add a comment...' box, type, then click Comment (needs sign-in).",
    ],
    "netflix.com": ["Requires sign-in to browse or play. Once logged in, search via URL: netflix.com/search?q=QUERY."],
    "hulu.com": ["Requires sign-in to browse or play; if not signed in use RequestHumanIntervention."],
    "disneyplus.com": ["Requires sign-in to browse or play; if not signed in use RequestHumanIntervention."],
    "max.com": ["Requires sign-in to browse or play; if not signed in use RequestHumanIntervention."],
    "twitch.tv": ["Search via URL: twitch.tv/search?term=QUERY. A channel lives at twitch.tv/CHANNELNAME; browsing works logged-out."],
    "spotify.com": ["Search via URL: open.spotify.com/search/QUERY. Reading catalog works, but playing full tracks needs a logged-in session."],
    "music.apple.com": ["Search via URL: music.apple.com/us/search?term=QUERY. Browsing works; full playback needs a signed-in subscription."],
    "soundcloud.com": ["Search via URL: soundcloud.com/search?q=QUERY. Browsing and streaming work logged-out."],
    "pandora.com": ["Needs sign-in for most listening; if not signed in use RequestHumanIntervention."],
    # --- shopping ---
    "amazon.com": [
        "Search via URL: amazon.com/s?k=QUERY (spaces become +). Browsing and reading prices/ratings work logged-out.",
        "Results are cards with a product link, price, and rating; pull them in one shot with BrowserExtract.",
    ],
    "ebay.com": ["Search via URL: ebay.com/sch/i.html?_nkw=QUERY. Browsing works logged-out."],
    "walmart.com": ["Search via URL: walmart.com/search?q=QUERY. Browsing works logged-out; it can show a press-and-hold bot check on heavy use."],
    "target.com": ["Search via URL: target.com/s?searchTerm=QUERY. Browsing works logged-out."],
    "bestbuy.com": ["Search via URL: bestbuy.com/site/searchpage.jsp?st=QUERY. A country-select splash may appear first; pick United States."],
    "etsy.com": ["Search via URL: etsy.com/search?q=QUERY. Browsing works logged-out."],
    "aliexpress.com": ["Browsing works logged-out; use the top search box rather than guessing the URL (the search path changes often)."],
    "temu.com": ["Browsing works logged-out but expect aggressive popups; use the top search box rather than a hand-built URL."],
    "shein.com": ["Search via URL: shein.com/pdsearch/QUERY. Browsing works logged-out."],
    "costco.com": ["Search via URL: costco.com/CatalogSearch?keyword=QUERY. Some prices and buying need a member sign-in."],
    "homedepot.com": ["Search via URL: homedepot.com/s/QUERY. Browsing works logged-out."],
    "wayfair.com": ["Search via URL: wayfair.com/keyword.php?keyword=QUERY. Browsing works logged-out."],
    "craigslist.org": ["Listings are per-city: go to the city subdomain first (e.g. sfbay.craigslist.org); search is local, not global."],
    "instacart.com": ["Gates on a delivery address (and usually sign-in) before showing stores; set the location first."],
    # --- food delivery / rides / reservations ---
    "doordash.com": ["It gates on a delivery address up front; set the address before browsing restaurants or you'll see nothing."],
    "ubereats.com": ["Gates on a delivery address up front; set it before browsing. Ordering needs sign-in."],
    "grubhub.com": ["Set a delivery address first (browsing restaurants needs it). Ordering needs sign-in."],
    "uber.com": ["The ride app needs sign-in; if not signed in use RequestHumanIntervention, do not attempt to log in."],
    "lyft.com": ["The ride app needs sign-in; if not signed in use RequestHumanIntervention, do not attempt to log in."],
    "opentable.com": ["Search via URL: opentable.com/s?term=QUERY. Booking a table needs sign-in."],
    # --- social / messaging ---
    "facebook.com": ["Requires sign-in. The login wall appears immediately; if you aren't signed in, use RequestHumanIntervention, do not try to log in."],
    "instagram.com": ["Requires sign-in. The login wall appears immediately; if you aren't signed in, use RequestHumanIntervention, do not try to log in."],
    "x.com": [
        "Most actions need sign-in. Once logged in, search via URL: x.com/search?q=QUERY (twitter.com redirects here).",
        "To post: click the composer ('What is happening?'), type, then click Post; do NOT press Enter (it inserts a newline). To reply, open the tweet and use its Reply box then the Reply button.",
    ],
    "reddit.com": [
        "Search via URL: reddit.com/search/?q=QUERY. A subreddit is reddit.com/r/NAME; most browsing works logged-out.",
        "Posting/commenting needs sign-in and the composer is bot-gated; prefer the built-in write path (BrowserApiWrite) over driving the UI composer.",
    ],
    "tiktok.com": ["Search via URL: tiktok.com/search?q=QUERY. Heavy anti-bot, expect occasional captcha or a login prompt."],
    "pinterest.com": ["Search pins via URL: pinterest.com/search/pins/?q=QUERY. Most actions (save, follow) need sign-in."],
    "linkedin.com": [
        "Find people via URL: linkedin.com/search/results/people/?keywords=NAME (one nav beats driving the search UI).",
        "Open a person's profile, then click Message to open the compose box for that specific person.",
        "A 1:1 thread is titled '<Other Person> and <You>'; that IS the direct thread, do NOT start a new one.",
        "In the composer, type the message then click Send; do NOT press Enter (in the rich composer it only inserts a newline).",
    ],
    "threads.net": ["A login overlay sits over the feed; no composer or search is reachable until signed in."],
    "messenger.com": ["Uses the Facebook login; if not signed in use RequestHumanIntervention, do not try to log in."],
    "snapchat.com": ["Primarily a mobile app; the web is limited and login-walled. Use RequestHumanIntervention on a wall."],
    "nextdoor.com": ["The neighborhood feed needs sign-in; if signed in, confirm the neighborhood, then browse posts."],
    "web.whatsapp.com": ["Needs a phone-linked session via QR; it often serves a 'use a supported browser' wall, treat as not reliably automatable."],
    "web.telegram.org": ["Web login is QR-code or passkey; if not already logged in, use RequestHumanIntervention rather than attempting it."],
    # --- email / productivity ---
    "mail.google.com": [
        "Needs sign-in. Search via URL: mail.google.com/mail/u/0/#search/QUERY. To send: click Compose, fill To then Subject then the body, then click Send.",
    ],
    "outlook.com": ["Microsoft email; needs sign-in. If not signed in use RequestHumanIntervention."],
    "office.com": ["Microsoft 365 hub; needs sign-in. If not signed in use RequestHumanIntervention."],
    "docs.google.com": ["Google Docs/Sheets/Slides; needs sign-in. A doc is docs.google.com/document/d/ID, a sheet docs.google.com/spreadsheets/d/ID; edit once signed in."],
    "drive.google.com": ["Google Drive; needs sign-in. Search files via URL: drive.google.com/drive/search?q=QUERY."],
    "calendar.google.com": ["Google Calendar; needs sign-in. Read events and create via the '+ Create' button once signed in."],
    "dropbox.com": ["The landing page is marketing; files need sign-in. If not signed in use RequestHumanIntervention."],
    "notion.so": ["The landing page is marketing; the workspace needs sign-in. If not signed in, use RequestHumanIntervention."],
    "trello.com": ["The landing page is marketing; the app needs sign-in. If not signed in, use RequestHumanIntervention."],
    "figma.com": ["The landing page is marketing; the app needs sign-in. If not signed in, use RequestHumanIntervention."],
    # --- travel / local ---
    "airbnb.com": ["Drive the homepage search (Where / check-in-out / Who) then Search; the results URL params are brittle, don't hand-build them."],
    "booking.com": ["Search via URL: booking.com/searchresults.html?ss=DESTINATION. Browsing works logged-out."],
    "expedia.com": ["Drive the homepage search widget (Where to, dates, travelers); its URL is complex, don't hand-build it."],
    "tripadvisor.com": ["Search via URL: tripadvisor.com/Search?q=QUERY. Browsing works logged-out."],
    "kayak.com": ["Drive the homepage flight/hotel search; result URLs are brittle, don't hand-build them."],
    "hotels.com": ["Drive the homepage search widget; result URLs are complex, don't hand-build them."],
    "vrbo.com": ["Drive the homepage search; result URLs are brittle, don't hand-build them."],
    "yelp.com": ["Search via URL: yelp.com/search?find_desc=WHAT&find_loc=WHERE. Browsing works logged-out."],
    # --- jobs / real estate ---
    "indeed.com": ["Job search via URL: indeed.com/jobs?q=WHAT&l=WHERE. Browsing works logged-out; applying needs sign-in and is heavily bot-gated (expect a captcha)."],
    "glassdoor.com": ["Heavy sign-in and anti-bot walls appear quickly; treat as often not reliably automatable, use RequestHumanIntervention on a wall."],
    "ziprecruiter.com": ["Job search via URL: ziprecruiter.com/jobs-search?search=WHAT&location=WHERE. Applying needs sign-in."],
    "zillow.com": ["Search via URL: zillow.com/homes/CITY-STATE_rb/. Heavy anti-bot: a press-and-hold or captcha wall is common on more than a few requests."],
    "realtor.com": ["Search via URL: realtor.com/realestateandhomes-search/CITY_STATE. Browsing works logged-out."],
    "redfin.com": ["Drive the homepage search box; scripted URL access is heavily anti-bot."],
    "apartments.com": ["Search via URL: apartments.com/CITY-STATE/. Browsing works logged-out."],
    # --- tickets / events ---
    "ticketmaster.com": ["Search via URL: ticketmaster.com/search?q=QUERY. Buying needs sign-in and hits queue/anti-bot walls."],
    "stubhub.com": ["Search events from the homepage; buying needs sign-in."],
    "eventbrite.com": ["Search via URL: eventbrite.com/d/online/QUERY/. Browsing works logged-out; registering needs sign-in."],
    # --- health ---
    "webmd.com": ["Readable logged-out; search via URL: webmd.com/search/search_results/default.aspx?query=QUERY."],
    "goodrx.com": ["Search a drug via URL: goodrx.com/QUERY. Prices are readable logged-out."],
    "cvs.com": ["General browsing works logged-out; pharmacy and account pages need sign-in and are sensitive."],
    "walgreens.com": ["General browsing works logged-out; pharmacy and account pages need sign-in and are sensitive."],
    # --- education ---
    "quizlet.com": ["Search via URL: quizlet.com/search?query=QUERY. Browsing study sets works logged-out."],
    "duolingo.com": ["The lessons app needs sign-in; the landing page is marketing. If not signed in use RequestHumanIntervention."],
    "khanacademy.org": ["Browsing lessons works logged-out; search via URL: khanacademy.org/search?page_search_query=QUERY."],
    "coursera.org": ["Search via URL: coursera.org/search?query=QUERY. Enrolling and course content need sign-in."],
    "chegg.com": ["Most content is paywalled behind sign-in; treat as read-limited without an account."],
    # --- AI assistants ---
    "chatgpt.com": ["A chat app that needs sign-in; if a task requires it and you're not signed in, use RequestHumanIntervention."],
    "claude.ai": ["A chat app that needs sign-in; if a task requires it and you're not signed in, use RequestHumanIntervention."],
    "perplexity.ai": ["Answer-search AI; search via URL: perplexity.ai/search?q=QUERY (some features need sign-in)."],
    "gemini.google.com": ["A chat app that needs sign-in; if a task requires it and you're not signed in, use RequestHumanIntervention."],
    # --- government / utilities ---
    "usps.com": ["Track a package via URL: tools.usps.com/go/TrackConfirmAction?tLabels=NUMBER. General info is readable logged-out."],
    "irs.gov": ["Forms and info are readable logged-out; any personal account access needs sign-in and is sensitive."],
    # --- money (READ-ONLY, never transact) ---
    "paypal.com": ["Needs sign-in. READ-ONLY: read balances/activity, but NEVER send money, pay, or transfer, hand any money movement to the user (RequestHumanIntervention)."],
    "venmo.com": ["Needs sign-in. READ-ONLY: read activity, but NEVER pay, request, or transfer money, hand any payment to the user."],
    "cash.app": ["Needs sign-in. READ-ONLY: read activity, but NEVER send, request, or move money, hand any payment to the user."],
    "chase.com": ["Needs sign-in and is sensitive. READ-ONLY: read balances/transactions, but NEVER move money, pay a bill, or transfer, hand any transaction to the user."],
    "bankofamerica.com": ["Needs sign-in and is sensitive. READ-ONLY: read balances/transactions, but NEVER move money, pay a bill, or transfer, hand any transaction to the user."],
    "wellsfargo.com": ["Needs sign-in and is sensitive. READ-ONLY: read balances/transactions, but NEVER move money, pay a bill, or transfer, hand any transaction to the user."],
    "capitalone.com": ["Needs sign-in and is sensitive. READ-ONLY: read balances/transactions, but NEVER move money, pay, or transfer, hand any transaction to the user."],
    "robinhood.com": ["Needs sign-in and is sensitive. READ-ONLY: read positions/prices, but NEVER place, cancel, or modify a trade, hand any trade to the user."],
    "coinbase.com": ["Needs sign-in and is sensitive. READ-ONLY: read balances/prices, but NEVER buy, sell, send, or trade crypto, hand any transaction to the user."],
    "fidelity.com": ["Needs sign-in and is sensitive. READ-ONLY: read balances/positions, but NEVER trade or move money, hand any transaction to the user."],
    "creditkarma.com": ["Needs sign-in; read-only credit score/report info, do not apply for anything on the user's behalf."],
    # --- dating (fingerprint-walled) ---
    "tinder.com": ["Mobile-first with heavy fingerprinting and a login wall; treat as not reliably automatable, use RequestHumanIntervention."],
    "bumble.com": ["Mobile-first with heavy fingerprinting and a login wall; treat as not reliably automatable, use RequestHumanIntervention."],
    "hinge.co": ["Mobile-first with heavy fingerprinting and a login wall; treat as not reliably automatable, use RequestHumanIntervention."],
}
