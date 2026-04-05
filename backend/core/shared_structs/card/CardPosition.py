from pydantic import BaseModel


class CardPosition(BaseModel):
    id: str
    x: float = 0
    y: float = 0
    width: float = 420
    height: float = 280