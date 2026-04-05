

from typing import Any, List
from typeguard import typechecked

@typechecked
def assert_exactly_one_optional(args: List[Any]) -> None:
    count = sum(1 for arg in args if arg is not None)
    if count != 1:
        raise ValueError(f"Exactly one argument must be provided, got {count}")