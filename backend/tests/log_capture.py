"""Capture ONE logger's records, regardless of what the rest of the run did to the logging tree.

`caplog` reads the ROOT logger, so it goes blind the moment any other test sets propagate=False on
the logger under test: two assertions here passed in isolation and failed in the full suite while
the line was plainly visible in captured stderr. A logging assertion must not depend on the other
three thousand tests.
"""

import logging
from typing import List


class LogCapture:
    def __init__(self, name: str) -> None:
        self.logger = logging.getLogger(name)
        self.records: List[logging.LogRecord] = []
        self.handler = logging.Handler()
        self.handler.emit = lambda record: self.records.append(record)  # type: ignore[method-assign]

    def __enter__(self) -> "LogCapture":
        self.prev = self.logger.level
        self.logger.setLevel(logging.WARNING)
        self.logger.addHandler(self.handler)
        return self

    def __exit__(self, *exc: object) -> None:
        self.logger.removeHandler(self.handler)
        self.logger.setLevel(self.prev)

    @property
    def text(self) -> str:
        return "\n".join(r.getMessage() for r in self.records)
