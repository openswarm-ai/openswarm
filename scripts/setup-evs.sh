#!/usr/bin/env bash
# One-time castlabs EVS setup, so a Mac release never stalls on missing Widevine creds again.
#
# EVS signs the packaged app so Widevine DRM works, which is what makes Spotify and Netflix play in
# the embedded browser. scripts/build-app.sh hard-fails without it rather than shipping a build
# whose DRM is quietly dead.
#
# What this does: creates (or reuses) an EVS account, stores the password in your login keychain,
# and drops a loader into your shell profile so every future terminal already has it. Run it once.
#
#   bash scripts/setup-evs.sh
#
# The password is read with `read -s`, never passed as an argument, so it stays out of `ps` and
# your shell history.

set -euo pipefail

KEYCHAIN_SERVICE="openswarm-evs"
VENV="$HOME/.openswarm-evs-venv"
PROFILE="${ZDOTDIR:-$HOME}/.zshrc"

echo "==> castlabs EVS setup"
echo

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "installing the castlabs-evs client into $VENV ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip castlabs-evs
fi
EVS="$VENV/bin/python -m castlabs_evs.account"

read -r -p "EVS account name (an email; use a NEW one if you're creating a fresh account): " ACCOUNT
read -r -s -p "EVS password (pick a strong one; it is never echoed): " PASSWD
echo
echo

echo "1) Do you already have an EVS account with that name?"
echo "   [n] no, create one   [y] yes, I know the password   [r] yes, but reset it"
read -r -p "> " CHOICE

case "$CHOICE" in
  n|N)
    read -r -p "First name: " FIRST
    read -r -p "Last name: " LAST
    read -r -p "Organization: " ORG
    # signup prompts for the emailed code itself, so do NOT ask again afterwards.
    $EVS signup -A "$ACCOUNT" -P "$PASSWD" -E "$ACCOUNT" \
      -F "$FIRST" -L "$LAST" -O "$ORG"
    ;;
  r|R)
    $EVS reset -A "$ACCOUNT"
    read -r -p "Confirmation code from your email: " CODE
    $EVS confirm-reset -A "$ACCOUNT" -C "$CODE" -P "$PASSWD"
    ;;
  *)
    echo "using the existing account as-is"
    ;;
esac

echo
echo "2) proving the credentials actually work ..."
if ! EVS_ACCOUNT_NAME="$ACCOUNT" EVS_PASSWD="$PASSWD" $EVS reauth >/dev/null 2>&1; then
  echo "   FAILED: EVS rejected that account/password pair. Nothing was saved."
  exit 1
fi
echo "   authenticated."

echo
echo "3) storing the password in your login keychain ..."
security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$ACCOUNT" -w "$PASSWD" -U
echo "   stored (service=$KEYCHAIN_SERVICE account=$ACCOUNT)"

MARK="# openswarm: castlabs EVS creds for signed Mac releases"
if ! grep -qF "$MARK" "$PROFILE" 2>/dev/null; then
  echo "4) adding a loader to $PROFILE ..."
  {
    echo ""
    echo "$MARK"
    echo "export EVS_ACCOUNT_NAME='$ACCOUNT'"
    echo "export EVS_PASSWD=\"\$(security find-generic-password -s $KEYCHAIN_SERVICE -a '$ACCOUNT' -w 2>/dev/null)\""
    echo "export APPLE_TEAM_ID=Y26NUZH4NG"
  } >> "$PROFILE"
  echo "   added."
else
  echo "4) $PROFILE already loads them; leaving it alone."
fi

echo
echo "Done. Open a NEW terminal, then:"
echo "  GH_TOKEN=\$(gh auth token) bash publish.sh"
echo
echo "Windows CI keeps its own copy, so if you changed the password, also run:"
echo "  gh secret set EVS_ACCOUNT_NAME --body '$ACCOUNT'"
echo "  gh secret set EVS_PASSWD --body '<the password you just chose>'"
