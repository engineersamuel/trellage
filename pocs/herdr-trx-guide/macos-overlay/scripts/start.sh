#!/bin/bash
set -euo pipefail

APP="$HOME/Applications/TRX Guide Overlay.app"
AGENT="$HOME/Library/LaunchAgents/dev.trellage.trx-guide-overlay.plist"
LABEL="dev.trellage.trx-guide-overlay"

[[ -x "$APP/Contents/MacOS/TRXGuideOverlayApp" ]] || {
  printf 'TRX Guide Overlay is not installed.\n' >&2
  exit 1
}
[[ -f "$AGENT" ]] || {
  printf 'TRX Guide Overlay LaunchAgent is not installed.\n' >&2
  exit 1
}

if ! launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl bootstrap "gui/$UID" "$AGENT"
fi
launchctl kickstart -k "gui/$UID/$LABEL"
