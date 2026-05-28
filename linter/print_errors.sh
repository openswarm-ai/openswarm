#!/bin/bash
# Print lint violations to stdout with colored formatting.
# Usage: bash linter/print_errors.sh [ROOT_DIR]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${1:-$(dirname "$SCRIPT_DIR")}"

YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
RESET='\033[0m'

LINT_OUTPUT=$(python3 "$SCRIPT_DIR/lint.py" --root "$ROOT_DIR" 2>&1)
LINT_EXIT=$?

if [ $LINT_EXIT -ne 0 ]; then
    STRUCT_LINES=$(echo "$LINT_OUTPUT" | grep -v "^structural:" | grep -v "^vulture:" | grep -v "^eslint:" | grep -v "^knip:" | grep -v '\[vulture\]' | grep -v '\[eslint\]' | grep -v '\[knip\]')
    VULTURE_LINES=$(echo "$LINT_OUTPUT" | grep '\[vulture\]')
    ESLINT_LINES=$(echo "$LINT_OUTPUT" | grep '\[eslint\]')
    KNIP_LINES=$(echo "$LINT_OUTPUT" | grep '\[knip\]')

    STRUCT_COUNT=$(echo "$STRUCT_LINES" | grep -cE ':\s+(error|warning):\s+')
    VULTURE_COUNT=$(echo "$VULTURE_LINES" | grep -cE ':\s+(error|warning):\s+')
    ESLINT_COUNT=$(echo "$ESLINT_LINES" | grep -cE ':\s+(error|warning):\s+')
    KNIP_COUNT=$(echo "$KNIP_LINES" | grep -cE ':\s+(error|warning):\s+')

    if [ "$STRUCT_COUNT" -gt 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[structural] Violations found:${RESET}"
        echo "$STRUCT_LINES" | while IFS= read -r line; do
            [ -n "$line" ] && echo -e "${YELLOW}  $line${RESET}"
        done
        echo -e "${YELLOW}${BOLD}  ${STRUCT_COUNT} violation(s) — fix or add exceptions in linter/config/config.json${RESET}"
    fi

    if [ "$VULTURE_COUNT" -gt 0 ]; then
        echo ""
        echo -e "${CYAN}${BOLD}[vulture] Dead code found:${RESET}"
        echo "$VULTURE_LINES" | while IFS= read -r line; do
            [ -n "$line" ] && echo -e "${CYAN}  $line${RESET}"
        done
        echo -e "${CYAN}${BOLD}  ${VULTURE_COUNT} finding(s) — fix or add to linter/config/vulture_whitelist.py${RESET}"
    fi

    if [ "$ESLINT_COUNT" -gt 0 ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}[eslint] Lint errors found:${RESET}"
        echo "$ESLINT_LINES" | while IFS= read -r line; do
            [ -n "$line" ] && echo -e "${YELLOW}  $line${RESET}"
        done
        echo -e "${YELLOW}${BOLD}  ${ESLINT_COUNT} error(s) — fix or disable rules in frontend/eslint.config.mjs${RESET}"
    fi

    if [ "$KNIP_COUNT" -gt 0 ]; then
        echo ""
        echo -e "${CYAN}${BOLD}[knip] Unused code/dependencies found:${RESET}"
        echo "$KNIP_LINES" | while IFS= read -r line; do
            [ -n "$line" ] && echo -e "${CYAN}  $line${RESET}"
        done
        echo -e "${CYAN}${BOLD}  ${KNIP_COUNT} finding(s) — remove unused code or update frontend/knip.json${RESET}"
    fi

    echo ""
fi
