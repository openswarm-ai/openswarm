from typing_extensions import NotRequired
from typing import TypedDict

class BrowserScreenshotInput(TypedDict):
    pass

class BrowserGetTextInput(TypedDict):
    pass

class BrowserNavigateInput(TypedDict):
    url: str

class BrowserClickInput(TypedDict):
    selector: str

class BrowserTypeInput(TypedDict):
    selector: str
    text: str

class BrowserEvaluateInput(TypedDict):
    expression: str

class BrowserGetElementsInput(TypedDict):
    selector: NotRequired[str]

class BrowserScrollInput(TypedDict):
    direction: NotRequired[str]
    amount: NotRequired[float]

class BrowserWaitInput(TypedDict):
    milliseconds: NotRequired[float]
