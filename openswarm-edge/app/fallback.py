"""Plain branded HTML for the states a visitor can hit that aren't the app itself:
the slug isn't published (or was taken down), or the page is loaded on the apex
instead of a {slug}.openswarm.host subdomain. Kept inline + dependency-free so the
edge can answer even when it can't reach storage."""
from __future__ import annotations

_STYLE = (
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
    "background:#faf9f7;color:#2b2b2b;margin:0;min-height:100vh;display:flex;"
    "align-items:center;justify-content:center;text-align:center;padding:24px;"
)


def _page(title: str, message: str, status_note: str = "") -> str:
    note = f"<p style='color:#8a857c;font-size:13px;margin-top:24px'>{status_note}</p>" if status_note else ""
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title></head>"
        f"<body style=\"{_STYLE}\"><div style='max-width:420px'>"
        f"<div style='font-size:40px;margin-bottom:12px'>🐝</div>"
        f"<h1 style='font-size:20px;font-weight:650;margin:0 0 8px'>{title}</h1>"
        f"<p style='color:#615d57;font-size:15px;line-height:1.5;margin:0'>{message}</p>"
        f"{note}"
        "<p style='margin-top:28px'><a href='https://openswarm.com' "
        "style='color:#c2410c;text-decoration:none;font-weight:600'>Build your own with OpenSwarm &rarr;</a></p>"
        "</div></body></html>"
    )


def not_found_page() -> str:
    return _page(
        "App not found",
        "There's no published app at this address. It may have been unpublished or never existed.",
    )


def apex_page() -> str:
    return _page(
        "OpenSwarm Apps",
        "Apps published from OpenSwarm live at their own subdomain here.",
    )


def report_footer_note() -> str:
    return "See something off with an app? Report it in our Discord."
