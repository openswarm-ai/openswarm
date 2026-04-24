import os
import tempfile

# Use temp directory for log mode file to avoid permission issues
LOG_MODE_FILE = os.path.join(tempfile.gettempdir(), 'openswarm_debug_log_mode.txt')
def set_log_mode(mode):
    try:
        with open(LOG_MODE_FILE, 'w') as f:
            f.write(mode)
    except Exception:
        pass  # Ignore write errors

def get_log_mode():
    if os.path.exists(LOG_MODE_FILE):
        with open(LOG_MODE_FILE, 'r') as f:
            return f.read().strip()
    return 'all'  # Default to 'all' if the file doesn't exist
