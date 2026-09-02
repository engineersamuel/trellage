#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/build"
APP="$BUILD_DIR/TRX Guide Overlay.app"
BUNDLE_ID="dev.trellage.trx-guide-overlay"
DESIGNATED_REQUIREMENT="designated => identifier \"$BUNDLE_ID\""

cd "$ROOT"
swift build -c release --product TRXGuideOverlayApp
BIN_DIR="$(swift build -c release --show-bin-path)"

rm -rf -- "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
cp "$BIN_DIR/TRXGuideOverlayApp" "$APP/Contents/MacOS/TRXGuideOverlayApp"
chmod 0755 "$APP/Contents/MacOS/TRXGuideOverlayApp"

plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - \
  --identifier "$BUNDLE_ID" \
  --requirements "=$DESIGNATED_REQUIREMENT" \
  "$APP"
codesign --verify --deep --strict --verbose=1 "$APP"
codesign --verify --strict --test-requirement "=identifier \"$BUNDLE_ID\"" "$APP"

printf 'Built and verified: %s\n' "$APP"
