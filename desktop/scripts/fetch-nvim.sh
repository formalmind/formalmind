#!/bin/sh
# The Neovim the app ships (Vim mode in the Code tab runs it): the official build, pinned and checked, unpacked into
# src-tauri/nvim (bundled as Resources/nvim, gitignored).
#  - macOS: the arm64 and x86_64 builds merged into universal binaries (lipo), so one app runs on Apple Silicon and
#    Intel. With the Developer ID in the keychain, every Mach-O in it is signed with the hardened runtime so the app
#    notarizes; LuaJIT needs the JIT entitlements.
#  - Windows (Git Bash, as on the CI runner): the win64 build.
set -eu
cd "$(dirname "$0")/.."

VERSION=v0.12.2
BASE="https://github.com/neovim/neovim/releases/download/$VERSION"
ARM64_SHA=eeddee1009734f9071266e6b1b8a70308cb60cbcc45f5e1c1023adc471450fee
X86_64_SHA=728321db960a9b6af6c03881892a6abfd743bf759bc62d233f52fa1be64ace3c
WIN64_SHA=23fe150edbcc976eabe55092e1e9d2e5e237afde69553d170e936f776b405d53
OUT=src-tauri/nvim
IDENTITY="Developer ID Application: Asyncswap Labs, Inc. (WA3Q5YSLK6)"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) PLATFORM=windows ;;
  *) PLATFORM=macos ;;
esac
STAMP="$VERSION-$PLATFORM"

sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

# fetch <file> <sha256> <into>: downloads a release file and checks it.
fetch() {
  curl -fsSL -o "$3" "$BASE/$1"
  got=$(sha "$3")
  if [ "$got" != "$2" ]; then
    echo "nvim: checksum mismatch for $1 ($got)" >&2
    exit 1
  fi
}

if [ "$(cat "$OUT/.version" 2>/dev/null)" != "$STAMP" ]; then
  tmp=$(mktemp -d)
  echo "nvim: fetching $VERSION for $PLATFORM"
  rm -rf "$OUT"
  if [ "$PLATFORM" = windows ]; then
    fetch nvim-win64.zip "$WIN64_SHA" "$tmp/nvim.zip"
    unzip -q "$tmp/nvim.zip" -d "$tmp"
    mv "$tmp/nvim-win64" "$OUT"
  else
    fetch nvim-macos-arm64.tar.gz "$ARM64_SHA" "$tmp/arm64.tar.gz"
    fetch nvim-macos-x86_64.tar.gz "$X86_64_SHA" "$tmp/x86_64.tar.gz"
    tar -xzf "$tmp/arm64.tar.gz" -C "$tmp"
    tar -xzf "$tmp/x86_64.tar.gz" -C "$tmp"
    # The arm64 tree, with each Mach-O made universal from its x86_64 twin.
    (cd "$tmp/nvim-macos-arm64" && find . -type f) | while read -r f; do
      a="$tmp/nvim-macos-arm64/$f"
      x="$tmp/nvim-macos-x86_64/$f"
      if [ -f "$x" ] && file "$a" | grep -q "Mach-O"; then
        lipo -create "$a" "$x" -output "$a.universal" && mv "$a.universal" "$a"
      fi
    done
    mv "$tmp/nvim-macos-arm64" "$OUT"
  fi
  rm -rf "$tmp"
  echo "$STAMP" > "$OUT/.version"
fi

if [ "$PLATFORM" = macos ] && security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY" && [ ! -f "$OUT/.signed" ]; then
  echo "nvim: signing"
  find "$OUT" -type f \( -name "*.so" -o -name "*.dylib" \) -exec codesign --force --timestamp --options runtime --sign "$IDENTITY" {} \;
  codesign --force --timestamp --options runtime --entitlements scripts/nvim.entitlements --sign "$IDENTITY" "$OUT/bin/nvim"
  touch "$OUT/.signed"
fi
