#!/bin/bash
# Installs the Safari bridge from a release download.
#
#   bash mac/install.sh
#
# Copies the helper to ~/.bookmark-sync/app, writes config.json if missing,
# and installs the launchd agent with real absolute paths (launchd does not
# expand ~ or read your shell PATH).

set -euo pipefail

NODE="$(command -v node)" || { echo "Node.js is required: https://nodejs.org" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.bookmark-sync"
APP="$STATE/app"
AGENT="$HOME/Library/LaunchAgents/com.bookmarksync.safari.plist"

mkdir -p "$APP"
rm -rf "$APP/mac" "$APP/src"
cp -R "$ROOT/mac" "$ROOT/src" "$APP/"

if [ ! -f "$STATE/config.json" ]; then
  read -r -p "GitHub owner: " OWNER
  read -r -p "Bookmarks repo name: " REPO
  read -r -s -p "Fine-grained token: " TOKEN; echo
  umask 077
  printf '{ "token": "%s", "owner": "%s", "repo": "%s" }\n' "$TOKEN" "$OWNER" "$REPO" > "$STATE/config.json"
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#/usr/local/bin/node#$NODE#" \
    -e "s#/Users/CHANGEME/bookmark-sync/mac/safari-sync.mjs#$APP/mac/safari-sync.mjs#" \
    "$APP/mac/com.bookmarksync.safari.plist" > "$AGENT"

cat <<EOF

Installed to $APP

Next:
  1. System Settings > Privacy & Security > Full Disk Access: add
       $NODE
     (press Cmd+Shift+G in the file picker to type the path)
  2. Check what it would do:
       "$NODE" "$APP/mac/safari-sync.mjs" --dry-run
  3. Quit Safari, then start the agent:
       launchctl load "$AGENT"
EOF
