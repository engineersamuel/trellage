#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SOURCE="$ROOT/build/TRX Guide Overlay.app"
APP_TARGET="$HOME/Applications/TRX Guide Overlay.app"
SUPPORT="$HOME/Library/Application Support/Trellage/TRX Guide Overlay"
CONFIG="$SUPPORT/config.json"
AGENT="$HOME/Library/LaunchAgents/dev.trellage.trx-guide-overlay.plist"
LABEL="dev.trellage.trx-guide-overlay"
SESSION=""

if [[ "${1:-}" == "--session" ]]; then
  SESSION="${2:-}"
  [[ "$SESSION" =~ ^[A-Za-z0-9._-]+$ ]] || {
    printf 'Invalid Herdr session name.\n' >&2
    exit 2
  }
  shift 2
fi
[[ "$#" -eq 0 ]] || {
  printf 'Usage: %s [--session NAME]\n' "$0" >&2
  exit 2
}

HERDR_COMMAND="$(command -v herdr || true)"
[[ -n "$HERDR_COMMAND" ]] || {
  printf 'herdr is not on PATH.\n' >&2
  exit 1
}
HERDR_DIRECTORY="$(cd "$(dirname "$HERDR_COMMAND")" && pwd -P)"
HERDR_BINARY="$HERDR_DIRECTORY/$(basename "$HERDR_COMMAND")"
[[ "$HERDR_BINARY" == /* && -x "$HERDR_BINARY" ]] || {
  printf 'Could not resolve an absolute Herdr binary.\n' >&2
  exit 1
}

"$ROOT/scripts/build.sh"
"$ROOT/scripts/stop.sh"

mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents" "$SUPPORT"
chmod 0700 "$SUPPORT"
rm -rf -- "$APP_TARGET"
/usr/bin/ditto "$APP_SOURCE" "$APP_TARGET"

rm -f -- "$CONFIG"
CONFIG_TEMP="$SUPPORT/.config.json.$$.tmp"
trap 'rm -f -- "$CONFIG_TEMP"' EXIT
node -e '
  const fs = require("node:fs")
  const [target, herdrBinary, session] = process.argv.slice(1)
  const config = { herdrBinary, ...(session.length === 0 ? {} : { session }) }
  fs.writeFileSync(target, `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 })
' "$CONFIG_TEMP" "$HERDR_BINARY" "$SESSION"
mv -f -- "$CONFIG_TEMP" "$CONFIG"
chmod 0600 "$CONFIG"
trap - EXIT

rm -f -- "$AGENT"
plutil -create xml1 "$AGENT"
plutil -insert Label -string "$LABEL" "$AGENT"
plutil -insert ProgramArguments -array "$AGENT"
plutil -insert ProgramArguments.0 -string \
  "$APP_TARGET/Contents/MacOS/TRXGuideOverlayApp" "$AGENT"
plutil -insert RunAtLoad -bool true "$AGENT"
plutil -insert ProcessType -string Interactive "$AGENT"
chmod 0600 "$AGENT"

launchctl bootstrap "gui/$UID" "$AGENT"
printf 'Installed: %s\n' "$APP_TARGET"
printf 'Herdr: %s\n' "$HERDR_BINARY"
