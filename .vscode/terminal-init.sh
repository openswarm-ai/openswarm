# 1. Load your normal shell setup first (brew, nvm, bun, etc.)
[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile"

# 2. Restore the standard macOS prompt (normally set by /etc/bashrc for login shells)
PS1='\h:\W \u\$ '

# 3. Activate the project venv LAST, so it wins the PATH ordering
VENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backend/.venv/bin/activate"
[ -f "$VENV" ] && source "$VENV"