#!/bin/sh
# `cargo run` (tauri dev) launches the app through this: it signs the dev binary with the Developer ID and the
# release app's identifier first, so macOS sees every build as the same app and keychain "Always Allow" sticks
# (an ad-hoc signed build is a new program each time, so the keychain asks again). Without the identity it just runs.
IDENTITY="Developer ID Application: Asyncswap Labs, Inc. (WA3Q5YSLK6)"
if [ "$(uname)" = Darwin ] && security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" --identifier team.formal.desktop --timestamp=none "$1" 2>/dev/null || true
fi
exec "$@"
