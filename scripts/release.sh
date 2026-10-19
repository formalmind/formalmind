#!/usr/bin/env bash
# Ships the website and, when its version is new, the Mac app, from this Mac. No keys leave it:
# Cloudflare uses your wrangler login, notarization the `formalmind` notarytool keychain profile,
# the update signature ~/.tauri/formalmind.key. Run by the pre-push hook on pushes to main, or by hand:
#   bun run release            # web, plus desktop if desktop-v<version> isn't released yet
#   bun run release web        # web only
#   bun run release desktop    # desktop only
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TARGET=${1:-all}
REPO=formalmind/formalmind
KEY=~/.tauri/formalmind.key

if [ -n "$(git status --porcelain)" ]; then
  echo "release: commit or stash your changes first; it ships what is committed" >&2
  exit 1
fi

bun install --frozen-lockfile

if [ "$TARGET" != desktop ]; then
  echo "release: deploying the website"
  bun run deploy:cf
fi

[ "$TARGET" = web ] && exit 0

VERSION=$(jq -r .version desktop/src-tauri/tauri.conf.json)
CARGO=$(sed -n 's/^version = "\(.*\)"/\1/p' desktop/src-tauri/Cargo.toml | head -1)
if [ "$VERSION" != "$CARGO" ]; then
  echo "release: tauri.conf.json is $VERSION but Cargo.toml is $CARGO" >&2
  exit 1
fi
TAG="desktop-v$VERSION"
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "release: $TAG is already out; bump the version to ship the app"
  exit 0
fi

echo "release: building $TAG"
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun run desktop:build

BUNDLE=desktop/src-tauri/target/release/bundle
DMG=$(ls -t "$BUNDLE"/dmg/*"$VERSION"*.dmg | head -1)
APP="$BUNDLE/macos/Formal Mind.app"
xcrun notarytool submit "$DMG" --keychain-profile formalmind --wait
xcrun stapler staple "$DMG"
xcrun stapler staple "$APP"

OUT=$(mktemp -d)
cp "$DMG" "$OUT/Formal-Mind-mac.dmg"
tar -czf "$OUT/Formal-Mind-mac.app.tar.gz" -C "$BUNDLE/macos" "Formal Mind.app"
bunx tauri signer sign -f "$KEY" -p "" "$OUT/Formal-Mind-mac.app.tar.gz"
jq -n \
  --arg version "$VERSION" \
  --arg notes "Formal Mind $VERSION" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg signature "$(cat "$OUT/Formal-Mind-mac.app.tar.gz.sig")" \
  --arg url "https://github.com/$REPO/releases/download/$TAG/Formal-Mind-mac.app.tar.gz" \
  '{version: $version, notes: $notes, pub_date: $pub_date,
    platforms: {"darwin-aarch64": {signature: $signature, url: $url}}}' > "$OUT/latest.json"

gh release create "$TAG" -R "$REPO" --title "Formal Mind $VERSION" --notes "Formal Mind $VERSION" \
  --target "$(git rev-parse HEAD)" \
  "$OUT/Formal-Mind-mac.dmg" "$OUT/Formal-Mind-mac.app.tar.gz" "$OUT/latest.json"
rm -rf "$OUT"
echo "release: $TAG published"
