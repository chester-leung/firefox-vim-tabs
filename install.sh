#!/usr/bin/env bash
# Installs the fx-autoconfig loader and vim-tabs.uc.js.
#
#   ./install.sh                 # every profile in profiles.ini
#   ./install.sh <profile-dir>   # just these profile directories
#
# Re-run after every Firefox update: updates replace Firefox.app, which removes
# the loader's two files from Contents/Resources. The profile side survives.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="${FIREFOX_APP:-/Applications/Firefox.app}"
RES="$APP/Contents/Resources"
FF_DIR="$HOME/Library/Application Support/Firefox"
VENDOR="$ROOT/vendor/fx-autoconfig"

[[ -d "$RES" ]] || { echo "Firefox not found at $APP (set FIREFOX_APP)" >&2; exit 1; }

# 1. Program side: tells Firefox to run the loader at startup.
cp "$VENDOR/program/config.js" "$RES/config.js"
mkdir -p "$RES/defaults/pref"
cp "$VENDOR/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"
echo "loader installed into $APP"

# 2. Profile side: the loader itself plus a symlink to the script, so edits to
#    this repo take effect on the next restart.
if [[ $# -gt 0 ]]; then
  profiles=("$@")
else
  profiles=()
  while IFS= read -r p; do
    [[ "$p" = /* ]] && profiles+=("$p") || profiles+=("$FF_DIR/$p")
  done < <(sed -n 's/^Path=//p' "$FF_DIR/profiles.ini")
fi

firefox_running=false
pgrep -qf "$APP/Contents/MacOS/firefox" && firefox_running=true

for profile in "${profiles[@]}"; do
  [[ -d "$profile" ]] || { echo "skipping missing profile $profile" >&2; continue; }
  mkdir -p "$profile/chrome/JS"
  rm -rf "$profile/chrome/utils"
  cp -R "$VENDOR/profile/chrome/utils" "$profile/chrome/utils"
  ln -sfn "$ROOT/chrome/JS/vim-tabs.uc.js" "$profile/chrome/JS/vim-tabs.uc.js"
  echo "installed into profile $(basename "$profile")"

  if ! $firefox_running; then
    rm -rf "$HOME/Library/Caches/Firefox/Profiles/$(basename "$profile")/startupCache"
  fi
done

if $firefox_running; then
  echo
  echo "Firefox is running. To load the script: about:support -> 'Clear startup cache...'"
  echo "(that restarts Firefox), or quit Firefox and re-run this script."
fi
