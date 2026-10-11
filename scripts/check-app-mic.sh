#!/usr/bin/env bash
#
# Check that a built Caprock.app may ask for the microphone (ADR-045): the
# app and its daemon sidecars are signed with the hardened runtime, which
# refuses the microphone without a prompt to a program lacking
# com.apple.security.device.audio-input, and the app's Info.plist says why
# it asks. Reads the bundle only; records nothing and raises no dialog.
#
#   scripts/check-app-mic.sh path/to/Caprock.app
#
set -euo pipefail

die() { echo "check-app-mic: $*" >&2; exit 1; }

APP="${1:-}"
[[ -d "$APP" ]] || die "usage: scripts/check-app-mic.sh path/to/Caprock.app"

for bin in caprock-app caprock caprock-pty-host; do
  exe="$APP/Contents/MacOS/$bin"
  [[ -f "$exe" ]] || die "no $bin in $APP"
  ents="$(codesign -d --entitlements - --xml "$exe" 2>/dev/null || true)"
  [[ "$ents" == *"com.apple.security.device.audio-input"* ]] ||
    die "$bin is not signed with com.apple.security.device.audio-input"
done

why="$(/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$APP/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$why" ]] || die "Info.plist has no NSMicrophoneUsageDescription"

echo "  ok: microphone entitlement on caprock-app, caprock and caprock-pty-host, usage string present"
