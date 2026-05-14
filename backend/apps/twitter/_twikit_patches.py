"""Runtime patches for twikit 2.3.3.

This module ships four independent workarounds for upstream gaps that
accumulated through 2026. All are gated by env vars so they can be disabled
once twikit releases real fixes. They stack: Patch 3 (TLS) gets us past
Cloudflare's pre-HTTP scoring, Patch 2 (headers) keeps the post-handshake
HTTP layer internally consistent, Patch 1 (transaction-id) lets the actual
authenticated request reach X's GraphQL API, Patch 4 (User parser) keeps
the *parsed* response from silently dropping every tweet whose author has
a profile shape twikit's strict-key access doesn't expect.

Patch 1: x_client_transaction regex (default: ON)
-------------------------------------------------
X rotated the minified JS that twikit's ``ClientTransaction.get_indices``
regex-scrapes for the ``x-client-transaction-id`` signing keys. twikit 2.3.3
raises ``Exception("Couldn't get KEY_BYTE indices")`` on every authenticated
request (including ``client.login``) until a new release is cut. Tracked in
https://github.com/d60/twikit/issues/408 and an unmerged fix at
https://github.com/d60/twikit/pull/407.

Specifically this:

1. Replaces ``ON_DEMAND_FILE_REGEX``. The home page chunk map used to embed
   ``'ondemand.s':'<hash>'`` directly; the post-rotation build instead writes
   ``,<NN>:"ondemand.s",...,<NN>:"<hash>"``, so we have to find the chunk
   index first and then look up its hash in a second pass.
2. Adds ``ON_DEMAND_HASH_PATTERN`` for that second pass.
3. Relaxes ``INDICES_REGEX`` from ``\\w{1}`` to ``\\w{1,2}``. The byte-array
   variable name in the minified JS is now 1-2 chars (e.g. ``xx[12]``) where
   it used to be exactly one (``x[12]``).
4. Replaces ``ClientTransaction.get_indices`` with the two-step extractor.

Disable with ``OPENSWARM_TWITTER_DISABLE_TWIKIT_PATCH=1``.

Patch 2: Cloudflare-friendly request headers (default: ON)
----------------------------------------------------------
After Patch 1 lets the request reach X's edge, X's Cloudflare layer aggressively
challenges twikit's default identifiers: the shipped User-Agent claims Safari 17
but the ``httpx`` TLS fingerprint and missing ``sec-ch-ua-*`` / ``sec-fetch-*``
headers give it away as a bot. Login POSTs often come back with a
``403 Forbidden`` containing a Cloudflare "Sorry, you have been blocked"
interstitial. Same upstream PR proposes bumping the UA to Chrome 133 and adding
the modern Sec-* set.

Specifically this:

1. Sets a Chrome 133 User-Agent on every new ``Client`` instance that didn't
   request a specific UA (we don't override user-supplied UAs).
2. Wraps ``Client._base_headers`` to merge in ``sec-ch-ua``, ``sec-ch-ua-mobile``,
   ``sec-ch-ua-platform``, ``sec-fetch-dest``, ``sec-fetch-mode``,
   ``sec-fetch-site``.

This addresses the HTTP-level fingerprint but cannot fix the TLS-level one
on its own — Patch 3 below is what actually clears Cloudflare's pre-HTTP
JA3/JA4 scoring. Without Patch 3 this patch is largely cosmetic: Cloudflare
rejects the connection before the UA is read.

Disable with ``OPENSWARM_TWITTER_DISABLE_TWIKIT_HEADER_PATCH=1``.

Patch 3: TLS transport via curl-impersonate (default: ON)
---------------------------------------------------------
Cloudflare scores the TLS ClientHello (JA3/JA4: cipher order, extensions,
GREASE values) and the HTTP/2 SETTINGS frame *before* it reads any HTTP
headers. Stock httpx → Python's OpenSSL binding → a recognizable
"library, not browser" fingerprint → 403 on every request to x.com,
regardless of Patch 2's headers. This is the actual blocker behind
``twikit.errors.Forbidden: status: 403 ... Sorry, you have been blocked``
reported widely since late 2025 (twikit#396).

We replace twikit's transport with ``httpx-curl-cffi``'s ``AsyncCurlTransport``,
which wraps curl-impersonate (Chrome's actual BoringSSL build under the hood).
The result is a byte-identical TLS ClientHello + HTTP/2 SETTINGS to a real
Chrome 133.

Specifically this:

1. Monkey-patches the ``AsyncClient`` symbol in ``twikit.client.client``
   (and ``twikit.guest.client``) so twikit's ``Client.__init__`` —
   ``self.http = AsyncClient(proxy=proxy, **kwargs)`` — gets our wrapper that
   injects ``transport=AsyncCurlTransport(impersonate="chrome133", ...)``.
2. Monkey-patches the ``AsyncHTTPTransport`` symbol in the same modules.
   twikit's ``proxy`` setter runs unconditionally in ``__init__``
   (``self.proxy = proxy`` at line 109) and assigns
   ``self.http._mounts = {URLPattern('all://'): AsyncHTTPTransport(proxy=url)}``.
   Without this second patch, the mount silently overrides our default
   transport the moment the setter fires — we'd be back on stock httpx
   immediately after construction.

We patch the *imported names* in twikit's namespace, not ``httpx.AsyncClient``
itself, so only twikit's ``self.http`` lives behind curl-impersonate. FastAPI,
the agent SDK's outbound HTTP, ``anthropic_proxy``, etc., all stay on stock
httpx.

This is the silver-bullet patch — the previous two are necessary but not
sufficient without this one.

Disable with ``OPENSWARM_TWITTER_DISABLE_TWIKIT_TLS_PATCH=1``.

Patch 4: User parser tolerance (default: ON)
--------------------------------------------
Even when Patches 1–3 get us a valid authenticated response from X,
twikit's ``twikit.user.User.__init__`` still hard-accesses ~30 keys off
``data['legacy'][...]`` (e.g. ``legacy['entities']['description']['urls']``,
``legacy['fast_followers_count']``). X has been gradually omitting fields
from the legacy shape — accounts with empty bios drop
``entities.description.urls``, accounts without a pinned tweet drop
``pinned_tweet_ids_str``, etc. Any missing key raises ``KeyError`` mid-
construction.

The damage compounds because ``twikit.tweet.tweet_from_data`` calls
``User(client, ...)`` for every tweet's author, and ``client.search_tweet``
silently swallows ``KeyError`` per-item (``twikit/client/client.py:765``):

    try:
        tweet = tweet_from_data(self, item)
    except KeyError:
        tweet = None

So a single missing author-field turns the entire SearchResult into an
empty ``items`` list, with no log line and no exception surface. Same
class of failure hits ``client.user()`` (the smoke probe) directly:
``KeyError`` raises out of the call and our pool flips the account to
``needs_relogin`` even though the cookies are perfectly valid.

Specifically this:

1. Imports ``twikit.user`` and replaces ``User.__init__`` with a tolerant
   version that mirrors the original field-by-field, but uses
   ``data.get(...)`` and ``legacy.get(...)`` with type-appropriate defaults
   (``''`` / ``None`` for strings, ``0`` for counts, ``False`` for bools,
   ``[]`` for lists) instead of bare ``[key]`` lookups.
2. Keeps ``rest_id`` as the one hard access. A User without a rest_id is
   genuinely unidentifiable; failing fast there is correct.

After this patch, ``client.user()`` returns a real User on any
authenticated session, ``/verify`` reflects truth, the smoke probe stops
auto-quarantining accounts, and ``/search``/``/user/{id}/tweets``/etc.
stop silently dropping tweets at the parser layer.

Disable with ``OPENSWARM_TWITTER_DISABLE_TWIKIT_USER_PATCH=1``.

Operational notes
-----------------
- ``apply()`` is idempotent; safe to call from any number of import sites.
- If a patch itself fails (twikit not importable, ``httpx_curl_cffi`` missing,
  internal class shape changed again), we log a warning and continue. The
  SubApp will still 503 or raise login errors, but startup won't blow up.
- The smoke probe in ``twitter.twitter._smoke_probe`` will catch any
  *further* X-side drift past these patches and audit-log ``smoke_fail``.
"""

from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

# Chrome 133 on macOS. Matches the sec-ch-ua trio below so the fingerprint
# is internally consistent (mismatches between UA and sec-ch-ua are a strong
# bot signal). Update both together if you bump this.
_CHROME_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/133.0.0.0 Safari/537.36"
)
_CHROME_SEC_HEADERS = {
    "sec-ch-ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

_APPLIED_TX = False
_APPLIED_HEADERS = False
_APPLIED_TLS = False
_APPLIED_USER = False

# curl-impersonate target preference list for Patch 3. We probe the
# installed curl_cffi's BrowserType enum at apply time and pick the first
# of these that's actually supported, so a curl_cffi upgrade or
# downgrade can't strand us on a missing target name.
#
# Order: chrome133a (matches our Chrome 133 UA in `_CHROME_UA`) first,
# then graceful degradation through older but still-recent Chrome
# targets. The actual JA3/JA4 difference between adjacent Chrome
# majors is tiny — Cloudflare scoring doesn't materially distinguish
# Chrome 131 from 133. The UA-vs-impersonate mismatch one notch off is
# similarly insignificant; both still claim "modern Chrome."
#
# When you bump `_CHROME_UA` to a newer Chrome major, prepend the
# matching impersonate target here. Newest-Chrome-first ordering is
# the only invariant.
_IMPERSONATE_PREFERENCE: tuple[str, ...] = (
    "chrome146",
    "chrome142",
    "chrome136",
    "chrome133a",
    "chrome131",
    "chrome124",
    "chrome120",
)


def apply() -> bool:
    """Apply all patches. Idempotent.

    Returns True if at least one patch is now in place, False if everything
    was skipped or failed.
    """
    tx_ok = _apply_transaction_patch()
    headers_ok = _apply_header_patch()
    tls_ok = _apply_tls_transport_patch()
    user_ok = _apply_user_patch()
    return tx_ok or headers_ok or tls_ok or user_ok


def _apply_transaction_patch() -> bool:
    global _APPLIED_TX
    if _APPLIED_TX:
        return True
    if os.environ.get("OPENSWARM_TWITTER_DISABLE_TWIKIT_PATCH"):
        logger.info(
            "twitter: skipping twikit x_client_transaction patch "
            "(OPENSWARM_TWITTER_DISABLE_TWIKIT_PATCH set)"
        )
        return False

    try:
        from twikit.x_client_transaction import transaction as _tx
    except ImportError as e:
        logger.warning(
            "twitter: cannot apply twikit x_client_transaction patch (%s)", e
        )
        return False

    try:
        _tx.ON_DEMAND_FILE_REGEX = re.compile(
            r""",(\d+):["']ondemand\.s["']""",
            flags=re.MULTILINE,
        )
        _tx.ON_DEMAND_HASH_PATTERN = r',{}:"([0-9a-f]+)"'
        _tx.INDICES_REGEX = re.compile(
            r"""(\(\w{1,2}\[(\d{1,2})\],\s*16\))+""",
            flags=re.MULTILINE,
        )

        async def get_indices(self, home_page_response, session, headers):
            """Two-step extractor: locate the ``ondemand.s`` chunk index in
            the home page, look up its hash, then scrape byte indices from
            the resulting JS file. Raises the same exception as the original
            on failure so callers (and our smoke probe) see identical
            behavior when X drifts again.
            """
            key_byte_indices: list[str] = []
            response = (
                self.validate_response(home_page_response)
                or self.home_page_response
            )
            response_str = str(response)

            on_demand_file = _tx.ON_DEMAND_FILE_REGEX.search(response_str)
            if on_demand_file:
                chunk_index = on_demand_file.group(1)
                hash_regex = re.compile(
                    _tx.ON_DEMAND_HASH_PATTERN.format(chunk_index)
                )
                hash_match = hash_regex.search(response_str)
                if hash_match:
                    filename = hash_match.group(1)
                    on_demand_file_url = (
                        "https://abs.twimg.com/responsive-web/client-web/"
                        f"ondemand.s.{filename}a.js"
                    )
                    on_demand_file_response = await session.request(
                        method="GET",
                        url=on_demand_file_url,
                        headers=headers,
                    )
                    for item in _tx.INDICES_REGEX.finditer(
                        str(on_demand_file_response.text)
                    ):
                        key_byte_indices.append(item.group(2))

            if not key_byte_indices:
                raise Exception("Couldn't get KEY_BYTE indices")
            idxs = list(map(int, key_byte_indices))
            return idxs[0], idxs[1:]

        _tx.ClientTransaction.get_indices = get_indices
    except Exception as e:
        logger.warning(
            "twitter: failed to apply twikit x_client_transaction patch (%s); "
            "login and authenticated calls will likely fail with "
            "'Couldn't get KEY_BYTE indices'", e,
        )
        return False

    _APPLIED_TX = True
    # WARNING level (not INFO) because the rest of the backend's
    # logging config swallows INFO from non-uvicorn loggers — and
    # "did my patches actually apply?" is exactly the question an
    # operator needs to answer when twitter routes 403. Once-per-
    # startup status line is cheap.
    logger.warning(
        "twitter: applied twikit x_client_transaction patch "
        "(workaround for github.com/d60/twikit/issues/408)"
    )
    return True


def _apply_header_patch() -> bool:
    """Bump default UA + inject modern browser headers into ``Client._base_headers``.

    Only affects ``Client`` instances that didn't pass an explicit ``user_agent``
    kwarg — we never override a caller's intentional choice.
    """
    global _APPLIED_HEADERS
    if _APPLIED_HEADERS:
        return True
    if os.environ.get("OPENSWARM_TWITTER_DISABLE_TWIKIT_HEADER_PATCH"):
        logger.info(
            "twitter: skipping twikit header patch "
            "(OPENSWARM_TWITTER_DISABLE_TWIKIT_HEADER_PATCH set)"
        )
        return False

    try:
        from twikit.client import client as _client_mod
    except ImportError as e:
        logger.warning("twitter: cannot apply twikit header patch (%s)", e)
        return False

    try:
        # Sentinel string burned into the shipped 2.3.3 wheel. If we ever see
        # a different default we bail out — that means twikit updated UAs on
        # its own and our override would be a regression.
        _expected_default_ua = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) "
            "Version/17.5 Safari/605.1.15"
        )

        _original_init = _client_mod.Client.__init__

        def _patched_init(self, *args, **kwargs):
            _original_init(self, *args, **kwargs)
            # Only swap if the caller didn't request a specific UA and the
            # default is still what we expect. This lets a user override us
            # via Client(user_agent="...") without us silently clobbering it.
            user_supplied = kwargs.get("user_agent") is not None
            if not user_supplied and self._user_agent == _expected_default_ua:
                self._user_agent = _CHROME_UA

        _original_base_headers_prop = _client_mod.Client._base_headers
        _original_base_headers_fget = _original_base_headers_prop.fget

        def _patched_base_headers(self):
            headers = _original_base_headers_fget(self)
            for k, v in _CHROME_SEC_HEADERS.items():
                headers.setdefault(k, v)
            return headers

        _client_mod.Client.__init__ = _patched_init
        _client_mod.Client._base_headers = property(_patched_base_headers)
    except Exception as e:
        logger.warning(
            "twitter: failed to apply twikit header patch (%s); "
            "Cloudflare blocks on login POSTs will be more likely",
            e,
        )
        return False

    _APPLIED_HEADERS = True
    logger.warning(
        "twitter: applied twikit header patch (Chrome 133 UA + sec-ch-ua/sec-fetch headers)"
    )
    return True


def _apply_tls_transport_patch() -> bool:
    """Replace twikit's httpx.AsyncClient TLS layer with curl-impersonate.

    See the module docstring's "Patch 3" section for the full rationale.
    Summary: Cloudflare scores TLS ClientHello and HTTP/2 SETTINGS frames
    before reading HTTP headers; stock httpx looks like a Python script
    at the TLS layer and gets 403'd regardless of the Patch 2 headers.
    Wrapping the transport in ``httpx_curl_cffi.AsyncCurlTransport`` makes
    twikit's wire-level fingerprint match a real Chrome 133.

    We patch two names in twikit's module namespaces (NOT ``httpx`` itself
    — keeps the rest of the backend on stock httpx):

    - ``AsyncClient`` — intercepts twikit's ``self.http = AsyncClient(
      proxy=proxy, **kwargs)`` and injects ``transport=AsyncCurlTransport(
      impersonate="chrome133", ...)``. We strip ``proxy=`` before passing
      to the real ``httpx.AsyncClient`` because httpx errors when both
      ``transport=`` and ``proxy=`` are supplied; the proxy travels with
      the transport instead.
    - ``AsyncHTTPTransport`` — intercepts twikit's
      ``self.http._mounts = {URLPattern('all://'): AsyncHTTPTransport(
      proxy=url)}`` (run unconditionally from ``Client.__init__`` via
      ``self.proxy = proxy``). Without this second patch, the mount
      clobbers our default transport and twikit silently falls back to
      stock httpx the moment the proxy setter fires.

    Both ``twikit.client.client`` and ``twikit.guest.client`` import these
    names directly, so we patch both namespaces. We don't currently use
    ``GuestClient`` in OpenSwarm but it's cheap to cover for future use.

    Disable with ``OPENSWARM_TWITTER_DISABLE_TWIKIT_TLS_PATCH=1``.
    """
    global _APPLIED_TLS
    if _APPLIED_TLS:
        return True
    if os.environ.get("OPENSWARM_TWITTER_DISABLE_TWIKIT_TLS_PATCH"):
        logger.info(
            "twitter: skipping twikit TLS transport patch "
            "(OPENSWARM_TWITTER_DISABLE_TWIKIT_TLS_PATCH set); "
            "Cloudflare 403s on x.com are likely"
        )
        return False

    try:
        from httpx_curl_cffi import AsyncCurlTransport, CurlOpt
    except ImportError as e:
        logger.warning(
            "twitter: httpx_curl_cffi not importable (%s); skipping TLS "
            "transport patch. Cloudflare 403s on x.com are likely — "
            "ensure `httpx-curl-cffi` and `curl-cffi` are installed.",
            e,
        )
        return False

    # Pick the best impersonate target available in the installed
    # curl_cffi. Target names drift between curl_cffi versions
    # (e.g. 0.15 ships `chrome133a` not `chrome133`), so a hardcoded
    # string would be brittle. We consult the BrowserType enum and
    # take the newest entry from `_IMPERSONATE_PREFERENCE` that's
    # actually present.
    try:
        from curl_cffi.requests.impersonate import BrowserType
        available = {bt.value for bt in BrowserType}
    except ImportError as e:
        logger.warning(
            "twitter: curl_cffi BrowserType not importable (%s); skipping TLS patch",
            e,
        )
        return False

    impersonate_target = next(
        (t for t in _IMPERSONATE_PREFERENCE if t in available),
        None,
    )
    if impersonate_target is None:
        logger.warning(
            "twitter: no preferred Chrome target found in curl_cffi "
            "(available chrome targets: %s); skipping TLS patch",
            sorted(t for t in available if "chrome" in t.lower()),
        )
        return False

    # Patch every twikit module that imports the two httpx names directly.
    # We treat this as a list rather than hardcoding the strings inline so
    # adding a third namespace later (e.g. a new twikit subpackage) is a
    # one-line change.
    target_modules: list = []
    for mod_path in ("twikit.client.client", "twikit.guest.client"):
        try:
            import importlib
            target_modules.append(importlib.import_module(mod_path))
        except ImportError as e:
            # The guest client may not be present in every twikit build;
            # main client must be. We log either way and continue with
            # whatever we have.
            logger.debug("twitter: TLS patch — %s not importable (%s)", mod_path, e)

    if not target_modules:
        logger.warning(
            "twitter: TLS patch found no twikit modules to patch; "
            "package layout may have changed"
        )
        return False

    try:
        def _make_transport(proxy):
            # `FRESH_CONNECT=True` is required by httpx-curl-cffi when
            # issuing parallel async requests (see their README's
            # "curl_cffi issues"). RateGate runs at most one twikit call
            # per account at a time (concurrency semaphore), but the
            # smoke probe + a tool call on the same Client can interleave
            # briefly, so cheap insurance.
            #
            # `default_headers=True` is critical for Cloudflare. twikit's
            # `Client.request()` adds `_base_headers` (which our Patch 2
            # enriches with sec-ch-ua/sec-fetch) only on some code paths
            # — e.g. `V11Client.guest_activate` passes them, but
            # `V11Client.onboarding_task` hardcodes a minimal 2-header
            # dict (x-guest-token + Authorization) and inherits nothing
            # else. A POST that presents a Chrome TLS+HTTP/2 fingerprint
            # but goes out with no User-Agent, no Accept-Language, no
            # sec-ch-ua-* is an obvious inconsistency that Cloudflare
            # scores as bot and 403s. With default_headers=True,
            # curl-impersonate fills in Chrome's standard browser
            # headers for any name twikit didn't set explicitly — making
            # the whole request internally consistent. twikit's own
            # headers (Authorization, x-guest-token, x-csrf-token,
            # X-Client-Transaction-Id, etc.) are preserved verbatim.
            return AsyncCurlTransport(
                impersonate=impersonate_target,
                default_headers=True,
                curl_options={CurlOpt.FRESH_CONNECT: True},
                proxy=proxy,
            )

        def _patched_async_client_factory(real_async_client):
            def _patched(*args, **kwargs):
                # Honor an explicitly-supplied transport (no caller in
                # twikit does this today, but cheap to be polite — and
                # makes the patch trivially testable: pass your own
                # transport to bypass curl_cffi entirely).
                if "transport" in kwargs:
                    return real_async_client(*args, **kwargs)
                # httpx errors when both `transport=` and `proxy=` are
                # given. Strip `proxy` from the AsyncClient kwargs and
                # hand it to the transport instead.
                proxy = kwargs.pop("proxy", None)
                kwargs["transport"] = _make_transport(proxy)
                return real_async_client(*args, **kwargs)
            return _patched

        def _patched_http_transport_factory():
            def _patched(*args, **kwargs):
                # Twikit only ever calls this as
                # `AsyncHTTPTransport(proxy=url)` from the proxy setter.
                # We discard any other transport kwargs (`verify=`,
                # `cert=`, `http1=`, `http2=`, ...) on the assumption
                # that curl-impersonate's Chrome 133 defaults are what
                # we want — twikit never passes those anyway.
                proxy = kwargs.pop("proxy", None)
                return _make_transport(proxy)
            return _patched

        for mod in target_modules:
            real_async_client = getattr(mod, "AsyncClient", None)
            if real_async_client is None:
                logger.debug(
                    "twitter: TLS patch — %s has no AsyncClient name; skipping",
                    mod.__name__,
                )
                continue
            mod.AsyncClient = _patched_async_client_factory(real_async_client)
            mod.AsyncHTTPTransport = _patched_http_transport_factory()
    except Exception as e:
        logger.warning(
            "twitter: failed to apply twikit TLS transport patch (%s); "
            "Cloudflare 403s likely until fixed",
            e,
        )
        return False

    _APPLIED_TLS = True
    logger.warning(
        "twitter: applied twikit TLS transport patch "
        "(curl-impersonate %s; workaround for github.com/d60/twikit/issues/396)",
        impersonate_target,
    )
    return True


def _apply_user_patch() -> bool:
    """Replace ``twikit.user.User.__init__`` with a missing-key-tolerant version.

    See the module docstring's "Patch 4" section for full rationale.
    Summary: twikit's User constructor hard-accesses ~30 keys off
    ``data['legacy']``. X is dropping fields from that shape, and the
    KeyError propagates up to ``client.search_tweet``'s silent
    ``except KeyError`` (``twikit/client/client.py:763-766``), which
    swallows the whole tweet. End result: empty SearchResult ``items``
    with valid cursors, no log line. Same KeyError flow flips smoke-probe
    accounts to ``needs_relogin`` even when cookies are valid.

    We mirror the original constructor field-for-field but use ``.get()``
    with type-appropriate defaults. ``rest_id`` stays hard — a User
    without an id is genuinely unidentifiable and we want to know.

    Disable with ``OPENSWARM_TWITTER_DISABLE_TWIKIT_USER_PATCH=1``.
    """
    global _APPLIED_USER
    if _APPLIED_USER:
        return True
    if os.environ.get("OPENSWARM_TWITTER_DISABLE_TWIKIT_USER_PATCH"):
        logger.info(
            "twitter: skipping twikit User parser patch "
            "(OPENSWARM_TWITTER_DISABLE_TWIKIT_USER_PATCH set); "
            "tweet author parse failures will silently empty SearchResults"
        )
        return False

    try:
        from twikit import user as _user_mod
    except ImportError as e:
        logger.warning(
            "twitter: cannot apply twikit User parser patch (%s); "
            "tweet author parse failures will silently empty SearchResults",
            e,
        )
        return False

    try:
        def _patched_init(self, client, data):
            # `data` is the GraphQL result envelope: a dict with
            # `rest_id`, `legacy`, `is_blue_verified`, etc. Anything
            # missing gets a typed default; rest_id stays hard because
            # an id-less User is meaningless.
            self._client = client

            legacy = data.get('legacy') or {}
            entities = legacy.get('entities') or {}
            description_entities = entities.get('description') or {}
            url_entities = entities.get('url') or {}

            self.id = data['rest_id']
            self.created_at = legacy.get('created_at')
            self.name = legacy.get('name')
            self.screen_name = legacy.get('screen_name')
            self.profile_image_url = legacy.get('profile_image_url_https')
            self.profile_banner_url = legacy.get('profile_banner_url')
            self.url = legacy.get('url')
            self.location = legacy.get('location')
            self.description = legacy.get('description')
            self.description_urls = description_entities.get('urls') or []
            self.urls = url_entities.get('urls') or []
            self.pinned_tweet_ids = legacy.get('pinned_tweet_ids_str') or []
            self.is_blue_verified = data.get('is_blue_verified', False)
            self.verified = legacy.get('verified', False)
            self.possibly_sensitive = legacy.get('possibly_sensitive', False)
            self.can_dm = legacy.get('can_dm', False)
            self.can_media_tag = legacy.get('can_media_tag', False)
            self.want_retweets = legacy.get('want_retweets', False)
            self.default_profile = legacy.get('default_profile', False)
            self.default_profile_image = legacy.get('default_profile_image', False)
            self.has_custom_timelines = legacy.get('has_custom_timelines', False)
            self.followers_count = legacy.get('followers_count', 0)
            self.fast_followers_count = legacy.get('fast_followers_count', 0)
            self.normal_followers_count = legacy.get('normal_followers_count', 0)
            self.following_count = legacy.get('friends_count', 0)
            self.favourites_count = legacy.get('favourites_count', 0)
            self.listed_count = legacy.get('listed_count', 0)
            self.media_count = legacy.get('media_count', 0)
            self.statuses_count = legacy.get('statuses_count', 0)
            self.is_translator = legacy.get('is_translator', False)
            self.translator_type = legacy.get('translator_type')
            self.withheld_in_countries = legacy.get('withheld_in_countries') or []
            self.protected = legacy.get('protected', False)

        _user_mod.User.__init__ = _patched_init
    except Exception as e:
        logger.warning(
            "twitter: failed to apply twikit User parser patch (%s); "
            "tweet author parse failures will silently empty SearchResults",
            e,
        )
        return False

    _APPLIED_USER = True
    logger.warning(
        "twitter: applied twikit User parser patch "
        "(tolerant .get() for ~30 legacy fields; unblocks search + verify)"
    )
    return True
