"""The 125 MiniWoB tasks, grouped by the capability each one actually exercises.

Grouping matters more than the headline number: "we are better across the board" is a claim about
categories, and an arm that wins overall while losing every drag task has not earned that sentence.
Categories are assigned from the task's mechanics, not its name prefix.
"""
from __future__ import annotations

CATEGORIES: dict[str, list[str]] = {
    "click_basic": [
        "click-test", "click-test-2", "click-test-transfer", "click-button",
        "click-button-sequence", "click-link", "click-dialog", "click-dialog-2",
        "click-widget", "click-color", "click-shades", "click-shape", "identify-shape",
    ],
    "click_compound": [
        "click-checkboxes", "click-checkboxes-large", "click-checkboxes-soft",
        "click-checkboxes-transfer", "click-collapsible", "click-collapsible-2",
        "click-collapsible-nodelay", "click-collapsible-2-nodelay", "click-menu",
        "click-menu-2", "click-option", "click-scroll-list", "click-tab", "click-tab-2",
        "click-tab-2-easy", "click-tab-2-hard", "click-tab-2-medium", "navigate-tree",
        "click-pie", "click-pie-nodelay",
    ],
    "text_entry": [
        "enter-text", "enter-text-2", "enter-text-dynamic", "enter-password",
        "enter-date", "enter-time", "focus-text", "focus-text-2", "login-user",
        "login-user-popup", "text-editor", "text-transform", "resize-textarea",
        "unicode-test", "generate-number", "highlight-text", "highlight-text-2",
    ],
    "forms": [
        "book-flight", "book-flight-nodelay", "buy-ticket", "choose-date",
        "choose-date-easy", "choose-date-medium", "choose-date-nodelay", "choose-list",
        "form-sequence", "form-sequence-2", "form-sequence-3", "multi-layouts",
        "multi-orderings", "order-food", "sign-agreement", "use-autocomplete",
        "use-autocomplete-nodelay", "use-spinner", "search-engine", "social-media",
        "social-media-all", "social-media-some",
    ],
    "reading": [
        "read-table", "read-table-2", "find-word", "phone-book", "scroll-text",
        "scroll-text-2", "stock-market", "daily-calendar", "terminal", "copy-paste",
        "copy-paste-2", "find-greatest", "odd-or-even",
    ],
    "email": [
        "email-inbox", "email-inbox-delete", "email-inbox-forward", "email-inbox-forward-nl",
        "email-inbox-forward-nl-turk", "email-inbox-important", "email-inbox-nl-turk",
        "email-inbox-noscroll", "email-inbox-reply", "email-inbox-star-reply",
    ],
    "drag": [
        "drag-box", "drag-circle", "drag-cube", "drag-items", "drag-items-grid",
        "drag-shapes", "drag-shapes-2", "drag-single-shape", "drag-sort-numbers",
        "use-slider", "use-slider-2", "use-colorwheel", "use-colorwheel-2",
    ],
    "spatial": [
        "bisect-angle", "circle-center", "count-shape", "count-sides", "draw-circle",
        "draw-line", "find-midpoint", "grid-coordinate", "right-angle", "tic-tac-toe",
        "number-checkboxes", "visual-addition", "ascending-numbers",
    ],
    "reasoning": [
        "simple-algebra", "simple-arithmetic", "guess-number", "hot-cold",
    ],
}

ALL: list[str] = sorted({t for group in CATEGORIES.values() for t in group})

CATEGORY_OF: dict[str, str] = {t: cat for cat, group in CATEGORIES.items() for t in group}

# Small, cheap slice that still touches every category; used for iteration before a full sweep.
SMOKE: list[str] = [
    "click-test", "click-button", "click-link", "click-checkboxes", "click-tab",
    "enter-text", "enter-password", "focus-text", "login-user", "enter-date",
    "book-flight", "choose-list", "use-spinner", "search-engine",
    "read-table", "find-word", "copy-paste", "email-inbox", "email-inbox-delete",
    "use-slider", "drag-items", "grid-coordinate", "count-shape", "simple-algebra",
]


def resolve_tasks(spec: str) -> list[str]:
    """Accept 'all', 'smoke', 'abench', a category name, or a comma-separated list of task names."""
    spec = spec.strip()
    if spec == "all":
        return ALL
    if spec == "smoke":
        return SMOKE
    # AssistantBench validation split: live-web research questions, scored by their question_scorer.
    if spec == "abench":
        return [f"assistantbench.validation.{i}" for i in range(33)]
    # CompWoB: the 101 composed pages, discovered from the served directory.
    if spec == "compwob":
        import compwob
        return [f"compwob.{n}" for n in compwob.compwob_page_names()]
    if spec in CATEGORIES:
        return sorted(CATEGORIES[spec])
    names = [s.strip() for s in spec.split(",") if s.strip()]
    unknown = [n for n in names if n not in CATEGORY_OF and "." not in n]
    if unknown:
        raise SystemExit(f"unknown task(s): {', '.join(unknown)}")
    return names
