from pydantic import BaseModel, Field
from typing import List, Optional, Dict
from typing_extensions import Literal

class OAuthProvider(BaseModel):
    auth_url: str
    token_url: str
    scopes: List[str]
    userinfo_url: Optional[str] = None
    userinfo_field: str
    client_id_env: str
    client_secret_env: str
    token_env_mapping: Dict[str, str]
    extra_auth_params: Dict[str, str] = Field(default_factory=dict)
    revoke_url: Optional[str] = None
    token_response_path: Optional[str] = None
    token_auth_method: Literal["form", "basic", "basic_json"] # newly required 
    pkce_required: bool # newly required 
    env_value_transform: Optional[str] = None
    extra_token_fields: Dict[str, str] = Field(default_factory=dict)
