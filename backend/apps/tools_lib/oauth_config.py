import os

from dotenv import load_dotenv

from backend.config.paths import BACKEND_DIR, DATA_ROOT

# Loaded here (the leaf) so OPENSWARM_OAUTH_BASE_URL is set before any module
# that reads it imports this. Both tools_lib.py and oauth_tokens.py pull from here.
load_dotenv(os.path.join(BACKEND_DIR, ".env"))
if os.environ.get("OPENSWARM_PACKAGED") == "1":
    load_dotenv(os.path.join(os.path.dirname(DATA_ROOT), ".env"), override=True)

# Base URL for the OAuth helper service. Override via env in dev if needed.
OPENSWARM_OAUTH_BASE_URL = os.environ.get(
    "OPENSWARM_OAUTH_BASE_URL", "https://api.openswarm.com"
).rstrip("/")
