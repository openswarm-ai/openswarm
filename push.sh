#!/usr/bin/env bash
set -euo pipefail

# --- Args ---
if [ $# -ne 2 ]; then
  echo -e "\033[1;31mError: exactly 2 arguments required\033[0m"
  echo -e "\033[0;90mUsage: bash push.sh Name \"commit message\"\033[0m"
  exit 1
fi

NAME="$1"
MESSAGE="$2"

# --- Helpers ---
banner() {
  local msg="$1"
  local len=${#msg}
  local border=$(printf '═%.0s' $(seq 1 $((len + 4))))
  echo ""
  echo -e "\033[1;36m╔${border}╗\033[0m"
  echo -e "\033[1;36m║  \033[1;33m${msg}\033[1;36m  ║\033[0m"
  echo -e "\033[1;36m╚${border}╝\033[0m"
  echo ""
}

gate() {
  local prompt="${1:?gate requires a prompt argument}"
  while true; do
    read -rp $'\033[1;35m► '"${prompt}"$' [Y/n] \033[0m' yn
    case "${yn:-Y}" in
      [Yy]*) return 0 ;;
      [Nn]*) echo -e "\033[1;31m✗ Aborted.\033[0m"; exit 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

# --- Workflow ---
banner "git status"
git status
gate "Stage all changes?"

banner "git add ."
git add .
git status
gate "Commit these changes?"

banner "git commit -m \"[${NAME}]: ${MESSAGE}\""
git commit -m "[${NAME}]: ${MESSAGE}"
gate "Push to remote?"

banner "git push"
git push

banner "All changes pushed successfully ✓"