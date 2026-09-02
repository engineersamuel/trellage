#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HOME/Applications/TRX Guide Overlay.app"
SUPPORT="$HOME/Library/Application Support/Trellage/TRX Guide Overlay"
AGENT="$HOME/Library/LaunchAgents/dev.trellage.trx-guide-overlay.plist"

"$ROOT/scripts/stop.sh"
rm -f -- "$AGENT"
rm -rf -- "$APP"
rm -rf -- "$SUPPORT"
printf 'Removed TRX Guide Overlay files.\n'
