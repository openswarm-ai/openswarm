from typing import Any, Callable, Awaitable, Dict

BrowserCommandFn = Callable[[str, str, str, Dict[str, Any]], Awaitable[dict]]
