"""Headless browser fallback using Playwright.

Used when Electron's <webview> is not available (running in regular browser).
Provides the same browser actions as the Electron webview bridge:
navigate, click, type, screenshot, get_text, get_elements, evaluate.
"""

import asyncio
import base64
import logging
from typing import Any

logger = logging.getLogger(__name__)

_playwright = None
_browser = None
_pages: dict[str, Any] = {}  # browser_id -> Page


async def _ensure_browser():
    """Start Playwright browser if not running."""
    global _playwright, _browser
    if _browser and _browser.is_connected():
        return

    from playwright.async_api import async_playwright
    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-gpu"],
    )
    logger.info("Headless browser started (Playwright/Chromium)")


async def _get_page(browser_id: str) -> Any:
    """Get or create a page for a browser_id."""
    await _ensure_browser()
    if browser_id not in _pages or _pages[browser_id].is_closed():
        page = await _browser.new_page()
        await page.set_viewport_size({"width": 1280, "height": 800})
        _pages[browser_id] = page
    return _pages[browser_id]


async def execute(browser_id: str, action: str, params: dict) -> dict:
    """Execute a browser action. Returns same format as Electron webview bridge."""
    try:
        page = await _get_page(browser_id)

        if action == "navigate":
            url = params.get("url", "")
            if url:
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(1000)  # Let JS settle
            return {"text": f"Navigated to {page.url}", "url": page.url}

        elif action == "screenshot":
            screenshot_bytes = await page.screenshot(type="png")
            b64 = base64.b64encode(screenshot_bytes).decode()
            return {"image": b64, "url": page.url}

        elif action == "get_text":
            text = await page.evaluate("document.body?.innerText || ''")
            return {"text": text[:15000]}

        elif action == "click":
            selector = params.get("selector", "")
            if selector:
                await page.click(selector, timeout=5000)
                await page.wait_for_timeout(500)
            return {"text": f"Clicked {selector}"}

        elif action == "type":
            selector = params.get("selector", "")
            text = params.get("text", "")
            if selector and text:
                await page.fill(selector, text)
            return {"text": f"Typed into {selector}"}

        elif action == "evaluate":
            expression = params.get("expression", "")
            result = await page.evaluate(expression)
            return {"text": str(result) if result is not None else "undefined"}

        elif action == "get_elements":
            selector = params.get("selector", "body")
            elements = await page.evaluate(f"""
                (() => {{
                    const els = document.querySelectorAll('{selector} a, {selector} button, {selector} input, {selector} select, {selector} textarea, {selector} [role="button"], {selector} [onclick]');
                    return Array.from(els).slice(0, 50).map(el => ({{
                        tag: el.tagName.toLowerCase(),
                        text: (el.textContent || '').trim().slice(0, 100),
                        selector: el.id ? '#' + el.id : (el.className ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase()),
                        href: el.href || null,
                        type: el.type || null,
                        placeholder: el.placeholder || null,
                    }}));
                }})()
            """)
            lines = []
            for el in (elements or []):
                desc = f"{el['tag']}"
                if el.get("text"):
                    desc += f" \"{el['text'][:50]}\""
                if el.get("href"):
                    desc += f" → {el['href'][:80]}"
                desc += f"  selector: {el.get('selector', '?')}"
                lines.append(desc)
            return {"text": "\n".join(lines) if lines else "No interactive elements found"}

        else:
            return {"error": f"Unknown action: {action}"}

    except Exception as e:
        logger.warning(f"Headless browser error ({action}): {e}")
        return {"error": str(e)}


async def close_page(browser_id: str):
    """Close a specific page."""
    page = _pages.pop(browser_id, None)
    if page and not page.is_closed():
        await page.close()


async def shutdown():
    """Close all pages and the browser."""
    global _browser, _playwright
    for page in _pages.values():
        try:
            if not page.is_closed():
                await page.close()
        except Exception:
            pass
    _pages.clear()

    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
        _browser = None

    if _playwright:
        try:
            await _playwright.stop()
        except Exception:
            pass
        _playwright = None
