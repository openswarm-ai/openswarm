import os

# LOG_MODE_FILE = 'debugger/log_mode.txt'
LOG_MODE_FILE = os.path.join(os.path.dirname(__file__), 'log_mode.txt')
def set_log_mode(mode):
    with open(LOG_MODE_FILE, 'w') as f:
        f.write(mode)

def get_log_mode():
    if os.path.exists(LOG_MODE_FILE):
        with open(LOG_MODE_FILE, 'r') as f:
            return f.read().strip()
    return 'all'  # Default to 'all' if the file doesn't exist
