# pyright: reportMissingImports=false

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlparse

from fastmcp import Context

# Supplied at subprocess runtime by `uv run --with linkedin-scraper-mcp`.
from linkedin_mcp_server.config import get_config
from linkedin_mcp_server.config.schema import DEFAULT_TOOL_TIMEOUT_SECONDS
from linkedin_mcp_server.core.exceptions import AuthenticationError
from linkedin_mcp_server.core.utils import detect_rate_limit, handle_modal_close
from linkedin_mcp_server.dependencies import get_ready_extractor, handle_auth_error
from linkedin_mcp_server.error_handler import raise_tool_error
from linkedin_mcp_server.logging_config import configure_logging
from linkedin_mcp_server.server import create_mcp_server

logger = logging.getLogger(__name__)


def _is_linkedin_host(hostname: str | None) -> bool:
    host = (hostname or "").lower().strip(".")
    return host == "linkedin.com" or host.endswith(".linkedin.com")


def _is_linkedin_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and _is_linkedin_host(parsed.hostname)


async def _wait_for_main(page: Any) -> None:
    try:
        await page.wait_for_selector("main", timeout=10000)
    except Exception:
        logger.debug("LinkedIn main content did not appear", exc_info=True)


async def _dismiss_post_ui(page: Any) -> None:
    try:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.3)
    except Exception:
        logger.debug("Failed to dismiss LinkedIn post UI", exc_info=True)


def _linkedin_post_url_from_urn(urn: str | None) -> str | None:
    if not urn:
        return None
    return f"https://www.linkedin.com/feed/update/{urn}/"


async def _create_post_voyager(page: Any, text: str) -> dict[str, Any]:
    try:
        result = await page.evaluate(
            """async text => {
                const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
                if (!match || !match[1]) {
                    return {status: 'missing_csrf', posted: false, message: 'LinkedIn JSESSIONID cookie was not available.'};
                }
                const csrf = match[1].replace(/^"|"$/g, '');
                const response = await fetch('https://www.linkedin.com/voyager/api/contentcreation/normShares', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'accept': 'application/vnd.linkedin.normalized+json+2.1',
                        'content-type': 'application/json; charset=UTF-8',
                        'csrf-token': csrf,
                        'x-restli-protocol-version': '2.0.0'
                    },
                    body: JSON.stringify({
                        visibleToConnectionsOnly: false,
                        commentaryV2: {text, attributes: []},
                        origin: 'FEED',
                        allowedCommentersScope: 'ALL',
                        postState: 'PUBLISHED',
                        media: []
                    })
                });
                const bodyText = await response.text();
                let body = null;
                try {
                    body = JSON.parse(bodyText);
                } catch (_) {
                    body = bodyText.slice(0, 1000);
                }
                const urn = body && body.status && body.status.urn ? body.status.urn : null;
                if (response.ok && urn) {
                    return {
                        status: 'posted',
                        posted: true,
                        message: body.status.mainToastText || 'Post submitted.',
                        urn,
                        response_status: response.status
                    };
                }
                return {
                    status: 'submit_rejected',
                    posted: false,
                    message: `LinkedIn returned HTTP ${response.status}.`,
                    response_status: response.status,
                    response_body: body
                };
            }""",
            text,
        )
    except Exception as exc:
        logger.debug("LinkedIn Voyager create post failed", exc_info=True)
        return {"status": "request_failed", "posted": False, "message": str(exc)}

    if result.get("posted"):
        url = _linkedin_post_url_from_urn(result.get("urn"))
        if url:
            result["url"] = url
    return result


async def _open_post_actions_menu(page: Any) -> bool:
    return bool(
        await page.evaluate(
            """() => {
                const visible = el => !!el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                const roots = Array.from(document.querySelectorAll('article, .feed-shared-update-v2, main'));
                const root = roots.find(visible) || document;
                const buttons = Array.from(root.querySelectorAll('button, [role="button"]'));
                const menu = buttons.find(btn => {
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                    return visible(btn) && (
                        aria.includes('more') ||
                        aria.includes('control menu') ||
                        text === '...'
                    );
                });
                if (!menu) return false;
                menu.click();
                return true;
            }"""
        )
    )


async def _click_delete_menu_item(page: Any) -> bool:
    return bool(
        await page.evaluate(
            """() => {
                const visible = el => !!el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], button'));
                const item = items.find(el => {
                    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    return visible(el) && (text.includes('delete') || aria.includes('delete'));
                });
                if (!item) return false;
                item.click();
                return true;
            }"""
        )
    )


async def _click_delete_confirm(page: Any) -> bool:
    return bool(
        await page.evaluate(
            """() => {
                const visible = el => !!el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                const buttons = Array.from(document.querySelectorAll('[role="dialog"] button, button'));
                const btn = buttons.find(el => {
                    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    return visible(el) && !el.disabled && (text === 'delete' || aria === 'delete');
                });
                if (!btn) return false;
                btn.click();
                return true;
            }"""
        )
    )


def register_post_tools(mcp: Any, *, tool_timeout: float = DEFAULT_TOOL_TIMEOUT_SECONDS) -> None:
    @mcp.tool(
        timeout=tool_timeout,
        title="Create Post",
        annotations={"destructiveHint": True, "openWorldHint": True},
        tags={"feed", "actions"},
    )
    async def create_post(text: str, confirm_post: bool, ctx: Context) -> dict[str, Any]:
        """Create a text-only LinkedIn post from the authenticated user's account."""
        try:
            extractor = await get_ready_extractor(ctx, tool_name="create_post")
            page = extractor._page
            await ctx.report_progress(progress=0, total=100, message="Opening LinkedIn post composer")

            await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=30000)
            await detect_rate_limit(page)
            await _wait_for_main(page)
            await handle_modal_close(page)

            if not confirm_post:
                return {
                    "status": "confirmation_required",
                    "posted": False,
                    "message": "Set confirm_post=true to create the post.",
                }

            voyager_result = await _create_post_voyager(page, text)
            if voyager_result.get("posted"):
                await ctx.report_progress(progress=100, total=100, message="Post submitted")
            return voyager_result

        except AuthenticationError as e:
            try:
                await handle_auth_error(e, ctx)
            except Exception as relogin_exc:
                raise_tool_error(relogin_exc, "create_post")
        except Exception as e:
            raise_tool_error(e, "create_post")

    @mcp.tool(
        timeout=tool_timeout,
        title="Delete Post",
        annotations={"destructiveHint": True, "openWorldHint": True},
        tags={"feed", "actions"},
    )
    async def delete_post(post_url: str, confirm_delete: bool, ctx: Context) -> dict[str, Any]:
        """Delete one of the authenticated user's LinkedIn posts by URL."""
        try:
            if not _is_linkedin_url(post_url):
                return {"status": "invalid_url", "deleted": False, "message": "post_url must be a LinkedIn URL."}

            extractor = await get_ready_extractor(ctx, tool_name="delete_post")
            page = extractor._page
            await ctx.report_progress(progress=0, total=100, message="Opening LinkedIn post")

            await page.goto(post_url, wait_until="domcontentloaded", timeout=30000)
            await detect_rate_limit(page)
            await _wait_for_main(page)
            await handle_modal_close(page)
            await asyncio.sleep(1.0)

            if not await _open_post_actions_menu(page):
                return {"status": "menu_unavailable", "deleted": False, "message": "Could not open the post actions menu."}
            await asyncio.sleep(0.5)

            if not await _click_delete_menu_item(page):
                await _dismiss_post_ui(page)
                return {
                    "status": "delete_unavailable",
                    "deleted": False,
                    "message": "LinkedIn did not expose a delete action for this post. It may not be owned by the authenticated user.",
                }
            await asyncio.sleep(0.5)

            if not confirm_delete:
                await _dismiss_post_ui(page)
                return {
                    "status": "confirmation_required",
                    "deleted": False,
                    "message": "Set confirm_delete=true to delete the post.",
                }

            if not await _click_delete_confirm(page):
                await _dismiss_post_ui(page)
                return {"status": "confirm_unavailable", "deleted": False, "message": "Could not confirm post deletion."}

            await asyncio.sleep(2.0)
            await ctx.report_progress(progress=100, total=100, message="Post deleted")
            return {"status": "deleted", "deleted": True, "url": page.url, "message": "Delete submitted."}

        except AuthenticationError as e:
            try:
                await handle_auth_error(e, ctx)
            except Exception as relogin_exc:
                raise_tool_error(relogin_exc, "delete_post")
        except Exception as e:
            raise_tool_error(e, "delete_post")


def main() -> int:
    config = get_config()
    configure_logging(
        log_level=config.server.log_level,
        json_format=not config.is_interactive and config.server.log_level != "DEBUG",
    )
    mcp = create_mcp_server(tool_timeout=config.server.tool_timeout_seconds)
    register_post_tools(mcp, tool_timeout=config.server.tool_timeout_seconds)
    mcp.run(transport=config.server.transport or "stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
