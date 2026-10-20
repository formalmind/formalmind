#!/bin/sh
# The Neovim the app ships (Vim mode in the Code tab runs it): the official macOS build, pinned and checked, unpacked
# into src-tauri/nvim (bundled as Resources/nvim, gitignored). With the Developer ID in the keychain, every Mach-O in
# it is signed with the hardened runtime so the app notarizes; LuaJIT needs the JIT entitlements.
set -eu
cd "$(dirname "$0")/.."

VERSION=v0.12.2
SHA256=eeddee1009734f9071266e6b1b8a70308cb60cbcc45f5e1c1023adc471450fee
URL="https://github.com/neovim/neovim/releases/download/$VERSION/nvim-macos-arm64.tar.gz"
OUT=src-tauri/nvim
IDENTITY="Developer ID Application: Asyncswap Labs, Inc. (WA3Q5YSLK6)"

if [ "$(cat "$OUT/.version" 2>/dev/null)" != "$VERSION" ]; then
  tmp=$(mktemp -d)
  echo "nvim: fetching $VERSION"
  curl -fsSL -o "$tmp/nvim.tar.gz" "$URL"
  got=$(shasum -a 256 "$tmp/nvim.tar.gz" | cut -d' ' -f1)
  if [ "$got" != "$SHA256" ]; then
    echo "nvim: checksum mismatch ($got)" >&2
    exit 1
  fi
  tar -xzf "$tmp/nvim.tar.gz" -C "$tmp"
  rm -rf "$OUT"
  mv "$tmp/nvim-macos-arm64" "$OUT"
  rm -rf "$tmp"
  echo "$VERSION" > "$OUT/.version"
fi

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY" && [ ! -f "$OUT/.signed" ]; then
  echo "nvim: signing"
  find "$OUT" -type f \( -name "*.so" -o -name "*.dylib" \) -exec codesign --force --timestamp --options runtime --sign "$IDENTITY" {} \;
  codesign --force --timestamp --options runtime --entitlements scripts/nvim.entitlements --sign "$IDENTITY" "$OUT/bin/nvim"
  touch "$OUT/.signed"
fi
